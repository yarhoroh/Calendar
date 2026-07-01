// Minimal MuPDF worker for the PDF viewer: open a document and render pages to PNG. Pure
// request/response — the renderer talks to it through pdfEngine.js. We rebuild the editor on top
// of this from scratch, one feature at a time, instead of the previous vendored engine.
import * as mupdf from 'mupdf'
import {
  colorToHex,
  collectPalette,
  buildBlock,
  splitTableBlock,
  computeParagraphSpacing,
  documentLineSpacing,
  markUnderlines,
} from './pdfModel.js'

let doc = null
let undoStack = [] // snapshots (PDF bytes) of the working copy before each edit, newest last
let moveBaseline = null // { cs, pageIndex } — baseline stream for an in-progress real-time move
let editBaseline = null // { cs, pageIndex } — original stream while an inline text editor is open
let embeddedFonts = {} // fontKey → { font, name } — fonts embedded for text edits (reset per document)
let fontSeq = 0 // running index for /EFn resource names

// snapshot the working copy so the edit about to happen can be undone (cap at 20)
function pushUndo() {
  if (!doc) return
  try {
    undoStack.push(doc.saveToBuffer().asUint8Array())
    if (undoStack.length > 20) undoStack.shift()
  } catch (_) {
    // saveToBuffer failed — skip this undo point rather than break the edit
  }
}

const stripSubset = (n) => (n || '').replace(/^[A-Z]{6}\+/, '')

// Length-preserving mask: blank the inside of ( ) literal strings and < > hex strings so q/Q letters
// living inside text/operands are never mistaken for q/Q operators. Offsets stay identical to the
// original stream, so block ranges found here splice back into the real bytes unchanged.
function maskStreamOperands(s) {
  const a = s.split('')
  let i = 0
  while (i < a.length) {
    const ch = a[i]
    if (ch === '(') {
      let depth = 1
      let j = i + 1
      while (j < a.length && depth > 0) {
        if (a[j] === '\\') { a[j] = 'X'; if (j + 1 < a.length) a[j + 1] = 'X'; j += 2; continue }
        if (a[j] === '(') depth++
        else if (a[j] === ')') { depth--; if (depth === 0) break }
        a[j] = 'X'
        j++
      }
      i = j + 1
    } else if (ch === '<') {
      let j = i + 1
      while (j < a.length && a[j] !== '>') { a[j] = 'X'; j++ }
      i = j + 1
    } else i++
  }
  return a.join('')
}

// Find every TOP-LEVEL `q … Q` block (balanced; nesting from earlier cm-wraps collapses into its
// enclosing top-level block). Returns [start, end) byte ranges in stream order. There is exactly one
// such block per paint op (verified against the Device paint sequence), so the Nth block == paintZ N.
const Q_OP = /(?<=^|[\s[\]<>(){}/])[qQ](?=[\s[\]<>(){}/]|$)/g
function topLevelQBlocks(masked) {
  Q_OP.lastIndex = 0
  let m
  let depth = 0
  let start = -1
  const blocks = []
  while ((m = Q_OP.exec(masked))) {
    if (m[0] === 'q') {
      if (depth === 0) start = m.index
      depth++
    } else if (depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        blocks.push([start, m.index + 1])
        start = -1
      }
    }
  }
  return blocks
}

// The enclosing (page-base) CTM scale |a|,|d| in effect at each top-level block's `q`, built from the
// depth-0 `cm` operators only (transforms inside a q..Q are saved/restored, so they don't carry over).
// A `cm` shift inserted right after the `q` is multiplied by this scale, so dividing the device-space
// drag delta by it makes the on-screen move exact. Same order as topLevelQBlocks → index by paintZ-1.
const matMul = (A, B) => [
  A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5],
]
function blockBaseScales(masked) {
  const toks = masked.split(/\s+/)
  let depth = 0
  let base = [1, 0, 0, 1, 0, 0]
  const stack = []
  const num = []
  const scales = []
  for (const t of toks) {
    if (/^-?[0-9.]+$/.test(t)) { num.push(parseFloat(t)); continue }
    if (t === 'q') {
      if (depth === 0) scales.push([Math.abs(base[0]) || 1, Math.abs(base[3]) || 1])
      stack.push(base.slice())
      depth++
      num.length = 0
    } else if (t === 'Q') {
      if (stack.length) base = stack.pop()
      depth--
      num.length = 0
    } else if (t === 'cm') {
      const m = num.slice(-6)
      if (depth === 0 && m.length === 6) base = matMul(m, base)
      num.length = 0
    } else num.length = 0
  }
  return scales
}

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '')
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}

// Embed a font (once per key) as a CID/Identity-H font, register it in the page's /Resources /Font,
// and keep the Font object around so text can be encoded to glyph ids. Returns { name, font }.
function ensureEditFont(pageIndex, fontKey, fontBytes) {
  let rec = embeddedFonts[fontKey]
  if (!rec) {
    const font = new mupdf.Font(fontKey || 'EditFont', new Uint8Array(fontBytes))
    const ref = doc.addFont(font)
    rec = { font, ref, name: 'EF' + fontSeq++, pages: new Set() }
    embeddedFonts[fontKey] = rec
  }
  if (!rec.pages.has(pageIndex)) {
    const pageObj = doc.findPage(pageIndex)
    let res = pageObj.getInheritable('Resources')
    if (!res || res.isNull()) { res = doc.newDictionary(); pageObj.put('Resources', res) }
    let fontDict = res.get('Font')
    if (fontDict.isNull()) { fontDict = doc.newDictionary(); res.put('Font', fontDict) }
    fontDict.put(rec.name, rec.ref)
    rec.pages.add(pageIndex)
  }
  return rec
}

