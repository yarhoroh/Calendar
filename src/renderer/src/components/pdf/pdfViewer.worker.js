// MuPDF-WASM parser. Per page it builds:
//  • gfx   — the page rendered to SVG (paths, lines, art, images) with <text> stripped out (vector layer).
//  • runs  — the text model: one entry per stext.walk line (a single-font run) with bbox, style and
//            per-glyph x. This model is the SOURCE OF TRUTH; the renderer draws SVG from it, edits it
//            in place, and exports it back to PDF.
// Plus extractFonts(): embedded TrueType (FontFile2) for pixel-exact glyph shapes.
import * as mupdf from 'mupdf'

let doc = null

const cleanName = (n) => String(n || '').replace(/^[A-Z]{6}\+/, '').replace(/^\*/, '').replace(/,/g, ' ')
const n2 = (v) => +Number(v).toFixed(2)
const to255 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)))
function colorHex(c) {
  if (!Array.isArray(c)) return '#000000'
  let r, g, b
  if (c.length === 1) r = g = b = c[0]
  else if (c.length === 3) [r, g, b] = c
  else if (c.length === 4) { const [cy, m, y, k] = c; r = (1 - cy) * (1 - k); g = (1 - m) * (1 - k); b = (1 - y) * (1 - k) }
  else return '#000000'
  return '#' + [r, g, b].map((v) => to255(v).toString(16).padStart(2, '0')).join('')
}

function renderGfx(page, bounds) {
  const buf = new mupdf.Buffer()
  const writer = new mupdf.DocumentWriter(buf, 'svg', 'text=text')
  const dev = writer.beginPage(bounds)
  page.run(dev, mupdf.Matrix.identity)
  dev.close(); writer.endPage(); writer.close()
  return buf
    .asString()
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, '')
    .replace(/^\s*<!DOCTYPE[^>]*>\s*/i, '')
    .replace(/<text\b[^>]*>[\s\S]*?<\/text>/gi, '')
}

// walk the page into text runs (source-of-truth model). Each walk line is one font-run, so its style
// is uniform and we keep per-glyph x for exact kerning on render and exact positions on export.
function parsePage(pageIndex) {
  const page = doc.loadPage(pageIndex)
  try {
    const bounds = page.getBounds()
    const W = n2(bounds[2] - bounds[0]), H = n2(bounds[3] - bounds[1])
    const gfx = renderGfx(page, bounds)
    const runs = []
    let bi = -1, li = -1, cur = null
    const flush = () => {
      if (cur && cur.glyphs.length) runs.push({
        id: `b${cur.bi}.l${cur.li}`, bbox: cur.bbox, ...cur.style,
        x: cur.glyphs[0].x, y: cur.glyphs[0].y, glyphs: cur.glyphs, text: cur.glyphs.map((g) => g.ch).join('')
      })
      cur = null
    }
    const stext = page.toStructuredText('preserve-spans')
    try {
      stext.walk({
        beginTextBlock: () => { bi++; li = -1 },
        beginLine: (bbox) => { li++; cur = { bi, li, bbox: { x: n2(bbox[0]), y: n2(bbox[1]), w: n2(bbox[2] - bbox[0]), h: n2(bbox[3] - bbox[1]) }, glyphs: [], style: null } },
        onChar: (rune, origin, font, size, quad, color) => {
          if (!cur) return
          if (!cur.style) cur.style = {
            font: cleanName(font.getName()),
            generic: font.isMono() ? 'monospace' : font.isSerif() ? 'serif' : 'sans-serif',
            size: n2(size), bold: font.isBold(), italic: font.isItalic(), color: colorHex(color)
          }
          cur.glyphs.push({ ch: rune, x: n2(origin[0]), y: n2(origin[1]) })
        },
        endLine: flush,
        endTextBlock: flush
      })
    } finally { stext.destroy?.() }
    return { width: W, height: H, gfx, runs }
  } finally { page.destroy() }
}

// Embedded TrueType (FontFile2) — loadable straight into a FontFace. CFF/Type1C (FontFile3) is raw and
// FontFace won't take it, so those fall back to the same-named system font via CSS.
function extractFonts() {
  const out = [], seen = {}
  let count = 0
  try { count = doc.countObjects() } catch { return out }
  for (let i = 1; i < count; i++) {
    let o; try { o = doc.newIndirect(i).resolve() } catch { continue }
    if (!o || !o.isDictionary || !o.isDictionary()) continue
    let ty; try { ty = o.get('Type') } catch { continue }
    if (!ty || ty.isNull() || ty.asName() !== 'Font') continue
    let d = o.get('FontDescriptor')
    if (d.isNull()) { const df = o.get('DescendantFonts'); if (df.isArray() && df.length) d = df.get(0).resolve().get('FontDescriptor') }
    if (!d || d.isNull()) continue
    const ff = d.get('FontFile2')
    if (ff.isNull()) continue
    const bf = o.get('BaseFont'); const family = cleanName(bf.isNull() ? '' : bf.asName())
    if (!family || seen[family]) continue
    let raw; try { raw = ff.readStream().asUint8Array() } catch { continue }
    seen[family] = 1
    out.push({ family, bytes: new Uint8Array(raw).buffer })
  }
  return out
}

self.postMessage({ ready: true })
self.onmessage = (e) => {
  const { id, type, params } = e.data
  try {
    if (type === 'open') {
      doc = mupdf.Document.openDocument(new Uint8Array(params.data), 'application/pdf')
      self.postMessage({ id, result: { pageCount: doc.countPages() } })
    } else if (type === 'parsePage') {
      if (!doc) throw new Error('no document open')
      self.postMessage({ id, result: parsePage(params.pageIndex) })
    } else if (type === 'getFonts') {
      if (!doc) throw new Error('no document open')
      const fonts = extractFonts()
      self.postMessage({ id, result: { fonts } }, fonts.map((f) => f.bytes))
    } else if (type === 'close') {
      doc?.destroy?.(); doc = null
      self.postMessage({ id, result: null })
    } else throw new Error('unknown request: ' + type)
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) })
  }
}
