// PDF editor v2 — MuPDF-WASM worker built around an OBJECT TREE.
// Open → parse each content stream into ordered drawing UNITS (text / path / image), each with a
// stable id, device bbox and verbatim byte range. Editing shifts an object's OWN coordinates (text:
// Tm + drop its clip; image: its cm; path: its construction points) — never wraps arbitrary ranges
// (that would break q/Q balance). Saving re-serialises the working copy with saveToBuffer.
import * as mupdf from 'mupdf'

let doc = null
let undoStack = []
let moveBase = null // { streams: {num: cs}, pageIndex }
let embeddedFonts = {} // fontKey → { font, name, pages:Set }
let fontSeq = 0
let docFontCache = null

const dec = (u8) => new TextDecoder('latin1').decode(u8)
const enc = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b }
const matMul = (A, B) => [A[0]*B[0]+A[1]*B[2], A[0]*B[1]+A[1]*B[3], A[2]*B[0]+A[3]*B[2], A[2]*B[1]+A[3]*B[3], A[4]*B[0]+A[5]*B[2]+B[4], A[4]*B[1]+A[5]*B[3]+B[5]]

function pushUndo() {
  if (!doc) return
  try { undoStack.push(doc.saveToBuffer().asUint8Array()); if (undoStack.length > 20) undoStack.shift() } catch (_) {}
}

// mask string/hex operands (length-preserving) so operators glued to operands still tokenise
function mask(s) {
  const a = s.split(''); let i = 0
  while (i < a.length) { const c = a[i]
    if (c === '(') { let d = 1, j = i + 1; while (j < a.length && d > 0) { if (a[j] === '\\') { a[j] = 'X'; if (j + 1 < a.length) a[j + 1] = 'X'; j += 2; continue } if (a[j] === '(') d++; else if (a[j] === ')') { d--; if (d === 0) break } a[j] = 'X'; j++ } i = j + 1 }
    else if (c === '<') { let j = i + 1; while (j < a.length && a[j] !== '>') { a[j] = 'X'; j++ } i = j + 1 } else i++ }
  return a.join('')
}
const TOKENS = /<<|>>|\/[^\s()<>[\]{}/%]*|<[^>]*>|\([^)]*\)|[[\]]|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z]+\*?|['"]|\S/g
const isNum = (t) => /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(t)
const showRe = /\[[^\]]*\]\s*TJ|<[0-9A-Fa-f\s]*>\s*Tj|\((?:[^()\\]|\\.)*\)\s*Tj/g

// page content: 0 = the page /Contents (page.getContents joined); else a form XObject by object number
function readStream(pageObj, num) {
  if (num) return dec(doc.newIndirect(num).readStream().asUint8Array())
  const c = pageObj.get('Contents')
  if (c.isArray()) { let s = ''; for (let i = 0; i < c.length; i++) s += dec(c.get(i).readStream().asUint8Array()) + '\n'; return s }
  return dec(c.readStream().asUint8Array())
}
function writeStream(pageObj, num, cs) {
  const b = enc(cs)
  if (num) { doc.newIndirect(num).writeStream(b); return }
  const c = pageObj.get('Contents')
  if (c.isArray()) { c.get(0).writeStream(b); for (let i = 1; i < c.length; i++) c.get(i).writeStream(new Uint8Array(0)) }
  else c.writeStream(b)
}
function raster(pageIndex, scale) {
  const page = doc.loadPage(pageIndex)
  try {
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
    const png = pix.asPNG(); const w = pix.getWidth(); const h = pix.getHeight(); pix.destroy()
    return { png: new Uint8Array(png).buffer, width: w / scale, height: h / scale }
  } finally { page.destroy() }
}

const VIS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*'])