// Encode a JS string to hex glyph ids for a CID/Identity-H font (2 bytes per glyph = its gid).
function encodeGlyphs(font, text) {
  let hex = ''
  for (const ch of text) {
    const gid = font.encodeCharacter(ch.codePointAt(0))
    hex += (gid & 0xffff).toString(16).padStart(4, '0')
  }
  return hex
}

// A TJ number this large is a COLUMN gap (table cell boundary), not letter/word kerning (which stays
// well under ~100). Between such gaps sit separate cells packed into one Tj — we preserve the gaps so
// editing one cell doesn't collapse the row into a single run.
const BIG_KERN = 300
function columnGaps(tjBody) {
  const nums = (tjBody.replace(/<[0-9A-Fa-f\s]*>/g, ' ').match(/-?\d+(?:\.\d+)?/g) || []).map(Number)
  return nums.filter((n) => Math.abs(n) >= BIG_KERN)
}

// Every text-show operator (Tj/TJ/'/") in stream order, as [start,end) byte ranges. MuPDF fires one
// fillText per show operator, so the Nth show == the Nth text paint == a run's textSeq (fragmentZ).
// This is how we locate text to edit — robust even when a q..Q block holds several shows.
function findTextShows(masked) {
  const re = /(\[[^\]]*\]|<[^>]*>|\((?:[^()\\]|\\.)*\))\s*(?:TJ|Tj|'|")/g
  const out = []
  let m
  while ((m = re.exec(masked))) out.push([m.index, m.index + m[0].length])
  return out
}
// Device origin (x, y) of each text-show operator, IN STREAM ORDER (same order as findTextShows), by
// interpreting the content: CTM (cm + q/Q stack) and the text matrix (Tm/Td/TD/T*). Output is in the
// content's own space; the caller flips Y by page height to match MuPDF's y-down device space. This
// lets us map a model run (known device origin) to its exact show operator, robust to form XObjects.
function textShowPositions(masked) {
  const toks = masked.split(/\s+/)
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack = []
  let tm = [1, 0, 0, 1, 0, 0]
  let tlm = [1, 0, 0, 1, 0, 0]
  let leading = 0
  const num = []
  const out = []
  const N = (k) => num.slice(-k).map(Number)
  for (const t of toks) {
    if (/^-?[0-9.]+$/.test(t)) { num.push(t); continue }
    if (t === 'q') stack.push(ctm.slice())
    else if (t === 'Q') { if (stack.length) ctm = stack.pop() }
    else if (t === 'cm') { const m = N(6); if (m.length === 6) ctm = matMul(m, ctm) }
    else if (t === 'BT') { tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0] }
    else if (t === 'Tm') { const m = N(6); if (m.length === 6) { tlm = m.slice(); tm = m.slice() } }
    else if (t === 'TL') { const l = N(1); if (l.length) leading = l[0] }
    else if (t === 'Td') { const [x, y] = N(2); tlm = matMul([1, 0, 0, 1, x, y], tlm); tm = tlm.slice() }
    else if (t === 'TD') { const [x, y] = N(2); leading = -y; tlm = matMul([1, 0, 0, 1, x, y], tlm); tm = tlm.slice() }
    else if (t === 'T*') { tlm = matMul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice() }
    else if (t === 'Tj' || t === 'TJ' || t === "'" || t === '"') { const trm = matMul(tm, ctm); out.push([trm[4], trm[5]]) }
    num.length = 0
  }
  return out
}

// Font resource + size in effect just before an offset (the last `/name size Tf` above it).
function tfBefore(cs, at) {
  const tfs = [...cs.slice(0, at).matchAll(/\/(\S+)\s+(-?[0-9.]+)\s+Tf/g)]
  const last = tfs[tfs.length - 1]
  return last ? { font: last[1], size: parseFloat(last[2]) } : { font: 'F1', size: 10 }
}

// Surgically rewrite ONE text q..Q block: swap the font resource + size, replace the shown string
// with new glyphs, and set the fill colour — keeping the block's clip, cm and Tm so position/scale
// are preserved exactly. tfScale rescales the existing Tf (new effective size ÷ old effective size).
// `text` may contain newlines: each line is a column of a packed table row. We turn the block's big
// kerning gaps into that many REAL spaces (gap ÷ this font's space advance), so the columns keep their
// positions AND the result is plain spaced text — natural to edit next time (no magic kerning numbers).
function editBlockText(slice, { fontName, tfScale, rgb, text, encode, spaceUnits }) {
  slice = slice.replace(/\/\S+\s+(-?[0-9.]+)\s+Tf/, (_m, sz) => `/${fontName} ${(parseFloat(sz) * tfScale).toFixed(4)} Tf`)
  const showRe = /\[[^\]]*\]\s*TJ|<[0-9A-Fa-f\s]*>\s*Tj|\((?:[^()\\]|\\.)*\)\s*Tj/
  const tj = slice.match(showRe)
  if (tj) {
    const segs = String(text).split('\n')
    const gaps = columnGaps(tj[0])
    let joined
    if (gaps.length && segs.length === gaps.length + 1) {
      const unit = spaceUnits > 0 ? spaceUnits : 250
      joined = ''
      segs.forEach((s, i) => {
        joined += s
        if (i < gaps.length) joined += ' '.repeat(Math.max(1, Math.round(Math.abs(gaps[i]) / unit)))
      })
    } else {
      joined = segs.join(' ') // keep internal spaces as-is (no collapsing — they carry the layout)
    }
    slice = slice.replace(showRe, `<${encode(joined)}> Tj`)
  }
  const colorOp = `${rgb.map((c) => Math.round(c * 1000) / 1000).join(' ')} rg`
  const colorRe = /(?:-?[0-9.]+\s+){3}rg\b|(?:-?[0-9.]+\s+){4}k\b|(?:^|\s)-?[0-9.]+\s+g(?=\s)/
  slice = colorRe.test(slice) ? slice.replace(colorRe, ' ' + colorOp) : slice.replace(/\bBT\b/, `BT ${colorOp}`)
  return slice
}

