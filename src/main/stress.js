import { app } from 'electron'
import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'

// Adds word stress marks (combining acute U+0301) to Russian/Ukrainian text using the
// bundled compact dictionaries (resources/stress/{ru,uk}.txt — one stressed word per
// line). Used right before neural TTS (Supertonic) so it stresses words correctly;
// the displayed text is never touched, so the marks stay invisible to the user.
// Words not in the dictionary are left as-is (the model guesses their stress).

const ACUTE = '́'

function stressRoot() {
  return app.isPackaged ? join(process.resourcesPath, 'stress') : join(app.getAppPath(), 'resources', 'stress')
}

// parse one word file into the map. One entry per line; '#' lines are comments.
// Two entry kinds:
//   • "слово́"            → stress OVERLAY: just add the mark onto the original letters
//                          (kept only if EXACTLY one mark — multi-mark is ambiguous)
//   • "написание>звучание" → REPLACEMENT: swap the whole word (for е→ё, г→в, …) where an
//                          overlay can't change letters. Left = how it's written in text.
// Later files override earlier ones (same key → last write wins).
function parseInto(m, file) {
  try {
    if (!existsSync(file)) return
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const gt = s.indexOf('>')
      if (gt > 0) {
        const from = s.slice(0, gt).trim().replaceAll(ACUTE, '').toLowerCase()
        const to = s.slice(gt + 1).trim()
        if (from && to) m.set(from, { repl: to })
        continue
      }
      if (s.split(ACUTE).length - 1 !== 1) continue
      m.set(s.replaceAll(ACUTE, '').toLowerCase(), { over: s })
    }
  } catch {
    /* file missing/unreadable → no-op */
  }
}

const dicts = {} // lang → { map, mtime } — keyed by the -extra file's mtime for hot-reload
function load(lang) {
  const extra = join(stressRoot(), lang + '-extra.txt')
  let mtime = 0
  try {
    mtime = statSync(extra).mtimeMs
  } catch {
    /* no extra file */
  }
  const cached = dicts[lang]
  if (cached && cached.mtime === mtime) return cached.map // unchanged → reuse
  const m = new Map()
  parseInto(m, join(stressRoot(), lang + '.txt')) // base stress overlays
  // auto ёfication (е→ё replacements from eyo-kernel's "safe", homograph-free list) so
  // de-yofied text ("звездами") reads with ё ("звёздами"); ё is inherently stressed
  parseInto(m, join(stressRoot(), lang + '-yo.txt'))
  // generated common-word paradigms missing from the base (e.g. end-stressed adjectives)
  parseInto(m, join(stressRoot(), lang + '-common.txt'))
  // hand-curated corrections/additions, loaded LAST so they win over everything above.
  // Re-read when the file's mtime changes so edits apply live (no app restart needed).
  parseInto(m, extra)
  dicts[lang] = { map: m, mtime }
  return m
}

// re-apply the original word's casing to the dictionary's stressed (lowercase) form
function restoreCase(orig, stressedLower) {
  let out = ''
  let i = 0
  for (const ch of stressedLower) {
    if (ch === ACUTE) out += ACUTE
    else out += orig[i++] ?? ch
  }
  return out
}

// for a full replacement, just match the original's leading capital (start-of-sentence etc.)
function applyCase(orig, repl) {
  const c = orig[0]
  if (c && c === c.toUpperCase() && c !== c.toLowerCase()) return repl.charAt(0).toUpperCase() + repl.slice(1)
  return repl
}

export function accentuate(text, lang) {
  if ((lang !== 'ru' && lang !== 'uk') || !text) return text
  const m = load(lang)
  if (!m.size) return text
  return text.replace(/[А-Яа-яЁёІіЇїЄєҐґ'’]+/g, (w) => {
    const e = m.get(w.toLowerCase())
    if (!e) return w
    return e.repl != null ? applyCase(w, e.repl) : restoreCase(w, e.over)
  })
}