// Parse one stream into drawing units. Clip/state ops don't break a unit (so a text's clip travels
// with it). Each unit: { type, stream, start, end, bbox[x0,y0,x1,y1] device, sa, sd, name? }.
function buildUnits(cs, streamNum, H) {
  const toks = [...mask(cs).matchAll(TOKENS)]
  const units = []
  let start = 0, ctm = [1, 0, 0, 1, 0, 0]; const stk = []
  let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], L = 0, pend = null, fontSize = 0
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, hasP = false, tPos = null
  const num = []; const N = (k) => num.slice(-k).map(Number)
  const pt = (x, y) => { const dx = ctm[0]*x+ctm[2]*y+ctm[4], dy = ctm[1]*x+ctm[3]*y+ctm[5]; x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy); hasP = true }
  const reset = () => { x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity; hasP = false; tPos = null }
  const dev = (mx, my) => [ctm[0]*mx+ctm[2]*my+ctm[4], H - (ctm[1]*mx+ctm[3]*my+ctm[5])]
  for (const mt of toks) {
    const t = mt[0], end = mt.index + t.length
    if (isNum(t)) { num.push(t); continue }
    if (t[0] === '/') { pend = t.slice(1); num.length = 0; continue }
    if (t === 'q') stk.push(ctm.slice())
    else if (t === 'Q') { if (stk.length) ctm = stk.pop() }
    else if (t === 'cm') { const m = N(6); if (m.length === 6) ctm = matMul(m, ctm) }
    else if (t === 'BT') { tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0] }
    else if (t === 'Tf') { const s = N(1); if (s.length) fontSize = s[0] }
    else if (t === 'Tm') { const m = N(6); if (m.length === 6) { tlm = m.slice(); tm = m.slice() } }
    else if (t === 'Td') { const [x, y] = N(2); tlm = matMul([1, 0, 0, 1, x, y], tlm); tm = tlm.slice() }
    else if (t === 'TD') { const [x, y] = N(2); L = -y; tlm = matMul([1, 0, 0, 1, x, y], tlm); tm = tlm.slice() }
    else if (t === 'T*') { tlm = matMul([1, 0, 0, 1, 0, -L], tlm); tm = tlm.slice() }
    else if (t === 'TL') { const v = N(1); if (v.length) L = v[0] }
    else if (t === 'm' || t === 'l') { const [x, y] = N(2); pt(x, y) }
    else if (t === 'c') { const p = N(6); if (p.length === 6) { pt(p[0], p[1]); pt(p[2], p[3]); pt(p[4], p[5]) } }
    else if (t === 'v' || t === 'y') { const p = N(4); if (p.length === 4) { pt(p[0], p[1]); pt(p[2], p[3]) } }
    else if (t === 're') { const p = N(4); if (p.length === 4) { pt(p[0], p[1]); pt(p[0] + p[2], p[1] + p[3]) } }
    else if (t === 'Tj' || t === 'TJ' || t === "'" || t === '"') { const d = dev(tm[4], tm[5]); if (!tPos) tPos = d; else { x0 = Math.min(x0, d[0]); x1 = Math.max(x1, d[0]) } }
    else if (t === 'ET') { if (tPos) { const h = (fontSize * Math.abs(ctm[0])) || 10; units.push({ type: 'text', stream: streamNum, start, end, bbox: [Math.min(x0, tPos[0]), tPos[1] - h * 0.82, Math.max(x1, tPos[0]) + h * 0.6, tPos[1] + h * 0.22], sa: ctm[0] || 1, sd: ctm[3] || 1 }) } start = end; reset() }
    else if (VIS.has(t)) { if (hasP) units.push({ type: 'path', stream: streamNum, start, end, bbox: [x0, H - y1, x1, H - y0], sa: ctm[0] || 1, sd: ctm[3] || 1 }); start = end; reset() }
    else if (t === 'Do') { const cx = ctm[4], cy = ctm[5]; const w = Math.abs(ctm[0]) + Math.abs(ctm[2]), h = Math.abs(ctm[1]) + Math.abs(ctm[3]); units.push({ type: 'image', stream: streamNum, start, end, bbox: [Math.min(cx, cx + ctm[0] + ctm[2]), H - Math.max(cy, cy + ctm[1] + ctm[3]), Math.max(cx, cx + ctm[0] + ctm[2]), H - Math.min(cy, cy + ctm[1] + ctm[3])], sa: ctm[0] || 1, sd: ctm[3] || 1, name: pend }); start = end; reset() }
    num.length = 0
  }
  return units
}