// A page's /Contents may be ONE stream or an ARRAY of streams (the renderer concatenates them). Our
// block indexing (paintZ) is computed over the whole page, so we must read EVERY stream, and when we
// write an edit back we collapse them into a single stream (all content in the first, rest emptied) so
// offsets and indices stay consistent across every later edit.
function readPageContent(pageObj) {
  const contents = pageObj.get('Contents')
  const dec = (s) => new TextDecoder('latin1').decode(s.readStream().asUint8Array())
  if (contents.isArray()) {
    const parts = []
    for (let i = 0; i < contents.length; i++) parts.push(dec(contents.get(i)))
    return parts.join('\n') // PDF concatenates content streams with whitespace between them
  }
  return dec(contents)
}
function writePageContent(pageObj, cs) {
  const bytes = new Uint8Array(cs.length)
  for (let i = 0; i < cs.length; i++) bytes[i] = cs.charCodeAt(i) & 0xff
  const contents = pageObj.get('Contents')
  if (contents.isArray()) {
    contents.get(0).writeStream(bytes)
    for (let i = 1; i < contents.length; i++) contents.get(i).writeStream(new Uint8Array(0))
  } else {
    contents.writeStream(bytes)
  }
}

// Write the full page content back and rasterise the page.
function renderPageWrite(pageObj, cs, pageIndex, scale) {
  writePageContent(pageObj, cs)
  const page = doc.loadPage(pageIndex)
  try {
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
    const png = pix.asPNG()
    const w = pix.getWidth()
    const h = pix.getHeight()
    pix.destroy()
    return { png: new Uint8Array(png).buffer, width: w / scale, height: h / scale }
  } finally {
    page.destroy()
  }
}

// Parse a TrueType/OpenType `name` table to recover the real font names that BaseFont may hide
// behind a generic id (e.g. "CIDFont+F1"). Returns { family, full, post } or null.
function parseSfntName(buf) {
  try {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const numTables = dv.getUint16(4)
    let nameOff = -1
    for (let i = 0; i < numTables; i++) {
      const r = 12 + i * 16
      if (String.fromCharCode(buf[r], buf[r + 1], buf[r + 2], buf[r + 3]) === 'name') nameOff = dv.getUint32(r + 8)
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
      const off = dv.getUint16(r + 10)
      let s = ''
      if (plat === 3 || plat === 0) {
        for (let j = 0; j + 1 < len; j += 2) s += String.fromCharCode((buf[strOff + off + j] << 8) | buf[strOff + off + j + 1])
      } else {
        for (let j = 0; j < len; j++) s += String.fromCharCode(buf[strOff + off + j])
      }
      if (nameID === 1 && !res.family) res.family = s
      else if (nameID === 4 && !res.full) res.full = s
      else if (nameID === 6 && !res.post) res.post = s
    }
    return res
  } catch (_) {
    return null
  }
}

// Read every font resource from the PDF dictionary: real BaseFont name (subset tag stripped),
// whether the font file is embedded (FontFile/FontFile2/FontFile3), subtype, descriptor flags and
// metrics. This is the foundation for font substitution — knowing what's actually in the file.
function extractFontResources(document) {
  const out = []
  const seen = new Set()
  let count = 0
  try {
    count = document.countObjects()
  } catch (_) {
    return out
  }
  for (let i = 1; i < count; i++) {
    let obj = null
    try {
      obj = document.newIndirect(i).resolve()
    } catch (_) {
      continue
    }
    if (!obj || !obj.isDictionary || !obj.isDictionary()) continue
    let typ = null
    try {
      typ = obj.get('Type')
    } catch (_) {
      continue
    }
    if (!typ || typ.isNull() || typ.asName() !== 'Font') continue
    const bf = obj.get('BaseFont')
    if (bf.isNull()) continue
    const baseFont = bf.asName()
    if (seen.has(baseFont)) continue
    seen.add(baseFont)
    const subtype = obj.get('Subtype').isNull() ? '' : obj.get('Subtype').asName()
    // descriptor: directly, or via DescendantFonts[0] for Type0
    let descr = obj.get('FontDescriptor')
    if (descr.isNull()) {
      const df = obj.get('DescendantFonts')
      if (df.isArray() && df.length > 0) descr = df.get(0).resolve().get('FontDescriptor')
    }
    let embedded = false
    let flags = 0
    let realName = null
    const m = {}
    if (descr && !descr.isNull()) {
      embedded =
        !descr.get('FontFile').isNull() || !descr.get('FontFile2').isNull() || !descr.get('FontFile3').isNull()
      if (!descr.get('Flags').isNull()) flags = descr.get('Flags').asNumber()
      const num = (k) => {
        const v = descr.get(k)
        return v && !v.isNull() ? v.asNumber() : null
      }
      m.ascent = num('Ascent')
      m.descent = num('Descent')
      m.capHeight = num('CapHeight')
      m.xHeight = num('XHeight')
      m.italicAngle = num('ItalicAngle')
      m.stemV = num('StemV')
      // recover the real name from the embedded TrueType file when BaseFont is generic
      const ff2 = descr.get('FontFile2')
      if (!ff2.isNull()) {
        try {
          const nm = parseSfntName(ff2.readStream().asUint8Array())
          if (nm) realName = nm.full || nm.family || nm.post
        } catch (_) {
          // unreadable font file — keep BaseFont
        }
      }
    }
    out.push({
      name: realName || stripSubset(baseFont),
      baseFont,
      subtype,
      subset: /^[A-Z]{6}\+/.test(baseFont),
      embedded,
      flags,
      serif: !!(flags & 2), // bit 2 = Serif
      mono: !!(flags & 1), // bit 1 = FixedPitch
      italic: !!(flags & 64) || (m.italicAngle != null && m.italicAngle !== 0), // bit 7 = Italic
      bold: !!(flags & 262144), // bit 19 = ForceBold
      ...m,
    })
  }
  return out
}

