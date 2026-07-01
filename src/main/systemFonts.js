// System font enumeration + PDF-font resolver. Used when a PDF's font is NOT embedded: we must pick
// the closest installed font so editing/added text looks right. Strategy (best → worst):
//   1. embedded      — nothing to resolve, the file carries the font
//   2. exact-system  — installed font whose PostScript name matches the PDF BaseFont
//   3. alias         — standard-14 PDF font mapped to a known system equivalent
//   4. family        — family-name contains/contained-by match
//   5. fallback      — serif/mono/sans default
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

let cache = null
let extraDirs = [] // bundled (Liberation/Noto) + user-import dirs, set by the main process

// bundled-font / user-import dirs are searched FIRST so our shipped Liberation/Noto win ties.
export function setExtraFontDirs(dirs) {
  extraDirs = (dirs || []).filter(Boolean)
  cache = null
}

function fontDirs() {
  const dirs = [...extraDirs]
  if (process.platform === 'win32') {
    dirs.push(join(process.env.WINDIR || 'C:\\Windows', 'Fonts'))
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'))
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts', join(os.homedir(), 'Library/Fonts'))
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts', join(os.homedir(), '.fonts'), join(os.homedir(), '.local/share/fonts'))
  }
  return dirs
}

// Parse one sfnt (TrueType/OpenType) at `offset` → { family, full, post, bold, italic }.
function parseSfnt(buf, dv, offset) {
  const numTables = dv.getUint16(offset + 4)
  let nameOff = -1
  let os2Off = -1
  let headOff = -1
  for (let i = 0; i < numTables; i++) {
    const r = offset + 12 + i * 16
    const tag = String.fromCharCode(buf[r], buf[r + 1], buf[r + 2], buf[r + 3])
    const off = dv.getUint32(r + 8)
    if (tag === 'name') nameOff = off
    else if (tag === 'OS/2') os2Off = off
    else if (tag === 'head') headOff = off
  }
  if (nameOff < 0) return null
  const count = dv.getUint16(nameOff + 2)
  const strOff = nameOff + dv.getUint16(nameOff + 4)
  const res = {}
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12
    const plat = dv.getUint16(r)
    const nameID = dv.getUint16(r + 6)
    const len = dv.getUint16(r + 8)
    const o = dv.getUint16(r + 10)
    let s = ''
    if (plat === 3 || plat === 0) {
      for (let j = 0; j + 1 < len; j += 2) s += String.fromCharCode((buf[strOff + o + j] << 8) | buf[strOff + o + j + 1])
    } else {
      for (let j = 0; j < len; j++) s += String.fromCharCode(buf[strOff + o + j])
    }
    if (nameID === 1 && !res.family) res.family = s
    else if (nameID === 4 && !res.full) res.full = s
    else if (nameID === 6 && !res.post) res.post = s
  }
  let bold = false
  let italic = false
  if (os2Off >= 0) {
    const fsSel = dv.getUint16(os2Off + 62)
    italic = !!(fsSel & 1)
    bold = !!(fsSel & 32)
  } else if (headOff >= 0) {
    const macStyle = dv.getUint16(headOff + 44)
    bold = !!(macStyle & 1)
    italic = !!(macStyle & 2)
  }
  return { family: res.family || '', full: res.full || '', post: res.post || '', bold, italic }
}

function parseFontFile(path) {
  const buf = readFileSync(path)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = String.fromCharCode(buf[0], buf[1], buf[2], buf[3])
  const fonts = []
  if (tag === 'ttcf') {
    const num = dv.getUint32(8)
    for (let i = 0; i < num; i++) {
      const f = parseSfnt(buf, dv, dv.getUint32(12 + i * 4))
      if (f) fonts.push(f)
    }
  } else {
    const f = parseSfnt(buf, dv, 0)
    if (f) fonts.push(f)
  }
  return fonts.map((f) => ({ ...f, path }))
}

export function listSystemFonts() {
  if (cache) return cache
  const out = []
  for (const dir of fontDirs()) {
    let files = []
    try {
      files = readdirSync(dir)
    } catch (_) {
      continue
    }
    for (const file of files) {
      if (!/\.(ttf|ttc|otf)$/i.test(file)) continue
      try {
        out.push(...parseFontFile(join(dir, file)))
      } catch (_) {
        // unreadable / unusual font file — skip
      }
    }
  }
  cache = out
  return out
}

