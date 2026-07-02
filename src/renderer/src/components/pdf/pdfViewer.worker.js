// MuPDF-WASM worker. Two outputs per page:
//  • image — the page rastered to PNG (toPixmap): the exact visual (every font, graphics, rotation).
//  • model — the source of truth, normalised: palettes (fonts[], colors[]) + objects that reference
//    them by index. Text runs come from structured text; vectors, images, text colors and z-order
//    come from ONE pass with a custom Device over the page (same coordinate space, top-left origin).
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

// ---- content-stream surgery (from editor v2, proven): parse the stream into drawing UNITS with
// byte ranges + device bboxes, so coordinates can be shifted in place for move operations. ----
const dec = (u8) => new TextDecoder('latin1').decode(u8)
const enc = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b }
const matMul = (A, B) => [A[0]*B[0]+A[1]*B[2], A[0]*B[1]+A[1]*B[3], A[2]*B[0]+A[3]*B[2], A[2]*B[1]+A[3]*B[3], A[4]*B[0]+A[5]*B[2]+B[4], A[4]*B[1]+A[5]*B[3]+B[5]]

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

// page content: 0 = the page /Contents (joined); else a form XObject by object number
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

const VIS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*'])

// Parse one stream into drawing units: { type: text|path|image, stream, start, end, bbox (device,
// top-left), sa, sd (ctm scale at the unit) }.
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
    else if (t === 'n') { start = end; reset() } // clip finaliser (re W n): keep clip paths OUT of paint units so a move never shifts a clip
    else if (t === 'Tj' || t === 'TJ' || t === "'" || t === '"') { const d = dev(tm[4], tm[5]); if (!tPos) tPos = d; else { x0 = Math.min(x0, d[0]); x1 = Math.max(x1, d[0]) } }
    else if (t === 'ET') { if (tPos) { const h = (fontSize * Math.abs(ctm[0])) || 10; units.push({ type: 'text', stream: streamNum, start, end, bbox: [Math.min(x0, tPos[0]), tPos[1] - h * 0.82, Math.max(x1, tPos[0]) + h * 0.6, tPos[1] + h * 0.22], sa: ctm[0] || 1, sd: ctm[3] || 1 }) } start = end; reset() }
    else if (VIS.has(t)) { if (hasP) units.push({ type: 'path', stream: streamNum, start, end, bbox: [x0, H - y1, x1, H - y0], sa: ctm[0] || 1, sd: ctm[3] || 1 }); start = end; reset() }
    else if (t === 'Do') { const cx = ctm[4], cy = ctm[5]; units.push({ type: 'image', stream: streamNum, start, end, bbox: [Math.min(cx, cx + ctm[0] + ctm[2]), H - Math.max(cy, cy + ctm[1] + ctm[3]), Math.max(cx, cx + ctm[0] + ctm[2]), H - Math.min(cy, cy + ctm[1] + ctm[3])], sa: ctm[0] || 1, sd: ctm[3] || 1, name: pend }); start = end; reset() }
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

// raster image at the given scale — the exact visual
function renderImage(pageIndex, scale) {
  const page = doc.loadPage(pageIndex)
  try {
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
    const png = pix.asPNG(); const w = pix.getWidth(), h = pix.getHeight(); pix.destroy()
    return { png: new Uint8Array(png).buffer, width: w / scale, height: h / scale }
  } finally { page.destroy() }
}

const validRect = (b) => Array.isArray(b) && b.every((v) => Number.isFinite(v) && Math.abs(v) < 1e7) && b[2] >= b[0] && b[3] >= b[1]