// Collect the raw bytes of every embedded TrueType font (FontFile2) keyed by its real name, so the
// renderer can load them as @font-face and show edited text in the ORIGINAL glyphs (1:1). Only
// FontFile2 (TrueType) loads reliably in the browser; CFF/Type1 embeds fall back to a system family.
function collectEmbeddedFonts() {
  const out = []
  const seen = new Set()
  let count = 0
  try {
    count = doc.countObjects()
  } catch (_) {
    return out
  }
  for (let i = 1; i < count; i++) {
    let obj = null
    try {
      obj = doc.newIndirect(i).resolve()
    } catch (_) {
      continue
    }
    if (!obj || !obj.isDictionary || !obj.isDictionary()) continue
    let typ = null
    try {
      typ = obj.get('Type')
    } catch (_) {
      continue
    }
    if (!typ || typ.isNull() || typ.asName() !== 'Font') continue
    const bf = obj.get('BaseFont')
    if (bf.isNull()) continue
    let descr = obj.get('FontDescriptor')
    if (descr.isNull()) {
      const df = obj.get('DescendantFonts')
      if (df.isArray() && df.length > 0) descr = df.get(0).resolve().get('FontDescriptor')
    }
    if (!descr || descr.isNull()) continue
    const ff2 = descr.get('FontFile2')
    if (ff2.isNull()) continue
    let raw = null
    try {
      raw = ff2.readStream().asUint8Array()
    } catch (_) {
      continue
    }
    let name = stripSubset(bf.asName())
    try {
      const nm = parseSfntName(raw)
      if (nm) name = nm.full || nm.family || nm.post || name
    } catch (_) {
      /* keep BaseFont-derived name */
    }
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, bytes: new Uint8Array(raw).buffer }) // fresh buffer so it can be transferred
  }
  return out
}

// MuPDF loads via top-level await, so this module only finishes evaluating (and onmessage is
// installed) once WASM is ready. Tell the engine — it queues commands until it sees this, instead
// of firing them into the void while we were still loading.
self.postMessage({ ready: true })

