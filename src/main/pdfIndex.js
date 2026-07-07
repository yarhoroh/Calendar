import Database from 'better-sqlite3'
import { app } from 'electron'
import { join, resolve, basename } from 'node:path'
import { statSync, readdirSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import os from 'node:os'

// Full-text index of the PDF library, in its OWN database (pdf-index.db), separate from the notes
// DB and the virtual-tree JSON. Keyed by the file's normalized absolute path, so the SAME physical
// file linked from several folders is indexed ONCE. Text is stored per page (doc_fts) — that also
// leaves a clean seam for future semantic search: add an `embeddings(key, page, vec BLOB)` table
// and fill it from this same extracted text, no re-parse needed.
//
// Extraction runs in a POOL of worker_threads (one mupdf per core) so a big library indexes fast
// without touching the main thread; the DB stays single-owner (all writes happen here in main).

let db = null
let notify = null // () => void — pings the renderer that some statuses changed (debounced there)
const queue = [] // { key, path } awaiting extraction (FIFO)
const queued = new Set() // keys already in the queue (dedup)
let jobSeq = 0

const isPdf = (n) => /\.pdf$/i.test(n)
const MAX_BYTES = 200 * 1024 * 1024 // skip absurdly large files
// dedup key: resolve (.., slashes) + case-fold on Windows (its FS is case-insensitive)
const norm = (p) => {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}
const safeStat = (p) => { try { return statSync(p) } catch { return null } }

// absolute path to mupdf's ESM entry — the eval-worker imports it directly (no bundling of a
// separate worker file needed, and no cwd-relative resolution surprises in a packaged app)
function mupdfEntry() {
  try { return require.resolve('mupdf') } catch {}
  try { return join(app.getAppPath(), 'node_modules', 'mupdf', 'dist', 'mupdf.js') } catch {}
  return 'mupdf'
}

// The worker: receives a file path, returns [{page, text}] extracted with mupdf. Self-contained
// source string spawned with { eval: true } — nothing extra to emit at build time.
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
;(async () => {
  let mupdf
  try { mupdf = await import(pathToFileURL(workerData.mupdfPath).href) }
  catch (e) { parentPort.postMessage({ type: 'fatal', error: String((e && e.message) || e) }); return }
  const run = (path) => {
    let doc = null
    try {
      doc = mupdf.Document.openDocument(new Uint8Array(fs.readFileSync(path)), 'application/pdf')
      const n = doc.countPages()
      const rows = []
      for (let i = 0; i < n; i++) {
        let text = '', pg = null, stx = null
        try { pg = doc.loadPage(i); stx = pg.toStructuredText('preserve-whitespace,dehyphenate'); text = stx.asText() } catch (_) {}
        try { stx && stx.destroy() } catch (_) {}
        try { pg && pg.destroy() } catch (_) {}
        if (text && text.trim()) rows.push({ page: i + 1, text })
      }
      return { ok: true, pages: n, rows }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    } finally { try { doc && doc.destroy() } catch (_) {} }
  }
  parentPort.on('message', (m) => {
    if (m.type === 'job') parentPort.postMessage({ type: 'done', id: m.id, key: m.key, path: m.path, result: run(m.path) })
  })
  parentPort.postMessage({ type: 'ready' })
})()
`

const POOL_SIZE = Math.max(1, Math.min(4, (os.cpus()?.length || 2) - 1))
const JOB_TIMEOUT = 120000 // a single file stuck longer than this → the worker is hung (corrupt PDF)
let pool = [] // [{ worker, ready, busy, job, timer }]
let teardownTimer = null

export function initPdfIndex(notifyFn) {
  notify = notifyFn
  db = new Database(join(app.getPath('userData'), 'pdf-index.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      key        TEXT PRIMARY KEY,   -- normalized path (the dedup key)
      path       TEXT NOT NULL,      -- full path as last seen (display / open)
      mtime      REAL,               -- mtimeMs when indexed (re-index when it drifts)
      size       INTEGER,
      pages      INTEGER,
      status     TEXT,               -- pending | indexing | done | error
      error      TEXT,
      reachable  INTEGER DEFAULT 0,  -- 1 = currently reachable from the tree (search scope)
      indexed_at REAL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
      text, key UNINDEXED, page UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS variables (
      key     TEXT PRIMARY KEY,   -- normalized path (same key as docs)
      path    TEXT NOT NULL,
      json    TEXT,               -- the variable definitions (mirror of the PDF catalog)
      count   INTEGER DEFAULT 0,  -- how many variables (for the tree badge)
      updated REAL
    );
  `)
  try { db.prepare("UPDATE docs SET status='pending' WHERE status='indexing'").run() } catch {}
}

