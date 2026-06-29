import { app } from 'electron'
import Database from 'better-sqlite3'
import { createWriteStream, createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { createInterface } from 'readline'
import { createGunzip } from 'zlib'
import { join } from 'path'

// On-demand "big" pronunciation dictionaries (millions of word forms). The compact overlay
// lists (one "слово́" per line, combining acute U+0301 after the stressed vowel) are hosted
// on our own GitHub release; the app downloads the ~9 MB gzip and builds a local SQLite DB
// (table dict(word, over)) at userData/stress-big/{lang}-big.db with its OWN better-sqlite3,
// so the on-disk format is always compatible. stress.js then queries it word-by-word —
// never loading it into memory. Kept out of the installer so the .exe stays light.
//
// Provenance (already converted to the overlay format before hosting):
//   ru — derived from ruaccent/accentuator (Apache-2.0)
//   uk — derived from lang-uk/ukrainian-word-stress-dictionary

const ACUTE = '́'
const ASSET_BASE = 'https://github.com/yarhoroh/Calendar/releases/download/stress-dicts-v1/'
const SOURCES = {
  ru: { url: ASSET_BASE + 'ru-big.txt.gz', approxBytes: 9_900_000 },
  uk: { url: ASSET_BASE + 'uk-big.txt.gz', approxBytes: 8_700_000 }
}

export const BIG_LANGS = Object.keys(SOURCES)

export function bigDir() {
  return join(app.getPath('userData'), 'stress-big')
}
export function bigPath(lang) {
  return join(bigDir(), lang + '-big.db')
}
export function isReady(lang) {
  return existsSync(bigPath(lang))
}
// mtime so stress.js can cache-invalidate when the file appears/changes
export function bigMtime(lang) {
  try {
    return statSync(bigPath(lang)).mtimeMs
  } catch {
    return 0
  }
}

// stream the source to a .part file, reporting byte progress (0..~0.9 — the build is the rest)
async function downloadTo(url, dest, onProgress, approx) {
  const tmp = dest + '.part'
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || approx || 1
  const out = createWriteStream(tmp)
  const reader = res.body.getReader()
  let done = 0
  try {
    for (;;) {
      const { done: d, value } = await reader.read()
      if (d) break
      await new Promise((ok, no) => out.write(Buffer.from(value), (e) => (e ? no(e) : ok())))
      done += value.length
      onProgress?.(Math.min(0.9, (done / total) * 0.9))
    }
  } finally {
    await new Promise((ok) => out.end(ok))
  }
  return tmp
}

// a fresh SQLite dict DB at `path`; returns { insert(word, over), close() }. Tuned for a
// one-shot bulk build (no journal/sync). WITHOUT ROWID keeps the table compact for lookups.
function openBuildDb(path) {
  try {
    unlinkSync(path)
  } catch {
    /* no stale build */
  }
  const db = new Database(path)
  db.pragma('journal_mode = OFF')
  db.pragma('synchronous = OFF')
  db.exec('CREATE TABLE dict (word TEXT PRIMARY KEY, over TEXT) WITHOUT ROWID')
  const ins = db.prepare('INSERT OR IGNORE INTO dict (word, over) VALUES (?, ?)')
  db.exec('BEGIN')
  return {
    insert: (w, o) => ins.run(w, o),
    close: () => {
      db.exec('COMMIT')
      db.close()
    }
  }
}

// download our prebuilt overlay list, gunzip it on the fly, and insert each "слово́" line
// (key = the word without the mark) into a fresh SQLite DB. The list is already lowercase,
// single-word and single-mark, so no validation/conversion is needed here.
async function buildLang(lang, onProgress) {
  const src = SOURCES[lang]
  if (!src) throw new Error('unknown language: ' + lang)
  mkdirSync(bigDir(), { recursive: true })
  const dest = bigPath(lang)
  const build = dest + '.build'
  const gz = join(bigDir(), lang + '.txt.gz')
  console.log(`[stressBig] ${lang}: downloading ${src.url}`)
  const part = await downloadTo(src.url, gz, onProgress, src.approxBytes)
  renameSync(part, gz)
  onProgress?.(0.92) // building the database…
  console.log(`[stressBig] ${lang}: building SQLite…`)
  const dbw = openBuildDb(build)
  let n = 0
  try {
    const rl = createInterface({ input: createReadStream(gz).pipe(createGunzip()), crlfDelay: Infinity })
    for await (const line of rl) {
      const s = line.trim()
      const bare = s.replaceAll(ACUTE, '')
      if (!s || bare === s) continue // empty or no stress mark → skip
      dbw.insert(bare, s)
      n++
    }
  } finally {
    dbw.close()
  }
  renameSync(build, dest)
  console.log(`[stressBig] ${lang}: ready — ${n} entries`)
  try {
    unlinkSync(gz)
  } catch {
    /* leftover gzip — harmless */
  }
  onProgress?.(1)
}

// ---- per-language download state machine (drives the settings UI) ----
const states = {} // lang → { status, progress, error } : absent|downloading|ready|error
const inFlight = {}
let notify = () => {}

export function initStressBigDownload({ onState } = {}) {
  if (onState) notify = onState
}

export function getBigStatus(lang) {
  let st = states[lang]
  if (!st) st = states[lang] = { status: 'absent', progress: 0, error: '' }
  if (st.status === 'absent' && isReady(lang)) st = states[lang] = { status: 'ready', progress: 1, error: '' }
  return { lang, ...st }
}

export function startBigDownload(lang) {
  if (!SOURCES[lang]) return getBigStatus(lang)
  if (getBigStatus(lang).status === 'ready' || inFlight[lang]) return getBigStatus(lang)
  states[lang] = { status: 'downloading', progress: 0, error: '' }
  notify(getBigStatus(lang))
  inFlight[lang] = buildLang(lang, (p) => {
    states[lang] = { status: 'downloading', progress: p, error: '' }
    notify(getBigStatus(lang))
  })
    .then(() => {
      states[lang] = { status: 'ready', progress: 1, error: '' }
    })
    .catch((e) => {
      states[lang] = { status: 'error', progress: states[lang]?.progress || 0, error: e.message }
    })
    .finally(() => {
      inFlight[lang] = null
      notify(getBigStatus(lang))
    })
  return getBigStatus(lang)
}

// remove a downloaded big dict (free disk / switch back to compact)
export function removeBig(lang) {
  try {
    unlinkSync(bigPath(lang))
  } catch {
    /* not present */
  }
  states[lang] = { status: 'absent', progress: 0, error: '' }
  return getBigStatus(lang)
}