// walk page + form XObjects, collecting units in every stream (device coords)
function collectUnits(pageObj, H) {
  const all = []
  const walk = (num, resources, depth) => {
    if (depth > 10) return
    const cs = readStream(pageObj, num)
    for (const u of buildUnits(cs, num, H)) all.push(u)
    // recurse into form XObjects referenced by Do
    const xo = resources && !resources.isNull() ? resources.get('XObject') : null
    if (!xo || xo.isNull()) return
    const seen = new Set()
    const doRe = /\/([A-Za-z0-9._-]+)\s+Do\b/g; let m
    while ((m = doRe.exec(cs))) { const nm = m[1]; if (seen.has(nm)) continue; seen.add(nm)
      try { const e = xo.get(nm); if (e && e.isStream && e.isStream()) { const sub = e.get('Subtype'); if (!sub.isNull() && sub.asName() === 'Form') { const fr = e.get('Resources'); walk(e.asIndirect(), !fr.isNull() ? fr : resources, depth + 1) } } } catch (_) {}
    }
  }
  walk(0, pageObj.getInheritable('Resources'), 0)
  return all
}

// ---- edit helpers ------------------------------------------------------------------------------
function ensureFont(pageIndex, key, bytes) {
  let rec = embeddedFonts[key]
  if (!rec) { const font = new mupdf.Font(key || 'EF', new Uint8Array(bytes)); rec = { font, ref: doc.addFont(font), name: 'EF' + fontSeq++, pages: new Set() }; embeddedFonts[key] = rec }
  if (!rec.pages.has(pageIndex)) { const po = doc.findPage(pageIndex); let res = po.getInheritable('Resources'); if (!res || res.isNull()) { res = doc.newDictionary(); po.put('Resources', res) } let fd = res.get('Font'); if (fd.isNull()) { fd = doc.newDictionary(); res.put('Font', fd) } fd.put(rec.name, rec.ref); rec.pages.add(pageIndex) }
  return rec
}
function encodeGlyphs(font, text) { let h = ''; for (const ch of text) h += (font.encodeCharacter(ch.codePointAt(0)) & 0xffff).toString(16).padStart(4, '0'); return h }
function sfntHasCmap(buf) { try { const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); const n = dv.getUint16(4); for (let i = 0; i < n; i++) { const r = 12 + i * 16; if (String.fromCharCode(buf[r], buf[r + 1], buf[r + 2], buf[r + 3]) === 'cmap') return true } } catch (_) {} return false }
function docFonts() {
  if (docFontCache) return docFontCache
  const out = []; let count = 0; try { count = doc.countObjects() } catch (_) { docFontCache = out; return out }
  for (let i = 1; i < count; i++) { let o; try { o = doc.newIndirect(i).resolve() } catch (_) { continue }
    if (!o || !o.isDictionary || !o.isDictionary()) continue
    let ty; try { ty = o.get('Type') } catch (_) { continue }
    if (!ty || ty.isNull() || ty.asName() !== 'Font') continue
    let d = o.get('FontDescriptor'); if (d.isNull()) { const df = o.get('DescendantFonts'); if (df.isArray() && df.length) d = df.get(0).resolve().get('FontDescriptor') }
    if (!d || d.isNull()) continue
    const ff = d.get('FontFile2'); if (ff.isNull()) continue
    let raw; try { raw = ff.readStream().asUint8Array() } catch (_) { continue }
    const bf = o.get('BaseFont'); const name = (bf.isNull() ? '' : bf.asName()).replace(/^[A-Z]{6}\+/, '')
    out.push({ name, bytes: raw, hasCmap: sfntHasCmap(raw) })
  }
  docFontCache = out; return out
}
function origFontBytes(name) { if (!name) return null; const nn = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); const n = nn(name); const hit = docFonts().find((f) => { const fn = nn(f.name); return fn === n || fn.includes(n) || n.includes(fn) }); return hit ? new Uint8Array(hit.bytes) : null }