// ---- reachable set: every PDF the tree can currently see (dedup by normalized path) ----
// linkFile → its path; linkFolder → EVERY pdf under it recursively (indexing ignores display mode).
function reachablePaths(tree) {
  const out = new Map() // key → full path
  const add = (p) => { const k = norm(p); if (!out.has(k)) out.set(k, p) }
  const walkDisk = (dir, depth) => {
    if (depth > 24 || out.size > 20000) return
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walkDisk(p, depth + 1)
      else if (isPdf(e.name)) add(p)
    }
  }
  const walkTree = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'linkFile' && n.path) add(n.path)
      else if (n.type === 'linkFolder' && n.path) walkDisk(n.path, 0)
      if (n.children) walkTree(n.children)
    }
  }
  walkTree(tree?.roots || [])
  return out
}

function enqueue(key, path) {
  if (queued.has(key)) return
  queued.add(key)
  queue.push({ key, path })
}
function removeDoc(key) {
  const i = queue.findIndex((j) => j.key === key) // drop it from the queue if it was waiting
  if (i >= 0) queue.splice(i, 1)
  queued.delete(key)
  // if a worker is indexing THIS file right now (its folder was just unlinked/excluded), abort it —
  // terminate the worker so it stops immediately instead of finishing wasted work; the pool respawns
  const rec = pool.find((w) => w.busy && w.job && w.job.key === key)
  if (rec) { clearTimeout(rec.timer); try { rec.worker.terminate() } catch {}; pool = pool.filter((w) => w !== rec) }
  db.prepare('DELETE FROM doc_fts WHERE key=?').run(key)
  db.prepare('DELETE FROM docs WHERE key=?').run(key)
}

// Reconcile the DB with the tree: enqueue new / changed / pending docs, mark reachability, prune
// docs whose file is gone AND that nothing links to anymore. Safe to call often (watch, set-tree).
export function syncIndex(getTree) {
  if (!db) return { reachable: 0, queued: 0 }
  const reach = reachablePaths(getTree())
  const rows = new Map(db.prepare('SELECT key, mtime, size, status FROM docs').all().map((r) => [r.key, r]))
  db.prepare('UPDATE docs SET reachable=0').run()
  const setReach = db.prepare('UPDATE docs SET reachable=1, path=? WHERE key=?')
  let added = 0
  for (const [key, path] of reach) {
    const st = safeStat(path)
    if (!st || st.size > MAX_BYTES) continue
    const row = rows.get(key)
    // 'indexing' counts as changed too: if a doc is somehow still 'indexing' when we sync (a crash
    // left it mid-flight and the startup reset missed it), re-queue it from scratch rather than
    // trusting a half-done state — the result is only ever committed atomically on completion.
    const changed = !row || row.status === 'pending' || row.status === 'error' || row.status === 'indexing' ||
      Math.abs((row.mtime || 0) - st.mtimeMs) > 1 || (row.size || 0) !== st.size
    if (changed) {
      db.prepare(`INSERT INTO docs (key, path, status, reachable) VALUES (?, ?, 'pending', 1)
                  ON CONFLICT(key) DO UPDATE SET path=excluded.path, status='pending', reachable=1`).run(key, path)
      enqueue(key, path)
      added++
    } else setReach.run(path, key)
  }
  // purge everything no longer reachable from the tree: the index mirrors the current tree exactly
  // (unlink a file/folder → its text is removed; re-adding re-indexes it from scratch)
  for (const r of db.prepare('SELECT key FROM docs WHERE reachable=0').all()) removeDoc(r.key)
  notify?.()
  pump()
  return { reachable: reach.size, queued: added }
}

// Startup safety net: re-check the mtime/size of EVERY file recorded in the DB (not just the ones
// currently reachable from the tree). Any that changed on disk while the app was closed — or that
// were left mid-index — get re-queued, so a file edited by another program is caught on next launch.
export function verifyDb() {
  if (!db) return { checked: 0, requeued: 0 }
  const rows = db.prepare('SELECT key, path, mtime, size, status FROM docs').all()
  let requeued = 0
  for (const r of rows) {
    const st = safeStat(r.path)
    if (!st) continue // gone → syncIndex prunes it if it's also unlinked
    const stale = r.status === 'pending' || r.status === 'indexing' ||
      Math.abs((r.mtime || 0) - st.mtimeMs) > 1 || (r.size || 0) !== st.size
    if (stale) {
      db.prepare("UPDATE docs SET status='pending' WHERE key=?").run(r.key)
      enqueue(r.key, r.path)
      requeued++
    }
  }
  if (requeued) { notify?.(); pump() }
  return { checked: rows.length, requeued }
}