// ONE custom-Device pass over the page: vectors (with color+z), images (bbox from ctm + z) and text
// spans (ink bbox + color + z, later matched to the stext runs). Coordinates match stext (top-left).
function scanDevice(page, W, H) {
  const vectors = [], images = [], texts = []
  let z = 0
  const pageArea = W * H
  const pushVector = (kind, b, color) => {
    if (!validRect(b)) return
    const w = b[2] - b[0], h = b[3] - b[1]
    if (w * h > pageArea * 0.7) return // full-page background fills are not selectable art
    if (w < 0.5 && h < 0.5) return // sub-pixel noise
    vectors.push({ z: z++, kind, bbox: { x: n2(b[0]), y: n2(b[1]), w: n2(w), h: n2(h) }, color: colorHex(color) })
  }
  const pushImage = (ctm) => {
    // bbox of the unit square through ctm (handles rotation/flip)
    const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]]
    const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]]
    const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    if (!validRect(b)) return
    const w = b[2] - b[0], h = b[3] - b[1]
    if (w < 3 || h < 3) return // decorative specks
    images.push({ z: z++, bbox: { x: n2(b[0]), y: n2(b[1]), w: n2(w), h: n2(h) } })
  }
  const dev = new mupdf.Device({
    fillPath: (path, evenOdd, ctm, cs, color) => { let b = null; try { b = path.getBounds(null, ctm) } catch (_) {} pushVector('fill', b, color) },
    strokePath: (path, stroke, ctm, cs, color) => { let b = null; try { b = path.getBounds(stroke, ctm) } catch (_) {} pushVector('stroke', b, color) },
    fillImage: (image, ctm) => pushImage(ctm),
    fillImageMask: (image, ctm) => pushImage(ctm),
    fillText: (text, ctm, cs, color) => {
      let b = null; try { b = text.getBounds(null, ctm) } catch (_) {}
      if (validRect(b) && b[2] > b[0] && b[3] > b[1]) texts.push({ z: z++, bbox: b, color: colorHex(color) })
      else z++
    },
    strokeText: () => { z++ }, clipPath: () => { z++ }, clipStrokePath: () => { z++ },
    clipText: () => { z++ }, clipImageMask: () => { z++ }, ignoreText: () => { z++ },
    fillShade: () => { z++ }, popClip: () => {},
    beginMask: () => {}, endMask: () => {}, beginGroup: () => {}, endGroup: () => {},
    beginTile: () => 0, endTile: () => {}, beginLayer: () => {}, endLayer: () => {}, close: () => {}
  })
  try { page.run(dev, mupdf.Matrix.identity) } catch (e) { console.warn('[pdf worker] device scan failed:', e?.message) }
  finally { try { dev.close() } catch (_) {} try { dev.destroy() } catch (_) {} } // close before drop, or MuPDF warns "dropping unclosed device" at GC time
  return { vectors, images, texts }
}

// The model: palettes + indexed objects. Every object carries bbox (pt, top-left) and z (paint order).
function getModel(pageIndex) {
  const page = doc.loadPage(pageIndex)
  try {
    const bounds = page.getBounds()
    const W = n2(bounds[2] - bounds[0]), H = n2(bounds[3] - bounds[1])

    // palettes — objects reference them by index (f = font, c = color)
    const fonts = [], fontIdx = new Map()
    const colors = [], colorIdx = new Map()
    const fontRef = (f) => {
      const name = cleanName(f.name || '')
      const key = `${name}|${f.weight}|${f.style}`
      if (!fontIdx.has(key)) {
        fontIdx.set(key, fonts.length)
        fonts.push({ name, generic: f.family || 'sans-serif', bold: f.weight === 'bold' || /bold|black|heavy/i.test(name), italic: f.style === 'italic' || /italic|oblique/i.test(name) })
      }
      return fontIdx.get(key)
    }
    const colorRef = (hex) => {
      if (!colorIdx.has(hex)) { colorIdx.set(hex, colors.length); colors.push(hex) }
      return colorIdx.get(hex)
    }

    // text runs from structured text (preserve-spans → one run per font-run)
    const runs = []
    const stext = page.toStructuredText('preserve-spans')
    let json
    try { json = JSON.parse(stext.asJSON()) } finally { stext.destroy?.() }
    let bi = 0
    for (const b of json.blocks || []) {
      if (!Array.isArray(b.lines)) continue
      let li = 0
      for (const l of b.lines) {
        if (!l.bbox || !l.text || !l.text.trim()) continue
        const f = l.font || {}
        runs.push({
          id: `b${bi}.l${li++}`, type: 'text',
          bbox: { x: n2(l.bbox.x), y: n2(l.bbox.y), w: n2(l.bbox.w), h: n2(l.bbox.h) },
          f: fontRef(f), size: n2(f.size || l.bbox.h), c: 0, z: 0,
          x: n2(l.x ?? l.bbox.x), y: n2(l.y ?? (l.bbox.y + l.bbox.h)),
          text: l.text
        })
      }
      bi++
    }

    // device pass: vectors + images + text ink-spans (color, z)
    const scan = scanDevice(page, W, H)
    const vectors = scan.vectors.map((v, i) => ({ id: 'v' + i, type: 'vector', bbox: v.bbox, kind: v.kind, c: colorRef(v.color), z: v.z }))
    const images = scan.images.map((im, i) => ({ id: 'i' + i, type: 'image', bbox: im.bbox, z: im.z }))

    // give each run its color and z from the overlapping device text span
    colorRef('#000000') // ensure black exists (default)
    for (const r of runs) {
      const rx0 = r.bbox.x, ry0 = r.bbox.y, rx1 = rx0 + r.bbox.w, ry1 = ry0 + r.bbox.h
      let best = null, bestA = 0
      for (const t of scan.texts) {
        const ix = Math.min(rx1, t.bbox[2]) - Math.max(rx0, t.bbox[0])
        const iy = Math.min(ry1, t.bbox[3]) - Math.max(ry0, t.bbox[1])
        if (ix > 0 && iy > 0 && ix * iy > bestA) { bestA = ix * iy; best = t }
      }
      if (best) { r.c = colorRef(best.color); r.z = best.z }
    }

    tightenBboxes(page, runs) // hug the real glyphs: catch diacritics above and descenders below
    return { width: W, height: H, fonts, colors, runs, images, vectors }
  } finally { page.destroy() }
}