self.onmessage = (e) => {
  const { id, type, params } = e.data
  try {
    if (type === 'open') {
      doc = mupdf.Document.openDocument(new Uint8Array(params.data), 'application/pdf')
      undoStack = [] // fresh working copy → clear history
      embeddedFonts = {} // font refs belong to the old doc — drop them
      editBaseline = null
      // Is the logical structure actually stored in the file? Tagged PDFs carry a structure tree
      // (/StructTreeRoot) + marked content (/MarkInfo /Marked). Untagged PDFs carry none — blocks
      // can only be reconstructed geometrically. Report which, so we know what we're working with.
      let tagged = false
      let marked = false
      try {
        const trailer = doc.getTrailer()
        const structRoot = trailer.get('Root', 'StructTreeRoot')
        tagged = !!(structRoot && !structRoot.isNull())
        const m = trailer.get('Root', 'MarkInfo', 'Marked')
        marked = !!(m && !m.isNull() && m.asBoolean())
      } catch (_) {
        // not a trailer-bearing PDF / no struct info — leave both false
      }
      self.postMessage({ id, result: { pageCount: doc.countPages(), tagged, marked } })
    } else if (type === 'renderPage') {
      if (!doc) throw new Error('no document open')
      const page = doc.loadPage(params.pageIndex)
      try {
        const m = mupdf.Matrix.scale(params.scale, params.scale)
        const pix = page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false)
        const png = pix.asPNG()
        const w = pix.getWidth()
        const h = pix.getHeight()
        pix.destroy()
        // width/height in PDF points (pixels ÷ scale) so the view can size pages independent of zoom
        const buf = new Uint8Array(png).buffer
        self.postMessage({ id, result: { png: buf, width: w / params.scale, height: h / params.scale } }, [buf])
      } finally {
        page.destroy()
      }
    } else if (type === 'getModel') {
      // Rich-text model of the page. Style (font/color/bold/italic) and structure come from MuPDF's
      // structured text, but the FONT SIZE comes from a Device pass: MuPDF's stext size mixes in each
      // font's FontMatrix and is inconsistent, whereas the glyph's text-render-matrix × ctm gives the
      // true size Acrobat shows. Blocks use plain `preserve-whitespace` grouping (whole paragraphs).
      if (!doc) throw new Error('no document open')
      const page = doc.loadPage(params.pageIndex)
      try {
        const bounds = page.getBounds()
        const pageArea = Math.max(1, (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]))
        const toRect = (b) => ({ x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] })
        const quadBounds = (q) => {
          const xs = [q[0], q[2], q[4], q[6]]
          const ys = [q[1], q[3], q[5], q[7]]
          return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
        }

        // Pass 0 — Device pass. Device callbacks fire in CONTENT-STREAM ORDER (= true paint order /
        // z), which stext discards. We capture per glyph: exact size + horizontal scale (from the
        // render matrix × ctm) AND a paint index z. Vectors/images also get a z + bbox so we can sort
        // every object by stacking order later (needed to keep overlaps right when editing).
        const metricsMap = new Map()
        const vecZ = []
        const imgZ = []
        const textOrigin = {} // textSeq → [x, y] device origin of the first glyph (to locate its show op)
        let seq = 0 // paint order (all ops) — for vector/image stacking
        let textSeq = 0 // TEXT-only order — matches Tm order in the stream, so move targets the right fragment
        const concat = (A, B) => [
          A[0] * B[0] + A[1] * B[2],
          A[0] * B[1] + A[1] * B[3],
          A[2] * B[0] + A[3] * B[2],
          A[2] * B[1] + A[3] * B[3],
          A[4] * B[0] + A[5] * B[2] + B[4],
          A[4] * B[1] + A[5] * B[3] + B[5],
        ]
        const pathZ = (path, stroke, ctm) => {
          try {
            const b = path.getBounds(stroke, ctm)
            vecZ.push({ cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, z: ++seq })
          } catch (_) {
            seq++
          }
        }
        let dev = null
        try {
          dev = new mupdf.Device({
            fillText(text, ctm) {
              const paintZ = ++seq // q..Q block index (paint order, all ops) — move wraps this block
              const z = ++textSeq // text-only → Tm order
              let first = true
              text.walk({
                showGlyph(font, trm) {
                  const m = concat(trm, ctm)
                  if (first) { first = false; textOrigin[z] = [m[4], m[5]] } // for show-op matching
                  const vert = Math.hypot(m[2], m[3])
                  const horiz = Math.hypot(m[0], m[1])
                  metricsMap.set(Math.round(m[4]) + ',' + Math.round(m[5]), { size: vert, hScale: vert > 0 ? horiz / vert : 1, z, paintZ })
                },
              })
            },
            fillPath(path, evenOdd, ctm) {
              pathZ(path, null, ctm)
            },
            strokePath(path, stroke, ctm) {
              pathZ(path, stroke, ctm)
            },
            fillImage(image, ctm) {
              // image fills a unit square transformed by ctm
              imgZ.push({ cx: ctm[4] + ctm[0] / 2, cy: ctm[5] + ctm[3] / 2, z: ++seq })
            },
            fillShade() {
              seq++
            },
          })
          page.run(dev, mupdf.Matrix.identity)
        } catch (_) {
          // Device unavailable — sizes fall back to stext, z stays undefined
        } finally {
          dev?.close?.()
        }
        // Map each text paint (textSeq) to its exact stream show-operator index (1-based, = findTextShows
        // order) by matching device origins. Robust even when paint order ≠ page-content order (XObjects).
        const z2show = {}
        try {
          const H = bounds[3] - bounds[1]
          const showPos = textShowPositions(maskStreamOperands(readPageContent(doc.findPage(params.pageIndex)))).map(([x, y]) => [x, H - y])
          for (const z in textOrigin) {
            const [ox, oy] = textOrigin[z]
            let best = 0
            let bd = Infinity
            for (let k = 0; k < showPos.length; k++) {
              const d = (showPos[k][0] - ox) ** 2 + (showPos[k][1] - oy) ** 2
              if (d < bd) { bd = d; best = k + 1 }
            }
            if (best) z2show[z] = best
          }
        } catch (_) {
          // parser failed — editing falls back to raw textSeq (fragmentZ)
        }
        const exactAt = (ox, oy) => metricsMap.get(Math.round(ox) + ',' + Math.round(oy))
        // nearest paint-order z for a rect, by centre distance
        const nearestZ = (list, r) => {
          const cx = r.x + r.width / 2
          const cy = r.y + r.height / 2
          let best = null
          let bd = Infinity
          for (const e of list) {
            const d = (e.cx - cx) ** 2 + (e.cy - cy) ** 2
            if (d < bd) {
              bd = d
              best = e
            }
          }
          return best ? best.z : undefined
        }

        // Pass A — text blocks → lines → chars (style + exact size + baseline)
        const blocks = []
        let docLineSpacing = null
        let stextT = null
        try {
          stextT = page.toStructuredText('preserve-whitespace')
          const rawBlocks = []
          let curB = null
          let curL = null
          stextT.walk({
            beginTextBlock(bbox) {
              curB = { ...toRect(bbox), lines: [] }
              rawBlocks.push(curB)
            },
            beginLine(bbox) {
              curL = { ...toRect(bbox), chars: [] }
              if (curB) curB.lines.push(curL)
            },
            onChar(c, origin, font, size, quad, color) {
              if (!curL) return
              const b = quadBounds(quad)
              const ex = exactAt(origin[0], origin[1])
              curL.chars.push({
                c,
                fontName: font.getName(),
                size: ex ? ex.size : size,
                hScale: ex ? ex.hScale : 1,
                bold: font.isBold(),
                italic: font.isItalic(),
                serif: font.isSerif(),
                mono: font.isMono(),
                color: colorToHex(color),
                z: ex ? ex.z : undefined,
                paintZ: ex ? ex.paintZ : undefined,
                ox: origin[0],
                oy: origin[1],
                x0: b.x0,
                y0: b.y0,
                x1: b.x1,
                y1: b.y1,
              })
            },
            endLine() {
              curL = null
            },
            endTextBlock() {
              curB = null
            },
          })
          for (const rb of rawBlocks) {
            const blk = buildBlock(rb)
            if (blk) blocks.push(...splitTableBlock(blk)) // table rows → one object per cell
          }
          docLineSpacing = documentLineSpacing(blocks)
          computeParagraphSpacing(blocks, docLineSpacing)
        } finally {
          stextT?.destroy()
        }

        // Pass B — images + vectors (frames + underline detection)
        const images = []
        const vectors = []
        let stextV = null
        try {
          stextV = page.toStructuredText('preserve-images,vectors')
          stextV.walk({
            onImageBlock(bbox) {
              const r = toRect(bbox)
              if (r.width > 0.5 && r.height > 0.5) {
                r.z = nearestZ(imgZ, r)
                images.push(r)
              }
            },
            onVector(bbox, flags) {
              const r = toRect(bbox)
              if (r.width * r.height > 0.9 * pageArea) return
              r.stroked = !!flags.isStroked
              r.rectangle = !!flags.isRectangle
              r.z = nearestZ(vecZ, r)
              vectors.push(r)
            },
          })
        } finally {
          stextV?.destroy()
        }
        markUnderlines(blocks, vectors)

        const fontResources = extractFontResources(doc)
        // relabel runs from generic stext ids (CIDFont+F2) to real names (Arial) via BaseFont
        const nameMap = new Map()
        for (const fr of fontResources) if (fr.baseFont) nameMap.set(fr.baseFont, fr.name)
        if (nameMap.size) {
          for (const b of blocks) for (const ln of b.lines) for (const r of ln.runs) {
            const real = nameMap.get(r.fontName)
            if (real) r.fontName = real
          }
        }
        const palette = collectPalette(blocks)

        // Objects = individual TEXT pieces (runs), plus images/vectors. Each text object is one run
        // with its own stream fragment(s); move/select work per-piece (or grouped via marquee). Block
        // grouping is dropped for now. id = type prefix + running index → unique React key.
        const textObjs = []
        for (const b of blocks) {
          for (const ln of b.lines) {
            for (const r of ln.runs) {
              if (!r.text.trim()) continue
              const fragmentZ = r.zs && r.zs.length ? [...new Set(r.zs)] : r.z != null ? [r.z] : []
              const paintZs = r.paintZs && r.paintZs.length ? [...new Set(r.paintZs)] : []
              const showZs = [...new Set(fragmentZ.map((z) => z2show[z]).filter(Boolean))] // exact show-op indices
              textObjs.push({
                type: 'text',
                fk: paintZs.join(','), // same q..Q block → can't be moved in parts → one object
                x: r.bbox.x,
                y: r.bbox.y,
                width: r.bbox.width,
                height: r.bbox.height,
                fragmentZ,
                showZs,
                paintZs,
                lines: [{ x: r.bbox.x, y: r.bbox.y, width: r.bbox.width, height: r.bbox.height, baseline: ln.baseline, runs: [r] }],
                align: b.align,
                lineSpacing: b.lineSpacing,
                paragraphSpacing: b.paragraphSpacing,
              })
            }
          }
        }
        // merge pieces that live in the SAME stream fragment(s) — one Tj can't be moved in parts, so
        // they become one object (e.g. "Quantity … Rate" packed into a single Tj with wide spacing)
        const byFk = new Map()
        const objects = []
        for (const o of textObjs) {
          const m = o.fk ? byFk.get(o.fk) : null
          if (m) {
            const x1 = Math.max(m.x + m.width, o.x + o.width)
            const y1 = Math.max(m.y + m.height, o.y + o.height)
            m.x = Math.min(m.x, o.x)
            m.y = Math.min(m.y, o.y)
            m.width = x1 - m.x
            m.height = y1 - m.y
            m.lines.push(...o.lines)
            m.showZs = [...new Set([...(m.showZs || []), ...(o.showZs || [])])]
          } else {
            if (o.fk) byFk.set(o.fk, o)
            objects.push(o)
          }
        }
        objects.forEach((o, i) => {
          o.id = 't' + i
          delete o.fk
        })
        for (const im of images)
          objects.push({ id: 'i' + objects.length, type: 'image', x: im.x, y: im.y, width: im.width, height: im.height, fragmentZ: [], paintZs: im.z != null ? [im.z] : [] })
        for (const v of vectors)
          objects.push({ id: 'v' + objects.length, type: 'vector', x: v.x, y: v.y, width: v.width, height: v.height, fragmentZ: [], paintZs: v.z != null ? [v.z] : [] })

        self.postMessage({
          id,
          result: {
            objects,
            fonts: fontResources.length ? fontResources : palette.fonts,
            colors: palette.colors,
            docLineSpacing,
          },
        })
      } finally {
        page.destroy()
      }
    } else if (type === 'redact') {
      // Delete objects from the working copy: cover each rect with a Redact annotation, apply (which
      // removes the underlying content), then re-render the page. Edits the in-memory doc only.
      if (!doc) throw new Error('no document open')
      pushUndo() // snapshot before mutating the working copy
      const page = doc.loadPage(params.pageIndex)
      try {
        for (const r of params.rects) {
          const annot = page.createAnnotation('Redact')
          annot.setRect([r.x, r.y, r.x + r.width, r.y + r.height])
        }
        // remove ONLY the kind of object being deleted; leave the background/plate intact.
        // text always removed; images/vectors removed only if such an object is in the selection.
        const hasImg = params.rects.some((r) => r.type === 'image')
        const hasVec = params.rects.some((r) => r.type === 'vector')
        page.applyRedactions(false, hasImg ? 1 : 0, hasVec ? 2 : 0, 0) // (no black box, image, line-art, text)
        const m = mupdf.Matrix.scale(params.scale, params.scale)
        const pix = page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false)
        const png = pix.asPNG()
        const w = pix.getWidth()
        const h = pix.getHeight()
        pix.destroy()
        const buf = new Uint8Array(png).buffer
        self.postMessage({ id, result: { png: buf, width: w / params.scale, height: h / params.scale } }, [buf])
      } finally {
        page.destroy()
      }
    } else if (type === 'moveStart') {
      // Begin a real-time move: snapshot for undo, capture the BASELINE content stream. moveApply always
      // works from this baseline + the full drag delta (latest-wins), so skipped frames never accumulate
      // error. The move targets q..Q blocks by index, so no per-fragment CTM is needed here.
      if (!doc) throw new Error('no document open')
      pushUndo()
      const cs = readPageContent(doc.findPage(params.pageIndex))
      moveBaseline = { cs, pageIndex: params.pageIndex }
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'moveApply') {
      // Apply the full drag delta to the baseline stream and re-render (no undo snapshot here).
      // Universal move: wrap the object's whole `q … Q` block in a `cm` translation so its content,
      // its clip path AND any type (text/vector/image) all shift together. Device delta → page cm:
      // x stays, y flips (device-down vs page-up) → `1 0 0 1 dx -dy cm`.
      if (!moveBaseline) throw new Error('no move in progress')
      const shiftByPaint = {}
      for (const it of params.items) shiftByPaint[it.z] = { dx: it.dx, dy: it.dy }
      const masked = maskStreamOperands(moveBaseline.cs)
      const blocks = topLevelQBlocks(masked)
      const scales = blockBaseScales(masked)
      // splice right-to-left so earlier offsets stay valid; paintZ is 1-based → block index paintZ-1.
      // Divide the device drag delta by the block's enclosing scale so the on-screen move is exact.
      let cs = moveBaseline.cs
      let wrapped = 0
      const targets = Object.keys(shiftByPaint)
        .map(Number)
        .filter((p) => blocks[p - 1])
        .sort((a, b) => b - a)
      for (const p of targets) {
        const [s, e] = blocks[p - 1]
        const [a, d] = scales[p - 1] || [1, 1]
        const { dx, dy } = shiftByPaint[p]
        const tx = dx / a
        const ty = dy / d
        cs = cs.slice(0, s) + `q 1 0 0 1 ${tx.toFixed(4)} ${ty.toFixed(4)} cm\n` + cs.slice(s, e) + `\nQ` + cs.slice(e)
        wrapped++
      }
      self.postMessage({ log: `moveApply: requested ${Object.keys(shiftByPaint).length}, wrapped ${wrapped}, q-blocks ${blocks.length}` })
      const r = renderPageWrite(doc.findPage(moveBaseline.pageIndex), cs, moveBaseline.pageIndex, params.scale)
      self.postMessage({ id, result: r }, [r.png])
    } else if (type === 'moveEnd') {
      moveBaseline = null
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'editText') {
      // Replace a text object's content/font/size/colour in place (discrete edit, not a drag).
      if (!doc) throw new Error('no document open')
      pushUndo()
      const rec = ensureEditFont(params.pageIndex, params.fontKey, params.fontBytes)
      const pageObj = doc.findPage(params.pageIndex)
      const cs = readPageContent(pageObj)
      const shows = findTextShows(maskStreamOperands(cs))
      const sh = shows[params.textZ - 1]
      if (!sh) throw new Error(`edit target not found (textZ ${params.textZ} of ${shows.length})`)
      const [os, oe] = sh
      const orig = tfBefore(cs, os)
      const tf = orig.size * (params.origSize > 0 && params.size > 0 ? params.size / params.origSize : 1)
      let spaceUnits = 250
      try {
        const w = rec.font.advanceGlyph(rec.font.encodeCharacter(32), 0)
        if (w > 0) spaceUnits = w * 1000
      } catch (_) {
        // font without a space glyph — keep the 0.25em default
      }
      // column gaps (big kernings) in the ORIGINAL operand become real spaces so columns stay put
      const segs = String(params.text || '').split('\n')
      const gaps = columnGaps(cs.slice(os, oe))
      let joined
      if (gaps.length && segs.length === gaps.length + 1) {
        const unit = spaceUnits > 0 ? spaceUnits : 250
        joined = ''
        segs.forEach((str, i) => {
          joined += str
          if (i < gaps.length) joined += ' '.repeat(Math.max(1, Math.round(Math.abs(gaps[i]) / unit)))
        })
      } else joined = segs.join(' ')
      const rgb = hexToRgb(params.color).map((c) => Math.round(c * 1000) / 1000)
      const repl = `${rgb.join(' ')} rg /${rec.name} ${tf.toFixed(4)} Tf <${encodeGlyphs(rec.font, joined)}> Tj\n/${orig.font} ${orig.size} Tf`
      const r = renderPageWrite(pageObj, cs.slice(0, os) + repl + cs.slice(oe), params.pageIndex, params.scale)
      self.postMessage({ id, result: r }, [r.png])
    } else if (type === 'editBegin') {
      // Open an inline editor: stash the ORIGINAL stream, blank the block's glyphs so the underlying
      // PDF text disappears (the HTML editor draws in its place, 1:1), re-render the page.
      if (!doc) throw new Error('no document open')
      const pageObj = doc.findPage(params.pageIndex)
      const cs = readPageContent(pageObj)
      editBaseline = { cs, pageIndex: params.pageIndex }
      const shows = findTextShows(maskStreamOperands(cs))
      const zs = (params.textZs || []).filter((z) => shows[z - 1]).sort((a, b) => b - a) // splice right→left
      if (!zs.length) throw new Error(`edit target not found (textZs ${JSON.stringify(params.textZs)} of ${shows.length})`)
      let out = cs
      for (const z of zs) {
        const [os, oe] = shows[z - 1]
        out = out.slice(0, os) + '<> Tj' + out.slice(oe) // blank the glyphs, keep position
      }
      const r = renderPageWrite(pageObj, out, params.pageIndex, params.scale)
      self.postMessage({ id, result: r }, [r.png])
    } else if (type === 'editCancel') {
      // Abort the inline edit: restore the original stream untouched.
      if (!doc || !editBaseline) throw new Error('no edit in progress')
      const pageObj = doc.findPage(editBaseline.pageIndex)
      const r = renderPageWrite(pageObj, editBaseline.cs, editBaseline.pageIndex, params.scale)
      editBaseline = null
      self.postMessage({ id, result: r }, [r.png])
    } else if (type === 'editCommit') {
      // Rebuild the block from the editor's styled runs. Each run gets its own embedded font, size
      // (scaled from the block's original Tf) and colour; consecutive Tj auto-advance so runs flow
      // inline on the block's baseline. Restores the original first so undo returns the true original.
      if (!doc || !editBaseline) throw new Error('no edit in progress')
      const cs0 = editBaseline.cs
      const pageIndex = editBaseline.pageIndex
      const pageObj = doc.findPage(pageIndex)
      // original back in place, then snapshot for undo
      writePageContent(pageObj, cs0)
      pushUndo()
      const shows = findTextShows(maskStreamOperands(cs0))
      const zs = (params.textZs || []).filter((z) => shows[z - 1]).sort((a, b) => a - b)
      if (!zs.length) throw new Error(`edit target not found (textZs ${JSON.stringify(params.textZs)} of ${shows.length})`)
      const primary = zs[0] // the first show op becomes the new (styled) text; the rest are blanked
      const orig = tfBefore(cs0, shows[primary - 1][0]) // font/size to scale from and restore afterwards
      const parts = []
      for (const run of params.runs || []) {
        const rec = ensureEditFont(pageIndex, run.fontKey, run.fontBytes)
        const tf = orig.size * (run.origSize > 0 && run.size > 0 ? run.size / run.origSize : 1)
        const rgb = hexToRgb(run.color).map((c) => Math.round(c * 1000) / 1000)
        parts.push(`${rgb.join(' ')} rg /${rec.name} ${tf.toFixed(4)} Tf <${encodeGlyphs(rec.font, run.text)}> Tj`)
      }
      // runs set their own colour/font/size and flow inline; restore the original Tf so later shows in
      // the same text object keep their font. Splice right→left so earlier offsets stay valid.
      const runsSeq = (parts.join('\n') || '<> Tj') + `\n/${orig.font} ${orig.size} Tf`
      let outCs = cs0
      for (const z of [...zs].sort((a, b) => b - a)) {
        const [os, oe] = shows[z - 1]
        outCs = outCs.slice(0, os) + (z === primary ? runsSeq : '<> Tj') + outCs.slice(oe)
      }
      const r = renderPageWrite(pageObj, outCs, pageIndex, params.scale)
      editBaseline = null
      self.postMessage({ id, result: r }, [r.png])
    } else if (type === 'getFonts') {
      // embedded TrueType fonts (bytes) so the renderer can @font-face them for 1:1 editing
      if (!doc) throw new Error('no document open')
      const fonts = collectEmbeddedFonts()
      self.postMessage({ id, result: { fonts } }, fonts.map((f) => f.bytes))
    } else if (type === 'undo') {
      if (undoStack.length) {
        const bytes = undoStack.pop()
        doc?.destroy?.()
        doc = mupdf.Document.openDocument(bytes, 'application/pdf')
        embeddedFonts = {} // refs pointed into the replaced doc
        editBaseline = null
        self.postMessage({ id, result: { undone: true, left: undoStack.length } })
      } else {
        self.postMessage({ id, result: { undone: false, left: 0 } })
      }
    } else if (type === 'close') {
      doc?.destroy?.()
      doc = null
      undoStack = []
      embeddedFonts = {}
      editBaseline = null
      self.postMessage({ id, result: null })
    } else {
      throw new Error('unknown request: ' + type)
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) })
  }
}