// Force one file back into the queue (used right after the editor saves it).
export function reindexPath(path) {
  if (!db) return
  const st = safeStat(path)
  if (!st) return
  const key = norm(path)
  db.prepare(`INSERT INTO docs (key, path, status, reachable) VALUES (?, ?, 'pending', 1)
              ON CONFLICT(key) DO UPDATE SET path=excluded.path, status='pending'`).run(key, path)
  enqueue(key, path)
  notify?.()
  pump()
}

// ---- worker pool ----
function spawnWorker() {
  const rec = { worker: null, ready: false, busy: false, job: null, timer: null }
  try {
    rec.worker = new Worker(WORKER_SRC, { eval: true, workerData: { mupdfPath: mupdfEntry() } })
    rec.worker.unref() // a pending index job must NEVER keep the app alive (it would block quit/update)
  } catch {
    return null
  }
  rec.worker.on('message', (m) => {
    if (m.type === 'ready') { rec.ready = true; dispatch(); return }
    if (m.type === 'fatal') { clearTimeout(rec.timer); try { rec.worker.terminate() } catch {}; pool = pool.filter((w) => w !== rec); return }
    if (m.type === 'done') {
      clearTimeout(rec.timer)
      rec.busy = false; rec.job = null
      try { writeResult(m.key, m.path, m.result) } catch {}
      dispatch()
    }
  })
  rec.worker.on('error', () => {
    clearTimeout(rec.timer)
    if (rec.job) { try { db.prepare('UPDATE docs SET status=?, error=? WHERE key=?').run('error', 'worker crashed', rec.job.key) } catch {}; notify?.() }
    pool = pool.filter((w) => w !== rec)
    pump()
  })
  rec.worker.on('exit', () => { clearTimeout(rec.timer); pool = pool.filter((w) => w !== rec) })
  return rec
}

// a job that never returns (mupdf hung on a corrupt/huge page) would leave the doc stuck at
// 'indexing' forever (the eternal orange badge). Kill the hung worker, mark the file 'error' (a
// clear red — not a fake in-progress), and respawn so the rest of the queue keeps flowing.
function onJobTimeout(rec) {
  const job = rec.job
  try { rec.worker.terminate() } catch {}
  pool = pool.filter((w) => w !== rec)
  if (job) {
    try { if (db.prepare('SELECT 1 FROM docs WHERE key=?').get(job.key)) db.prepare("UPDATE docs SET status='error', error='timed out (file too large or corrupt)' WHERE key=?").run(job.key) } catch {}
    notify?.()
  }
  pump()
}
function ensurePool() {
  while (pool.length < POOL_SIZE) {
    const rec = spawnWorker()
    if (!rec) break
    pool.push(rec)
  }
}
function dispatch() {
  for (const rec of pool) {
    if (!queue.length) break
    if (rec.busy || !rec.ready) continue
    const job = queue.shift()
    queued.delete(job.key)
    rec.busy = true
    rec.job = job
    try { db.prepare("UPDATE docs SET status='indexing' WHERE key=?").run(job.key) } catch {}
    notify?.()
    rec.worker.postMessage({ type: 'job', id: ++jobSeq, key: job.key, path: job.path })
    clearTimeout(rec.timer)
    rec.timer = setTimeout(() => onJobTimeout(rec), JOB_TIMEOUT) // never let a file hang the slot forever
  }
  maybeTeardown()
}
function pump() {
  if (!db) return
  if (!queue.length) { maybeTeardown(); return }
  clearTimeout(teardownTimer)
  ensurePool()
  dispatch()
}
// free the pool (and its mupdf WASM copies) after it has been idle for a while
function maybeTeardown() {
  if (queue.length || pool.some((w) => w.busy)) return
  clearTimeout(teardownTimer)
  teardownTimer = setTimeout(() => {
    if (!queue.length && !pool.some((w) => w.busy)) {
      for (const w of pool) { try { w.worker.terminate() } catch {} }
      pool = []
    }
  }, 20000)
}

// Full shutdown on app quit: terminate EVERY index worker (their mupdf-wasm handle in the install dir
// would otherwise block an auto-update overwrite, and a live worker_thread keeps the app from exiting)
// and close the DB. Called from will-quit and right before quitAndInstall.
export function stopPdfIndex() {
  clearTimeout(teardownTimer)
  queue.length = 0; queued.clear()
  for (const w of pool) { try { w.worker.terminate() } catch {} }
  pool = []
  try { db?.close() } catch {}
  db = null
}