// Grow each run's bbox to the real ink from a 2x grayscale raster, but stop at a blank gap and cap
// the growth (~0.25em) so it catches THIS line's diacritics/descenders without swallowing neighbours.
function tightenBboxes(page, runs) {
  if (!runs.length) return
  const S = 2
  let pix
  try { pix = page.toPixmap(mupdf.Matrix.scale(S, S), mupdf.ColorSpace.DeviceGray, false) } catch { return }
  const px = pix.getPixels(), stride = pix.getStride(), pw = pix.getWidth(), ph = pix.getHeight(), nc = pix.getNumberOfComponents()
  const ink = (x0, x1, y) => {
    if (y < 0 || y >= ph) return false
    const base = y * stride
    for (let x = Math.max(0, x0); x < Math.min(pw, x1); x++) if (px[base + x * nc] < 250) return true
    return false
  }
  for (const r of runs) {
    const x0 = Math.floor(r.bbox.x * S), x1 = Math.ceil((r.bbox.x + r.bbox.w) * S)
    let top = Math.round(r.bbox.y * S), bot = Math.round((r.bbox.y + r.bbox.h) * S)
    const lim = Math.round((r.size || 10) * 0.25 * S), upLim = top - lim, dnLim = bot + lim
    while (top > 0 && top > upLim && ink(x0, x1, top - 1)) top-- // connected grow up, capped (diacritics)
    while (bot < ph && bot < dnLim && ink(x0, x1, bot)) bot++ // connected grow down, capped (descenders)
    while (top < bot && !ink(x0, x1, top)) top++ // trim blank inside
    while (bot > top && !ink(x0, x1, bot - 1)) bot--
    if (bot > top) r.bbox = { x: r.bbox.x, y: n2(top / S), w: r.bbox.w, h: n2((bot - top) / S) }
  }
  pix.destroy()
}

