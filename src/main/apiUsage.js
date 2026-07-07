import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'

// Token/cost ledger for the direct Anthropic API engine, in its OWN database (api-usage.db) so it
// never bloats the notes/PDF DBs. EVERY API call records one row: exact input / output / cache
// tokens (as the API reports them), the computed USD cost, the channel it came from (chat / telegram
// / mail / pdf …), and OPTIONALLY the full request+response text (off by default). The Settings
// report reads it back grouped by day and hour so real spend is traceable over time.

let db = null

export function initApiUsage() {
  db = new Database(join(app.getPath('userData'), 'api-usage.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,   -- epoch ms
      engine   TEXT,               -- 'anthropic'
      model    TEXT,
      channel  TEXT,               -- chat | telegram | mail | pdf | task | raw …
      in_tok   INTEGER DEFAULT 0,  -- input tokens (billed, excludes cache read)
      out_tok  INTEGER DEFAULT 0,  -- output tokens
      cw_tok   INTEGER DEFAULT 0,  -- cache-CREATION (write) tokens
      cr_tok   INTEGER DEFAULT 0,  -- cache-READ tokens
      cost     REAL DEFAULT 0,     -- USD, computed from the pricing table at call time
      req      TEXT,               -- full request text (only when apiLogText is on)
      resp     TEXT                -- full response text (only when apiLogText is on)
    );
    CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
  `)
}

// one call → one row. Tokens/cost are pre-computed by the caller (it holds the pricing table).
export function recordUsage(row) {
  if (!db) return
  try {
    db.prepare(`INSERT INTO usage (ts, engine, model, channel, in_tok, out_tok, cw_tok, cr_tok, cost, req, resp)
                VALUES (@ts, @engine, @model, @channel, @in_tok, @out_tok, @cw_tok, @cr_tok, @cost, @req, @resp)`)
      .run({
        ts: row.ts || Date.now(),
        engine: row.engine || 'anthropic',
        model: row.model || '',
        channel: row.channel || 'chat',
        in_tok: row.in_tok || 0,
        out_tok: row.out_tok || 0,
        cw_tok: row.cw_tok || 0,
        cr_tok: row.cr_tok || 0,
        cost: row.cost || 0,
        req: row.req ?? null,
        resp: row.resp ?? null
      })
  } catch (e) { console.error('[api-usage] record failed:', e?.message) }
}

// local-day / local-hour bucket keys — SQLite's date funcs are UTC, so bucket in JS from the ms ts
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const hourKey = (ts) => `${dayKey(ts)} ${String(new Date(ts).getHours()).padStart(2, '0')}:00`

// Aggregated report for the Settings screen. `days` limits the window (default 90); `logLimit` caps
// the raw recent rows returned. Everything summed in ONE pass over the window.
export function usageReport({ days = 90, logLimit = 200 } = {}) {
  if (!db) return null
  const since = Date.now() - days * 86400000
  const rows = db.prepare('SELECT ts, model, channel, in_tok, out_tok, cw_tok, cr_tok, cost FROM usage WHERE ts >= ? ORDER BY ts').all(since)
  const blank = () => ({ calls: 0, in_tok: 0, out_tok: 0, cw_tok: 0, cr_tok: 0, cost: 0 })
  const add = (b, r) => { b.calls++; b.in_tok += r.in_tok; b.out_tok += r.out_tok; b.cw_tok += r.cw_tok; b.cr_tok += r.cr_tok; b.cost += r.cost }
  const total = blank(), byDay = new Map(), byHour = new Map(), byModel = new Map(), byChannel = new Map()
  for (const r of rows) {
    add(total, r)
    const dk = dayKey(r.ts); if (!byDay.has(dk)) byDay.set(dk, blank()); add(byDay.get(dk), r)
    const hk = hourKey(r.ts); if (!byHour.has(hk)) byHour.set(hk, blank()); add(byHour.get(hk), r)
    const mk = r.model || '?'; if (!byModel.has(mk)) byModel.set(mk, blank()); add(byModel.get(mk), r)
    const ck = r.channel || '?'; if (!byChannel.has(ck)) byChannel.set(ck, blank()); add(byChannel.get(ck), r)
  }
  const list = (map, keyName) => [...map.entries()].map(([k, v]) => ({ [keyName]: k, ...v }))
  const recent = db.prepare('SELECT id, ts, model, channel, in_tok, out_tok, cw_tok, cr_tok, cost FROM usage WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(since, logLimit)
  return {
    total,
    byDay: list(byDay, 'day').sort((a, b) => b.day.localeCompare(a.day)),
    byHour: list(byHour, 'hour').sort((a, b) => b.hour.localeCompare(a.hour)).slice(0, 48),
    byModel: list(byModel, 'model').sort((a, b) => b.cost - a.cost),
    byChannel: list(byChannel, 'channel').sort((a, b) => b.cost - a.cost),
    recent
  }
}

// wipe the ledger (a Settings button) — starting a fresh measurement period
export function clearUsage() {
  if (!db) return
  try { db.prepare('DELETE FROM usage').run() } catch {}
}