function writeResult(key, path, result) {
  const st = safeStat(path)
  if (!st) { removeDoc(key); notify?.(); return }
  // the doc may have been purged (folder unlinked) while its worker was running — don't resurrect it
  if (!db.prepare('SELECT 1 FROM docs WHERE key=?').get(key)) { db.prepare('DELETE FROM doc_fts WHERE key=?').run(key); return }
  if (result?.ok) {
    db.prepare('DELETE FROM doc_fts WHERE key=?').run(key)
    const ins = db.prepare('INSERT INTO doc_fts (text, key, page) VALUES (?, ?, ?)')
    const tx = db.transaction((rs) => { for (const r of rs) ins.run(r.text, key, r.page) })
    tx(result.rows || [])
    db.prepare('UPDATE docs SET status=?, error=NULL, mtime=?, size=?, pages=?, indexed_at=? WHERE key=?')
      .run('done', st.mtimeMs, st.size, result.pages || 0, Date.now(), key)
  } else {
    db.prepare('UPDATE docs SET status=?, error=? WHERE key=?').run('error', result?.error || 'failed', key)
  }
  notify?.()
}

// ---- queries the renderer uses ----

// Per-path status for the tree badges (keyed by the caller's own path strings).
export function indexStates(paths) {
  if (!db) return {}
  const get = db.prepare('SELECT status, pages FROM docs WHERE key=?')
  const gv = db.prepare('SELECT count FROM variables WHERE key=?')
  const out = {}
  for (const p of paths || []) {
    const k = norm(p)
    const r = get.get(k)
    const v = gv.get(k)
    out[p] = { status: r ? r.status : 'none', pages: r ? r.pages || 0 : 0, vars: v ? v.count || 0 : 0 }
  }
  return out
}

// Template variables mirror (keyed by path). The PDF catalog is the source of truth; this DB copy
// powers the tree badge and lets us restore without opening the file.
export function getVariables(path) {
  if (!db) return null
  const r = db.prepare('SELECT json FROM variables WHERE key=?').get(norm(path))
  return r ? r.json : null
}
export function setVariables(path, json, count) {
  if (!db) return
  const key = norm(path)
  if (!json || !count) { db.prepare('DELETE FROM variables WHERE key=?').run(key); notify?.(); return }
  db.prepare(`INSERT INTO variables (key, path, json, count, updated) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET path=excluded.path, json=excluded.json, count=excluded.count, updated=excluded.updated`)
    .run(key, path, json, count, Date.now())
  notify?.()
}

// FTS query builder: quote each token (punctuation-safe), prefix-match, AND them together.
function ftsQuery(q) {
  const toks = String(q).match(/[\p{L}\p{N}]+/gu) || []
  return toks.slice(0, 12).map((t) => `"${t}"*`).join(' ')
}

// Full-text search over reachable docs → grouped by file with page snippets.
export function searchIndex(query, limit = 60) {
  if (!db || !query || !query.trim()) return { results: [] }
  const q = ftsQuery(query)
  if (!q) return { results: [] }
  let rows = []
  try {
    rows = db.prepare(`
      SELECT key, page,
             snippet(doc_fts, 0, '⟦', '⟧', '…', 12) AS snip,
             bm25(doc_fts) AS rank
      FROM doc_fts
      WHERE doc_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(q, limit * 5)
  } catch {
    return { results: [] }
  }
  const meta = new Map(db.prepare('SELECT key, path, reachable FROM docs').all().map((r) => [r.key, r]))
  const byDoc = new Map()
  for (const r of rows) {
    const m = meta.get(r.key)
    if (!m || !m.reachable) continue
    let g = byDoc.get(r.key)
    if (!g) { g = { path: m.path, name: basename(m.path), pages: [], rank: r.rank }; byDoc.set(r.key, g) }
    if (g.pages.length < 3) g.pages.push({ page: r.page, snippet: r.snip })
    g.rank = Math.min(g.rank, r.rank)
  }
  return { results: [...byDoc.values()].sort((a, b) => a.rank - b.rank).slice(0, limit) }
}

// Aggregate progress for a small header indicator.
export function indexSummary() {
  if (!db) return { total: 0, done: 0, pending: 0, error: 0 }
  const row = db.prepare(`SELECT
    COUNT(*) total,
    SUM(status='done') done,
    SUM(status IN ('pending','indexing')) pending,
    SUM(status='error') error FROM docs WHERE reachable=1`).get()
  return { total: row.total || 0, done: row.done || 0, pending: row.pending || 0, error: row.error || 0 }
}