// Standard-14 PDF fonts → equivalents. Liberation first: it's metric-compatible with Arial / Times
// New Roman / Courier New (same advance widths), so substitution stays 1:1 on layout.
const ALIASES = {
  Helvetica: ['Liberation Sans', 'Arial', 'Noto Sans'],
  'Helvetica-Bold': ['Liberation Sans', 'Arial'],
  'Helvetica-Oblique': ['Liberation Sans', 'Arial'],
  'Helvetica-BoldOblique': ['Liberation Sans', 'Arial'],
  'Times-Roman': ['Liberation Serif', 'Times New Roman', 'Noto Serif'],
  'Times-Bold': ['Liberation Serif', 'Times New Roman'],
  'Times-Italic': ['Liberation Serif', 'Times New Roman'],
  'Times-BoldItalic': ['Liberation Serif', 'Times New Roman'],
  Courier: ['Liberation Mono', 'Courier New', 'Noto Sans Mono'],
  'Courier-Bold': ['Liberation Mono', 'Courier New'],
  'Courier-Oblique': ['Liberation Mono', 'Courier New'],
  'Courier-BoldOblique': ['Liberation Mono', 'Courier New'],
  Symbol: ['Symbol', 'Noto Sans Symbols'],
  ZapfDingbats: ['Zapf Dingbats', 'Dingbats'],
  Arial: ['Arial', 'Liberation Sans'],
  ArialMT: ['Arial', 'Liberation Sans'],
  TimesNewRoman: ['Times New Roman', 'Liberation Serif'],
  TimesNewRomanPSMT: ['Times New Roman', 'Liberation Serif'],
  CourierNew: ['Courier New', 'Liberation Mono'],
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Liberation metric clone of the requested font — drop-in width-compatible replacement.
function metricClone(pdf) {
  const n = norm(pdf.name || pdf.baseFont || '')
  if (n.includes('times') || (pdf.serif && !pdf.mono)) return 'Liberation Serif'
  if (n.includes('courier') || pdf.mono) return 'Liberation Mono'
  return 'Liberation Sans' // Arial / Helvetica / generic sans
}

// pdf: { name, baseFont, embedded, subset, serif, mono, italic, bold }
// Returns a substitute, going best → worst across all sources.
function substitute(pdf) {
  const fonts = listSystemFonts()
  const want = (f) => f.bold === !!pdf.bold && f.italic === !!pdf.italic
  const byFamily = (fam) => fonts.find((f) => norm(f.family) === norm(fam) && want(f)) || fonts.find((f) => norm(f.family) === norm(fam))
  const base = (pdf.baseFont || pdf.name || '').replace(/^[A-Z]{6}\+/, '')
  const target = norm(pdf.name || base)

  // exact PostScript name (installed)
  let hit = fonts.find((f) => norm(f.post) === target)
  if (hit) return { source: 'exact-system', fontName: hit.family || hit.post, fontPath: hit.path, confidence: 0.95 }

  // Liberation metric clone (bundled) — same widths as Arial/Times/Courier
  hit = byFamily(metricClone(pdf))
  if (hit) return { source: 'liberation', fontName: hit.family, fontPath: hit.path, confidence: 0.9 }

  // alias map
  for (const a of ALIASES[base] || ALIASES[pdf.name] || []) {
    hit = byFamily(a)
    if (hit) return { source: 'alias', fontName: hit.family, fontPath: hit.path, confidence: 0.8 }
  }

  // family contains / contained-by
  hit = fonts.find((f) => f.family && (norm(f.family).includes(target) || target.includes(norm(f.family))) && want(f))
  if (hit) return { source: 'family', fontName: hit.family, fontPath: hit.path, confidence: 0.6 }

  // Noto — broad Unicode coverage when nothing else fits
  hit = byFamily(pdf.mono ? 'Noto Sans Mono' : pdf.serif ? 'Noto Serif' : 'Noto Sans')
  if (hit) return { source: 'noto', fontName: hit.family, fontPath: hit.path, confidence: 0.5 }

  return { source: 'fallback', fontName: metricClone(pdf), confidence: 0.3 }
}

export function resolveFont(pdf) {
  // fully embedded → use as-is, nothing to substitute
  if (pdf.embedded && !pdf.subset) return { source: 'embedded', fontName: pdf.name, confidence: 1 }
  const sub = substitute(pdf)
  // subset embedded → fine for existing glyphs, but new characters need the substitute
  if (pdf.embedded) return { source: 'embedded-subset', fontName: pdf.name, confidence: 1, substitute: sub }
  return sub
}

export function resolveFonts(pdfFonts) {
  return (pdfFonts || []).map((f) => ({ ...f, resolved: resolveFont(f) }))
}

// Locate an actual font FILE for a requested family + style (for embedding into a PDF when editing
// text). Prefers the exact style, then any style of the family, then bundled Noto as a last resort.
export function fontFileFor(family, { bold = false, italic = false } = {}) {
  const fonts = listSystemFonts()
  const inFamily = fonts.filter((f) => norm(f.family) === norm(family))
  const noto = () => fonts.filter((f) => norm(f.family) === norm('Noto Sans'))
  const styled = (list) =>
    list.find((f) => !!f.bold === !!bold && !!f.italic === !!italic) || list.find((f) => !!f.bold === !!bold) || list[0]
  const hit = styled(inFamily.length ? inFamily : noto())
  return hit ? { family: hit.family, bold: !!hit.bold, italic: !!hit.italic, path: hit.path } : null
}

export function fontBytesFor(family, style) {
  const hit = fontFileFor(family, style)
  if (!hit) return null
  const buf = readFileSync(hit.path)
  return { family: hit.family, bold: hit.bold, italic: hit.italic, bytes: new Uint8Array(buf).buffer }
}