// ---- messages ----------------------------------------------------------------------------------
self.postMessage({ ready: true })
self.onmessage = (e) => {
  const { id, type, params } = e.data
  try {
    if (type === 'open') {
      doc = mupdf.Document.openDocument(new Uint8Array(params.data), 'application/pdf')
      undoStack = []; embeddedFonts = {}; fontSeq = 0; docFontCache = null; moveBase = null
      self.postMessage({ id, result: { pageCount: doc.countPages() } })
    } else if (type === 'renderPage') {
      const r = raster(params.pageIndex, params.scale)
      self.postMessage({ id, result: r }, [r.png])
    } else if (type === 'getObjects') {
      // object tree: each object = id, type, device bbox (PDF points), byte-range address, + text info
      const page = doc.loadPage(params.pageIndex)
      const H = page.getBounds()[3]; page.destroy()
      const pageObj = doc.findPage(params.pageIndex)
      const units = collectUnits(pageObj, H)
      // text content/style per unit via structured text, matched by position
      const lines = []
      let stx = null
      try {
        stx = doc.loadPage(params.pageIndex).toStructuredText('preserve-whitespace')
        const j = JSON.parse(stx.asJSON())
        for (const b of j.blocks || []) for (const l of b.lines || []) {
          const spans = l.spans || []
          const text = l.text || spans.map((s) => (s.chars || []).map((c) => c.c).join('')).join('')
          const f = (spans[0] && spans[0].font) || {}
          lines.push({ text, x: l.bbox.x, y: l.bbox.y, cx: l.bbox.x + l.bbox.w / 2, cy: l.bbox.y + l.bbox.h / 2, size: f.size || 0, color: '#000000' })
        }
      } catch (_) {} finally { stx?.destroy?.() }
      const objects = units.map((u, i) => {
        const o = { id: (u.type[0]) + i, type: u.type, x: u.bbox[0], y: u.bbox[1], width: u.bbox[2] - u.bbox[0], height: u.bbox[3] - u.bbox[1], addr: { stream: u.stream, start: u.start, end: u.end, sa: u.sa, sd: u.sd, type: u.type }, name: u.name }
        if (u.type === 'text') { const cx = (u.bbox[0] + u.bbox[2]) / 2, cy = (u.bbox[1] + u.bbox[3]) / 2; let best = null, bd = Infinity; for (const ln of lines) { const d = (ln.cx - cx) ** 2 + (ln.cy - cy) ** 2; if (d < bd) { bd = d; best = ln } } if (best && bd < 400) { o.text = best.text; o.size = best.size; o.color = best.color } }
        return o
      })
      self.postMessage({ id, result: { objects, pageHeight: H } })
    } else if (type === 'moveStart') {
      pushUndo(); moveBase = { streams: {}, pageIndex: params.pageIndex }
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'moveApply') {
      if (!moveBase) throw new Error('no move in progress')
      const pageObj = doc.findPage(moveBase.pageIndex)
      const byStream = {}
      for (const it of params.items) { const s = it.addr.stream || 0; if (moveBase.streams[s] === undefined) moveBase.streams[s] = readStream(pageObj, s); (byStream[s] = byStream[s] || []).push(it) }
      for (const sk of Object.keys(byStream)) {
        const s = Number(sk); let cs = moveBase.streams[s]
        // apply edits right-to-left by unit start so byte offsets stay valid
        const items = byStream[s].slice().sort((a, b) => b.addr.start - a.addr.start)
        for (const it of items) {
          const { start, end, sa, sd, type: ty } = it.addr
          const seg = cs.slice(start, end)
          const de = it.dx / (sa || 1), df = -it.dy / (sd || 1)
          let edited = seg
          if (ty === 'text') {
            // shift every Tm; drop the clip (W/W*) so moved text isn't cut by its original region
            edited = seg.replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+Tm/g, (m, a, b, c, d, ee, ff) => `${a} ${b} ${c} ${d} ${(parseFloat(ee) + de).toFixed(3)} ${(parseFloat(ff) + df).toFixed(3)} Tm`)
              .replace(/(^|[\s>\])])(W\*?)(\s+n\b)/g, (m, p, w, n) => p + '  ' + n)
          } else if (ty === 'image') {
            // shift the LAST cm before the Do (positions the image)
            let last = -1; const cmRe = /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+cm/g; let mm; const ms = []
            while ((mm = cmRe.exec(seg))) ms.push(mm)
            if (ms.length) { const m = ms[ms.length - 1]; last = m.index; const ne = parseFloat(m[5]) + it.dx / (sa || 1), nf = parseFloat(m[6]) + it.dy / (sd || 1); edited = seg.slice(0, m.index) + `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${ne.toFixed(3)} ${nf.toFixed(3)} cm` + seg.slice(m.index + m[0].length) }
          } else if (ty === 'path') {
            // shift construction points: re (x y), m/l (x y), c/v/y — add (de,df) to each coordinate pair
            edited = seg
              .replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+re/g, (m, x, y, w, h) => `${(parseFloat(x) + de).toFixed(3)} ${(parseFloat(y) - df).toFixed(3)} ${w} ${h} re`)
              .replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+([ml])\b/g, (m, x, y, op) => `${(parseFloat(x) + de).toFixed(3)} ${(parseFloat(y) - df).toFixed(3)} ${op}`)
          }
          cs = cs.slice(0, start) + edited + cs.slice(end)
        }
        writeStream(pageObj, s, cs)
      }
      self.postMessage({ id, result: raster(moveBase.pageIndex, params.scale) }, [])
    } else if (type === 'moveEnd') {
      moveBase = null; self.postMessage({ id, result: { ok: true } })
    } else if (type === 'editText') {
      // rewrite an object's text: replace its show operators with new glyphs in the chosen font/size/colour
      pushUndo()
      const pageObj = doc.findPage(params.pageIndex)
      const a = params.addr
      const emb = origFontBytes(params.fontName)
      const rec = emb ? ensureFont(params.pageIndex, 'emb:' + params.fontName, emb) : ensureFont(params.pageIndex, params.fontKey, params.fontBytes)
      const cs = readStream(pageObj, a.stream)
      const seg = cs.slice(a.start, a.end)
      const tf = (seg.match(/\/\S+\s+(-?[0-9.]+)\s+Tf/) || [])[1] || '12'
      const rgb = (params.color || '#000000').replace('#', '').match(/../g).map((h) => (parseInt(h, 16) / 255).toFixed(3))
      let first = true
      const edited = seg.replace(showRe, () => { if (!first) return '<> Tj'; first = false; return `${rgb.join(' ')} rg /${rec.name} ${tf} Tf <${encodeGlyphs(rec.font, params.text || '')}> Tj` })
      writeStream(pageObj, a.stream, cs.slice(0, a.start) + edited + cs.slice(a.end))
      self.postMessage({ id, result: raster(params.pageIndex, params.scale) }, [])
    } else if (type === 'deleteObject') {
      pushUndo()
      const page = doc.loadPage(params.pageIndex)
      try { const r = params.rect; const an = page.createAnnotation('Redact'); an.setRect([r.x, r.y, r.x + r.width, r.y + r.height]); page.applyRedactions(false, 0, params.kind === 'image' ? 1 : 0, 0) } finally { page.destroy() }
      self.postMessage({ id, result: raster(params.pageIndex, params.scale) }, [])
    } else if (type === 'save') {
      const bytes = new Uint8Array(doc.saveToBuffer().asUint8Array())
      self.postMessage({ id, result: { bytes: bytes.buffer } }, [bytes.buffer])
    } else if (type === 'undo') {
      if (undoStack.length) { const b = undoStack.pop(); doc?.destroy?.(); doc = mupdf.Document.openDocument(b, 'application/pdf'); embeddedFonts = {}; docFontCache = null; moveBase = null; self.postMessage({ id, result: { undone: true, left: undoStack.length } }) }
      else self.postMessage({ id, result: { undone: false } })
    } else if (type === 'getFonts') {
      const fonts = docFonts().filter((f) => f.hasCmap).map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes).buffer }))
      self.postMessage({ id, result: { fonts } }, fonts.map((f) => f.bytes))
    } else if (type === 'close') {
      doc?.destroy?.(); doc = null; undoStack = []; embeddedFonts = {}; docFontCache = null; moveBase = null
      self.postMessage({ id, result: null })
    } else throw new Error('unknown request: ' + type)
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) })
  }
}