self.postMessage({ ready: true })
self.onmessage = (e) => {
  const { id, type, params } = e.data
  try {
    if (type === 'open') {
      doc = mupdf.Document.openDocument(new Uint8Array(params.data), 'application/pdf')
      self.postMessage({ id, result: { pageCount: doc.countPages() } })
    } else if (type === 'getModel') {
      if (!doc) throw new Error('no document open')
      self.postMessage({ id, result: getModel(params.pageIndex) })
    } else if (type === 'renderImage') {
      if (!doc) throw new Error('no document open')
      const r = renderImage(params.pageIndex, params.scale)
      self.postMessage({ id, result: r }, [r.png])
    } else if (type === 'moveObjects') {
      // shift object coordinates INSIDE the content stream: text → Tm (or the first Td), image → its
      // positioning cm, vector → path construction points. items: [{ type, bbox, dx, dy }] (dx/dy in
      // pt, screen-down positive). Each item is matched to the stream unit with the biggest overlap.
      if (!doc) throw new Error('no document open')
      const lp = doc.loadPage(params.pageIndex)
      const H = lp.getBounds()[3]; lp.destroy()
      const pageObj = doc.findPage(params.pageIndex)
      const units = collectUnits(pageObj, H)
      const typeMap = { text: 'text', image: 'image', vector: 'path' }
      // match every item to its best-overlapping unit, then dedupe: several items can share one
      // stream unit (one paint op drawing many subpaths) — shift that unit ONCE, never steal a
      // neighbouring unit for the second item
      const jobMap = new Map() // unit → {dx, dy}
      for (const it of params.items || []) {
        const want = typeMap[it.type]
        let best = null, bestA = 0
        for (const u of units) {
          if (u.type !== want) continue
          const ix = Math.min(it.bbox.x + it.bbox.w, u.bbox[2]) - Math.max(it.bbox.x, u.bbox[0])
          const iy = Math.min(it.bbox.y + it.bbox.h, u.bbox[3]) - Math.max(it.bbox.y, u.bbox[1])
          if (ix > 0 && iy > 0 && ix * iy > bestA) { bestA = ix * iy; best = u }
        }
        if (best && !jobMap.has(best)) jobMap.set(best, { dx: it.dx, dy: it.dy })
      }
      const jobs = [...jobMap.entries()].map(([u, d]) => ({ u, dx: d.dx, dy: d.dy }))
      const byStream = {}
      for (const j of jobs) (byStream[j.u.stream] = byStream[j.u.stream] || []).push(j)
      for (const sk of Object.keys(byStream)) {
        const s = Number(sk)
        let cs = readStream(pageObj, s)
        const list = byStream[sk].sort((a, b) => b.u.start - a.u.start) // right-to-left keeps byte offsets valid
        for (const { u, dx, dy } of list) {
          const seg = cs.slice(u.start, u.end)
          const de = dx / (u.sa || 1), df = -dy / (u.sd || 1)
          let edited = seg
          if (u.type === 'text') {
            const tmRe = /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+Tm/g
            if (tmRe.test(seg)) {
              edited = seg.replace(tmRe, (m, a, b, c, d, e2, f2) => `${a} ${b} ${c} ${d} ${(parseFloat(e2) + de).toFixed(3)} ${(parseFloat(f2) + df).toFixed(3)} Tm`)
            } else {
              edited = seg.replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(T[dD])\b/, (m, x, y, op) => `${(parseFloat(x) + de).toFixed(3)} ${(parseFloat(y) + df).toFixed(3)} ${op}`)
            }
            edited = edited.replace(/(^|[\s>\])])(W\*?)(\s+n\b)/g, (m, p, w, n) => p + '  ' + n) // drop the clip so moved text isn't cut
          } else if (u.type === 'image') {
            const ms = [...seg.matchAll(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+cm/g)]
            if (ms.length) {
              const m = ms[ms.length - 1] // the LAST cm before Do positions the image
              edited = seg.slice(0, m.index) + `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${(parseFloat(m[5]) + de).toFixed(3)} ${(parseFloat(m[6]) + df).toFixed(3)} cm` + seg.slice(m.index + m[0].length)
            }
          } else if (u.type === 'path') {
            edited = seg
              .replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+c\b/g, (m, x1, y1, x2, y2, x3, y3) => `${(parseFloat(x1) + de).toFixed(3)} ${(parseFloat(y1) + df).toFixed(3)} ${(parseFloat(x2) + de).toFixed(3)} ${(parseFloat(y2) + df).toFixed(3)} ${(parseFloat(x3) + de).toFixed(3)} ${(parseFloat(y3) + df).toFixed(3)} c`)
              .replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+([vy])\b/g, (m, x1, y1, x2, y2, op) => `${(parseFloat(x1) + de).toFixed(3)} ${(parseFloat(y1) + df).toFixed(3)} ${(parseFloat(x2) + de).toFixed(3)} ${(parseFloat(y2) + df).toFixed(3)} ${op}`)
              .replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+re\b/g, (m, x, y, w, h) => `${(parseFloat(x) + de).toFixed(3)} ${(parseFloat(y) + df).toFixed(3)} ${w} ${h} re`)
              .replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+([ml])\b/g, (m, x, y, op) => `${(parseFloat(x) + de).toFixed(3)} ${(parseFloat(y) + df).toFixed(3)} ${op}`)
          }
          cs = cs.slice(0, u.start) + edited + cs.slice(u.end)
        }
        writeStream(pageObj, s, cs)
      }
      self.postMessage({ id, result: { ok: true, moved: jobs.length, of: (params.items || []).length } })
    } else if (type === 'save') {
      // serialise the in-memory working copy (with all moves/deletes applied) back to PDF bytes
      if (!doc) throw new Error('no document open')
      const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array())
      self.postMessage({ id, result: { bytes: bytes.buffer } }, [bytes.buffer])
    } else if (type === 'deleteObjects') {
      // physically remove objects from the page stream via redaction, grouped by type so each pass
      // only touches its own kind (text redaction won't eat an image underneath, etc.)
      if (!doc) throw new Error('no document open')
      const page = doc.loadPage(params.pageIndex)
      try {
        const groups = { text: [], image: [], vector: [] }
        for (const it of params.items || []) if (groups[it.type]) groups[it.type].push(it.bbox)
        const apply = (boxes, imageMethod, lineArtMethod, textMethod, pad) => {
          if (!boxes.length) return
          for (const b of boxes) {
            const a = page.createAnnotation('Redact')
            a.setRect([b.x - pad, b.y - pad, b.x + b.w + pad, b.y + b.h + pad])
          }
          page.applyRedactions(false, imageMethod, lineArtMethod, textMethod)
        }
        apply(groups.text, 0, 0, 0, 0) // IMAGE_NONE, LINE_ART_NONE, TEXT_REMOVE — exact bbox (don't graze neighbours)
        apply(groups.image, 1, 0, 1, 0.2) // IMAGE_REMOVE, LINE_ART_NONE, TEXT_NONE
        apply(groups.vector, 0, 1, 1, 0.2) // IMAGE_NONE, LINE_ART_REMOVE_IF_COVERED, TEXT_NONE
        self.postMessage({ id, result: { ok: true, deleted: (params.items || []).length } })
      } finally { page.destroy() }
    } else throw new Error('unknown request: ' + type)
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) })
  }
}
