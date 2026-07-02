// MuPDF-WASM worker. Two outputs per page:
//  • image — the page rastered to PNG (toPixmap): the exact visual (every font, graphics, rotation).
//  • model — the source of truth, normalised: palettes (fonts[], colors[]) + objects that reference
//    them by index. Text runs come from structured text; vectors, images, text colors and z-order
//    come from ONE pass with a custom Device over the page (same coordinate space, top-left origin).
import * as mupdf from 'mupdf'

let doc = null
let insFonts = {} // fontKey → { font, ref, name, pages:Set } — fonts embedded for inserted text
let insFontSeq = 0

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
    else if (c === '<') { let j = i + 1; while (j < a.length && a[j] !== '>') { a[j] = 'X'; j++ } i = j + 1 }
    else if (c === '%') { let j = i; while (j < a.length && a[j] !== '\n' && a[j] !== '\r') { a[j] = ' '; j++ } i = j } // comments (incl. our %EFR metadata) must not feed the tokenizer
    else i++ }
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
  let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], L = 0, pend = null, fontSize = 0, tc = 0, fontRes = null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, hasP = false, tPos = null
  let cmPre = null // ctm scale just BEFORE the unit's last cm — moving an image edits that cm's e/f, which live in the OUTER space (the cm itself carries the image size!)
  let shows = [] // every show op in the current text unit: { start (operand), end, px, py } — lets a delete blank ONE show surgically
  let operandStart = null, arrOpen = null
  let startCtm = ctm.slice() // CTM at the unit's START — a wrap goes AROUND the whole unit, so its conjugation must use this, not the paint-time ctm (which already includes the unit's own cm)
  let unitDirty = false // has the current unit range seen any real content yet?
  const num = []; const N = (k) => num.slice(-k).map(Number)
  const pt = (x, y) => { const dx = ctm[0]*x+ctm[2]*y+ctm[4], dy = ctm[1]*x+ctm[3]*y+ctm[5]; x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy); hasP = true }
  const reset = () => { x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity; hasP = false; tPos = null; cmPre = null; startCtm = ctm.slice(); unitDirty = false }
  const dev = (mx, my) => [ctm[0]*mx+ctm[2]*my+ctm[4], H - (ctm[1]*mx+ctm[3]*my+ctm[5])]
  for (const mt of toks) {
    const t = mt[0], end = mt.index + t.length
    if (t !== 'Q') unitDirty = true
    if (isNum(t)) { num.push(t); continue }
    // track the show operand's byte range: a string/hex token, or a whole [...] array for TJ
    if (t[0] === '(' || t[0] === '<') { if (arrOpen === null) operandStart = mt.index }
    else if (t === '[') { arrOpen = mt.index; operandStart = mt.index }
    else if (t === ']') arrOpen = null
    if (t[0] === '/') { pend = t.slice(1); num.length = 0; continue }
    if (t === 'q') stk.push(ctm.slice())
    else if (t === 'Q') {
      if (stk.length) ctm = stk.pop()
      // a Q before any unit content closes an OUTER block — it's not part of this unit. Skip the
      // start past it and re-pin startCtm, or an in-place edit would blank it (balanceSeg) leaving
      // the outer block open forever → the whole page flips/shifts.
      if (!unitDirty) { start = end; startCtm = ctm.slice() }
    }
    else if (t === 'cm') { const m = N(6); if (m.length === 6) { cmPre = { sa: ctm[0] || 1, sd: ctm[3] || 1 }; ctm = matMul(m, ctm) } }
    else if (t === 'BT') { tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0] }
    else if (t === 'Tf') { const s = N(1); if (s.length) fontSize = s[0]; fontRes = pend }
    else if (t === 'Tc') { const v = N(1); if (v.length) tc = v[0] } // letter spacing — read back into the model as run.ls
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
    else if (t === 'Tj' || t === 'TJ' || t === "'" || t === '"') {
      const d = dev(tm[4], tm[5])
      shows.push({ start: operandStart !== null ? operandStart : mt.index, end, px: d[0], py: d[1], tc, font: fontRes, stream: streamNum, ta: tlm[0] || 1, td: tlm[3] || 1 })
      operandStart = null
      if (!tPos) tPos = d; else { x0 = Math.min(x0, d[0]); x1 = Math.max(x1, d[0]) }
    }
    else if (t === 'ET') { if (tPos) { const h = (fontSize * Math.abs(ctm[0])) || 10; units.push({ type: 'text', stream: streamNum, start, end, px: tPos[0], py: tPos[1], shows, bbox: [Math.min(x0, tPos[0]), tPos[1] - h * 0.82, Math.max(x1, tPos[0]) + h * 0.6, tPos[1] + h * 0.22], sa: ctm[0] || 1, sd: ctm[3] || 1 }) } shows = []; start = end; reset() }
    else if (VIS.has(t)) { if (hasP) { const raw = cs.slice(start, end); const mEfr = raw.match(/%EFR ([\d.]+)/); const mW = raw.match(/(-?[\d.]+)\s+w\b/); const mG = raw.match(/\/(EFGS\d+)\s+gs\b/); const mD = raw.match(/\[([^\]]*)\]\s*[-\d.]+\s+d\b/); const mL = raw.match(/%EFL (\w+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)/); units.push({ type: 'path', stream: streamNum, start, end, bbox: [x0, H - y1, x1, H - y0], sa: ctm[0] || 1, sd: ctm[3] || 1, ctm: ctm.slice(), ctmStart: startCtm.slice(), efr: mEfr ? +mEfr[1] : undefined, strw: mW ? +mW[1] : undefined, gs: mG ? mG[1] : undefined, dashArr: mD ? mD[1] : undefined, efl: mL ? { head: mL[1], x1: +mL[2], y1: +mL[3], x2: +mL[4], y2: +mL[5] } : undefined }) } start = end; reset() }
    else if (t === 'Do') { const cx = ctm[4], cy = ctm[5]; units.push({ type: 'image', stream: streamNum, start, end, bbox: [Math.min(cx, cx + ctm[0] + ctm[2]), H - Math.max(cy, cy + ctm[1] + ctm[3]), Math.max(cx, cx + ctm[0] + ctm[2]), H - Math.min(cy, cy + ctm[1] + ctm[3])], sa: ctm[0] || 1, sd: ctm[3] || 1, csa: cmPre?.sa, csd: cmPre?.sd, ctm: ctm.slice(), ctmStart: startCtm.slice(), name: pend, gs: (cs.slice(start, end).match(/\/(EFGS\d+)\s+gs\b/) || [])[1] }); start = end; reset() }
    num.length = 0
  }
  return units
}

// Match a model object to its stream unit. Overlapping objects (a pasted copy on top of an original)
// make bbox-overlap ambiguous, so FIRST try the exact anchor: a text run's first-glyph baseline (x,y)
// vs the unit's first-Tj device position; images/vectors compare bbox centres. Fallback: max overlap.
function matchUnit(units, it) {
  const want = { text: 'text', image: 'image', vector: 'path' }[it.type]
  let best = null, bestD = 5 // pt — anchors further apart than this are different objects
  for (const u of units) {
    if (u.type !== want) continue
    if (want === 'text' && it.x !== undefined) {
      // a multi-line unit anchors EVERY line with its own show — match against all of them,
      // not just the first Tj (line 2+ of a block was unmatchable and silently did not move)
      const pool = u.shows && u.shows.length ? u.shows : (u.px !== undefined ? [{ px: u.px, py: u.py }] : [])
      for (const sh of pool) {
        const d = Math.hypot(sh.px - it.x, sh.py - it.y)
        if (d < bestD) { bestD = d; best = u }
      }
      continue
    }
    const ux = (u.bbox[0] + u.bbox[2]) / 2, uy = (u.bbox[1] + u.bbox[3]) / 2
    const ix = it.bbox.x + it.bbox.w / 2, iy = it.bbox.y + it.bbox.h / 2
    const d = Math.hypot(ux - ix, uy - iy)
    if (d < bestD) { bestD = d; best = u }
  }
  if (best) return best
  let bestA = 0
  for (const u of units) {
    if (u.type !== want) continue
    const ix = Math.min(it.bbox.x + it.bbox.w, u.bbox[2]) - Math.max(it.bbox.x, u.bbox[0])
    const iy = Math.min(it.bbox.y + it.bbox.h, u.bbox[3]) - Math.max(it.bbox.y, u.bbox[1])
    if (ix > 0 && iy > 0 && ix * iy > bestA) { bestA = ix * iy; best = u }
  }
  return best
}

// Shift a unit's segment by (dx,dy) pt (screen-down) by editing coordinates IN the operators:
// text → every Tm (or the first Td/TD) + drop its clip; image → its positioning cm (whose e/f live
// in the space BEFORE that cm); vector → path construction points.
function shiftSeg(u, seg, dx, dy) {
  const de = dx / (u.sa || 1), df = -dy / (u.sd || 1)
  // a line/arrow carries its endpoints as an %EFL note (device pt) — keep it in sync
  seg = seg.replace(/%EFL (\w+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)/, (m, h, x1, y1, x2, y2) =>
    `%EFL ${h} ${n2(+x1 + dx)} ${n2(+y1 + dy)} ${n2(+x2 + dx)} ${n2(+y2 + dy)}`)
  if (u.type === 'text') {
    const tmRe = /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+Tm/g
    let edited
    if (tmRe.test(seg)) {
      edited = seg.replace(tmRe, (m, a, b, c, d, e2, f2) => `${a} ${b} ${c} ${d} ${(parseFloat(e2) + de).toFixed(3)} ${(parseFloat(f2) + df).toFixed(3)} Tm`)
    } else {
      edited = seg.replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(T[dD])\b/, (m, x, y, op) => `${(parseFloat(x) + de).toFixed(3)} ${(parseFloat(y) + df).toFixed(3)} ${op}`)
    }
    return edited.replace(/(^|[\s>\])])(W\*?)(\s+n\b)/g, (m, p, w, n) => p + '  ' + n) // drop the clip so moved text isn't cut
  }
  if (u.type === 'image') {
    const ms = [...seg.matchAll(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+cm/g)]
    if (ms.length) {
      const ide = dx / (u.csa || 1), idf = -dy / (u.csd || 1)
      const m = ms[ms.length - 1] // the LAST cm before Do positions the image
      return seg.slice(0, m.index) + `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${(parseFloat(m[5]) + ide).toFixed(3)} ${(parseFloat(m[6]) + idf).toFixed(3)} cm` + seg.slice(m.index + m[0].length)
    }
    return `\nq 1 0 0 1 ${de.toFixed(3)} ${df.toFixed(3)} cm\n` + seg + '\nQ\n' // no cm inside → wrap (newlines: units start flush against the previous op — "n"+"q" would fuse into "nq")
  }
  if (u.type === 'path') {
    return seg
      .replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+c\b/g, (m, x1, y1, x2, y2, x3, y3) => `${(parseFloat(x1) + de).toFixed(3)} ${(parseFloat(y1) + df).toFixed(3)} ${(parseFloat(x2) + de).toFixed(3)} ${(parseFloat(y2) + df).toFixed(3)} ${(parseFloat(x3) + de).toFixed(3)} ${(parseFloat(y3) + df).toFixed(3)} c`)
      .replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+([vy])\b/g, (m, x1, y1, x2, y2, op) => `${(parseFloat(x1) + de).toFixed(3)} ${(parseFloat(y1) + df).toFixed(3)} ${(parseFloat(x2) + de).toFixed(3)} ${(parseFloat(y2) + df).toFixed(3)} ${op}`)
      .replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+re\b/g, (m, x, y, w, h) => `${(parseFloat(x) + de).toFixed(3)} ${(parseFloat(y) + df).toFixed(3)} ${w} ${h} re`)
      .replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+([ml])\b/g, (m, x, y, op) => `${(parseFloat(x) + de).toFixed(3)} ${(parseFloat(y) + df).toFixed(3)} ${op}`)
  }
  return seg
}

// Make a segment self-contained wrt the q/Q stack: blank out unmatched pops (a leading Q closing a
// block opened BEFORE the unit would otherwise cancel the copy's state) and close any unclosed q.
function balanceSeg(seg) {
  const toks = [...mask(seg).matchAll(TOKENS)]
  let depth = 0
  const out = seg.split('')
  for (const mt of toks) {
    if (mt[0] === 'q') depth++
    else if (mt[0] === 'Q') { if (depth > 0) depth--; else out[mt.index] = ' ' }
  }
  return out.join('') + (depth > 0 ? ' ' + 'Q '.repeat(depth) : '')
}
// how many q's does the segment leave open?
function segOpenDepth(seg) {
  const toks = [...mask(seg).matchAll(TOKENS)]
  let depth = 0
  for (const mt of toks) {
    if (mt[0] === 'q') depth++
    else if (mt[0] === 'Q' && depth > 0) depth--
  }
  return depth
}
// A previously wrapped unit ("q M cm …path… S" — its closing Q sits AFTER the paint op, outside the
// parsed unit range). Extend the segment end to swallow those trailing Q's, or a re-wrap would leave
// orphan Q's in the stream (gstate underflow → the whole page flips).
function extendOverTrailingQs(cs, start, end) {
  let opens = segOpenDepth(cs.slice(start, end))
  while (opens > 0) {
    const m = cs.slice(end).match(/^\s*Q/)
    if (!m) break
    end += m[0].length
    opens--
  }
  return end
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
  // z advances on EVERY device call (accepted or filtered) so that a replay pass with the same
  // callbacks (renderObjects) stays in sync with the model's z values.
  const pushVector = (kind, b, color) => {
    const zz = z++
    if (!validRect(b)) return
    const w = b[2] - b[0], h = b[3] - b[1]
    if (w * h > pageArea * 0.7) return // full-page background fills are not selectable art
    if (w < 0.5 && h < 0.5) return // sub-pixel noise
    vectors.push({ z: zz, kind, bbox: { x: n2(b[0]), y: n2(b[1]), w: n2(w), h: n2(h) }, color: colorHex(color) })
  }
  const pushImage = (ctm) => {
    const zz = z++
    // bbox of the unit square through ctm (handles rotation/flip)
    const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]]
    const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]]
    const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    if (!validRect(b)) return
    const w = b[2] - b[0], h = b[3] - b[1]
    if (w < 3 || h < 3) return // decorative specks
    images.push({ z: zz, bbox: { x: n2(b[0]), y: n2(b[1]), w: n2(w), h: n2(h) } })
  }
  const dev = new mupdf.Device({
    fillPath: (path, evenOdd, ctm, cs, color) => { let b = null; try { b = path.getBounds(null, ctm) } catch (_) {} pushVector('fill', b, color) },
    strokePath: (path, stroke, ctm, cs, color) => { let b = null; try { b = path.getBounds(stroke, ctm) } catch (_) {} pushVector('stroke', b, color) },
    fillImage: (image, ctm) => pushImage(ctm),
    fillImageMask: (image, ctm) => pushImage(ctm),
    fillText: (text, ctm, cs, color) => {
      const zz = z++
      let b = null; try { b = text.getBounds(null, ctm) } catch (_) {}
      // exact anchor + exact font size from the FIRST glyph's matrix (stext JSON rounds size to an
      // integer — 9.75 would read back as 9)
      let ax, ay, asize
      try {
        text.walk({ showGlyph: (f, trm) => { if (ax === undefined) {
          ax = ctm[0] * trm[4] + ctm[2] * trm[5] + ctm[4]
          ay = ctm[1] * trm[4] + ctm[3] * trm[5] + ctm[5]
          asize = Math.hypot(trm[2], trm[3]) * Math.hypot(ctm[2], ctm[3]) // em-height through both matrices
        } } })
      } catch (_) {}
      if (validRect(b) && b[2] > b[0] && b[3] > b[1]) texts.push({ z: zz, bbox: b, ax, ay, size: asize, color: colorHex(color) })
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

// Render ONLY the objects with the given z values onto a transparent pixmap (the drag sprite).
// A replay Device counts calls with the same rhythm as scanDevice and forwards just the selected
// ones to a DrawDevice; clips/groups/masks are always forwarded so an object keeps its own clip.
function renderObjects(pageIndex, zs, bb, scale) {
  const page = doc.loadPage(pageIndex)
  try {
    const zSet = new Set(zs)
    const rect = [Math.floor(bb.x * scale), Math.floor(bb.y * scale), Math.ceil((bb.x + bb.w) * scale), Math.ceil((bb.y + bb.h) * scale)]
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, rect, true)
    pix.clear() // transparent
    const draw = new mupdf.DrawDevice(mupdf.Matrix.scale(scale, scale), pix)
    let z = 0
    const dev = new mupdf.Device({
      fillPath: (...a) => { if (zSet.has(z++)) draw.fillPath(...a) },
      strokePath: (...a) => { if (zSet.has(z++)) draw.strokePath(...a) },
      fillImage: (...a) => { if (zSet.has(z++)) draw.fillImage(...a) },
      fillImageMask: (...a) => { if (zSet.has(z++)) draw.fillImageMask(...a) },
      fillText: (...a) => { if (zSet.has(z++)) draw.fillText(...a) },
      strokeText: (...a) => { if (zSet.has(z++)) draw.strokeText(...a) },
      clipPath: (...a) => { z++; draw.clipPath(...a) },
      clipStrokePath: (...a) => { z++; draw.clipStrokePath(...a) },
      clipText: (...a) => { z++; draw.clipText(...a) },
      clipImageMask: (...a) => { z++; draw.clipImageMask(...a) },
      ignoreText: () => { z++ },
      fillShade: () => { z++ }, // not selectable in the model → never drawn
      popClip: () => draw.popClip(),
      beginMask: (...a) => draw.beginMask(...a),
      endMask: () => draw.endMask(),
      beginGroup: (...a) => draw.beginGroup(...a),
      endGroup: () => draw.endGroup(),
      beginTile: (...a) => { try { return draw.beginTile(...a) } catch (_) { return 0 } },
      endTile: () => draw.endTile(),
      beginLayer: (...a) => draw.beginLayer(...a),
      endLayer: () => draw.endLayer(),
      close: () => {}
    })
    try { page.run(dev, mupdf.Matrix.identity) } finally {
      try { dev.close() } catch (_) {} try { dev.destroy() } catch (_) {}
      try { draw.close() } catch (_) {} try { draw.destroy() } catch (_) {}
    }
    const png = pix.asPNG()
    const w = pix.getWidth(), h = pix.getHeight()
    pix.destroy()
    return { png: new Uint8Array(png).buffer, x: rect[0] / scale, y: rect[1] / scale, w: w / scale, h: h / scale }
  } finally { page.destroy() }
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
    const colorRef = (hex) => {
      if (!colorIdx.has(hex)) { colorIdx.set(hex, colors.length); colors.push(hex) }
      return colorIdx.get(hex)
    }

    colorRef('#000000') // index 0 is ALWAYS black — unmatched runs default to c:0 (vectors used to claim it)

    // device pass first: vectors + images + text ink-spans (anchor, color, size, z)
    const scan = scanDevice(page, W, H)
    const vectors = scan.vectors.map((v, i) => ({ id: 'v' + i, type: 'vector', bbox: v.bbox, kind: v.kind, c: colorRef(v.color), z: v.z }))
    const images = scan.images.map((im, i) => ({ id: 'i' + i, type: 'image', bbox: im.bbox, z: im.z }))

    // Text runs from stext.walk (per-char positions, exact float sizes). stext GLUES neighbouring
    // texts that share a baseline into one line — but every physical show op is a separate device
    // span with its own anchor, so a glued line is SPLIT back at the span boundaries: each piece
    // stays an independent object (frame, restyle and move touch only their own text).
    const runs = []
    const stext = page.toStructuredText('preserve-spans')
    const fontRefW = (font) => {
      const name = cleanName(font.getName())
      const key = 'w|' + name
      if (!fontIdx.has(key)) {
        fontIdx.set(key, fonts.length)
        fonts.push({
          name,
          generic: font.isMono() ? 'monospace' : font.isSerif() ? 'serif' : 'sans-serif',
          bold: font.isBold() || /bold|black|heavy/i.test(name),
          italic: font.isItalic() || /italic|oblique/i.test(name)
        })
      }
      return fontIdx.get(key)
    }
    let bi = -1, li = -1, cur = null
    const flush = () => {
      if (!cur || !cur.chars.length) { cur = null; return }
      const chars = cur.chars
      const x0 = chars[0].x, x1 = chars[chars.length - 1].x
      // device spans anchored on this baseline inside the line → cut points
      const cands = scan.texts
        .filter((t) => t.ax !== undefined && Math.abs(t.ay - cur.baseline) < 2 && t.ax >= x0 - 1 && t.ax <= x1 + 1)
        .sort((a, b) => a.ax - b.ax)
      const cuts = cands.length > 1 ? cands.map((t) => t.ax) : [x0]
      const segs = cuts.map(() => [])
      for (const ch of chars) {
        let j = 0
        while (j + 1 < cuts.length && ch.x >= cuts[j + 1] - 0.35) j++
        segs[j].push(ch)
      }
      segs.forEach((seg, k) => {
        if (!seg.length || !seg.some((ch) => ch.c.trim())) return
        const t = cands.length ? cands[Math.min(k, cands.length - 1)] : null
        const sx = seg[0].x
        const lastAdv = seg.length > 1 ? seg[seg.length - 1].x - seg[seg.length - 2].x : cur.size * 0.6
        let ex = seg[seg.length - 1].x + Math.max(lastAdv, cur.size * 0.35)
        // the device span carries the EXACT right edge (real advance of the last glyph — a wide
        // '%'/'W' used to poke out of the approximated frame); sanity-capped against the metric
        if (t && t.bbox && t.bbox[2] > sx + 0.3 && t.bbox[2] < ex + cur.size * 1.5) ex = t.bbox[2]
        runs.push({
          id: `b${cur.bi}.l${cur.li}` + (segs.length > 1 ? `.s${k}` : ''),
          type: 'text',
          bbox: { x: n2(sx), y: n2(cur.bbox[1]), w: n2(ex - sx), h: n2(cur.bbox[3] - cur.bbox[1]) },
          f: cur.f,
          size: n2(t && t.size > 0 ? t.size : cur.size),
          c: t ? colorRef(t.color) : 0,
          z: t ? t.z : -1,
          x: n2(sx),
          y: n2(cur.baseline),
          text: seg.map((ch) => ch.c).join(''),
          // the span's exact vertical metrics: hard bounds for the raster tighten (art painted
          // UNDER the text must not feed the ink growth) — consumed and dropped there
          sy0: t ? t.bbox[1] : undefined,
          sy1: t ? t.bbox[3] : undefined
        })
      })
      cur = null
    }
    try {
      stext.walk({
        beginTextBlock: () => { bi++; li = -1 },
        beginLine: (bbox) => { li++; cur = { bi, li, bbox, chars: [], f: 0, size: 12, baseline: 0, started: false } },
        onChar: (c, origin, font, size) => {
          if (!cur) return
          if (!cur.started) { cur.started = true; cur.f = fontRefW(font); cur.size = size; cur.baseline = origin[1] }
          cur.chars.push({ c, x: origin[0] })
        },
        endLine: flush,
        endTextBlock: flush
      })
    } finally { stext.destroy?.() }

    // Per-run stream metadata: the ORIGINAL letter spacing (Tc), and — for OUR inserted runs — the
    // TRUE text decoded straight from the hex show operand. stext synthesizes spaces into spaced-out
    // text ("L e o n…"), and re-inserting that on the next restyle made runs grow WIDER every cycle.
    try {
      const pageObj = doc.findPage(pageIndex)
      const units = collectUnits(pageObj, H)
      const efByName = {}
      for (const k of Object.keys(insFonts)) efByName[insFonts[k].name] = insFonts[k]
      const csCache = {}
      let read = 0
      for (const r of runs) {
        let best = null, bestD = 3
        for (const u of units) {
          if (u.type !== 'text' || !u.shows) continue
          for (const sh of u.shows) {
            const d = Math.hypot(sh.px - r.x, sh.py - r.y)
            if (d < bestD) { bestD = d; best = sh }
          }
        }
        if (!best) {
          // split pieces / merged lines: their anchor is mid-show — fall back to "the show whose
          // baseline matches and whose x starts at-or-before the run"
          let bx = -Infinity
          for (const u of units) {
            if (u.type !== 'text' || !u.shows) continue
            for (const sh of u.shows) {
              if (Math.abs(sh.py - r.y) < 2 && sh.px <= r.x + 1 && sh.px > bx) { bx = sh.px; best = sh }
            }
          }
        }
        if (best) read++
        r.ls = best && best.tc ? n2(best.tc) : 0
        // our own run → decode the true text from the stream (gid→char via the font's own map)
        const rec = best && best.font ? efByName[best.font] : null
        if (rec) {
          const cs = (csCache[best.stream] ||= readStream(pageObj, best.stream))
          const m = cs.slice(best.start, best.end).match(/<([0-9A-Fa-f\s]*)>/)
          if (m) {
            const hx = m[1].replace(/\s+/g, '')
            let text = ''
            for (let i = 0; i + 4 <= hx.length; i += 4) {
              const cp = rec.uni.get(parseInt(hx.slice(i, i + 4), 16))
              text += cp ? String.fromCodePoint(cp) : '�'
            }
            if (text) r.text = text
          }
        }
      }
      // vectors/images: read back %EFR (corner radius), stroke width and /EFGS opacity from their units
      const gsCa = (nm) => {
        try {
          const v = doc.findPage(pageIndex).getInheritable('Resources')?.get('ExtGState')?.get(nm)?.get('ca')
          const n = v && v.isNumber && v.isNumber() ? v.asNumber() : NaN
          return isNaN(n) ? undefined : n
        } catch { return undefined }
      }
      for (const v of [...vectors, ...images]) {
        const cx = (v.bbox.x + v.bbox.w / 2), cy = (v.bbox.y + v.bbox.h / 2)
        const want = v.type === 'vector' ? 'path' : 'image'
        for (const u of units) {
          if (u.type !== want || (u.efr === undefined && u.strw === undefined && !u.gs && u.dashArr === undefined && !u.efl)) continue
          if (Math.hypot((u.bbox[0] + u.bbox[2]) / 2 - cx, (u.bbox[1] + u.bbox[3]) / 2 - cy) < 5) {
            if (u.efr !== undefined) v.radius = u.efr
            if (u.strw !== undefined) v.strokeW = n2(u.strw * Math.abs(u.sa || 1)) // device pt
            if (u.gs) { const a = gsCa(u.gs); if (a !== undefined) v.opacity = Math.round(a * 100) }
            if (u.dashArr !== undefined) {
              const parts = u.dashArr.trim().split(/\s+/).filter(Boolean).map(Number)
              v.dash = !parts.length ? 'solid' : parts.length >= 4 ? 'dashdot' : parts[0] <= 0.5 ? 'dotted' : 'dashed'
            }
            if (u.efl) v.line = u.efl // endpoints (device pt) — the UI shows two free-drag handles
            break
          }
        }
      }
      console.log(`[pdf worker] Tc read: ${read}/${runs.length} runs matched, ${runs.filter((r) => r.ls).length} with ls≠0`)
    } catch (e) { console.warn('[pdf worker] Tc read failed:', e?.message) }

    tightenBboxes(page, runs) // hug the real glyphs: catch diacritics above and descenders below
    return { width: W, height: H, fonts, colors, runs, images, vectors }
  } finally { page.destroy() }
}

// Grow each run's bbox to the real ink from a 2x grayscale raster, but stop at a blank gap and cap
// the growth (~0.25em) so it catches THIS line's diacritics/descenders without swallowing neighbours.
// Raster of ONLY the text (paths/images/shades muted, clips kept): the ink here is purely glyphs,
// so the frame tighten sees the letters themselves — art painted under the text doesn't exist.
function textOnlyPixmap(page, S) {
  const b = page.getBounds()
  const rect = [Math.floor(b[0] * S), Math.floor(b[1] * S), Math.ceil(b[2] * S), Math.ceil(b[3] * S)]
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, rect, true)
  pix.clear() // transparent — ink test reads the alpha channel
  const draw = new mupdf.DrawDevice(mupdf.Matrix.scale(S, S), pix)
  const dev = new mupdf.Device({
    fillText: (...a) => draw.fillText(...a),
    strokeText: (...a) => draw.strokeText(...a),
    clipPath: (...a) => draw.clipPath(...a),
    clipStrokePath: (...a) => draw.clipStrokePath(...a),
    clipText: (...a) => draw.clipText(...a),
    clipImageMask: (...a) => draw.clipImageMask(...a),
    popClip: () => draw.popClip(),
    beginMask: (...a) => draw.beginMask(...a),
    endMask: () => draw.endMask(),
    beginGroup: (...a) => draw.beginGroup(...a),
    endGroup: () => draw.endGroup(),
    beginTile: (...a) => { try { return draw.beginTile(...a) } catch (_) { return 0 } },
    endTile: () => draw.endTile(),
    beginLayer: (...a) => draw.beginLayer(...a),
    endLayer: () => draw.endLayer(),
    close: () => {}
  })
  try { page.run(dev, mupdf.Matrix.identity) } finally {
    try { dev.close() } catch (_) {} try { dev.destroy() } catch (_) {}
    try { draw.close() } catch (_) {} try { draw.destroy() } catch (_) {}
  }
  return pix
}
function tightenBboxes(page, runs) {
  if (!runs.length) return
  const S = 2
  let pix
  try { pix = textOnlyPixmap(page, S) } catch { return }
  const px = pix.getPixels(), stride = pix.getStride(), pw = pix.getWidth(), ph = pix.getHeight(), nc = pix.getNumberOfComponents()
  const ai = nc - 1 // alpha channel: any glyph coverage = ink (colour-independent — white text counts too)
  const ink = (x0, x1, y) => {
    if (y < 0 || y >= ph) return false
    const base = y * stride
    for (let x = Math.max(0, x0); x < Math.min(pw, x1); x++) if (px[base + x * nc + ai] > 16) return true
    return false
  }
  // Nearest X-overlapping baselines: with EXTREME leading (gap < 0.5pt) the lines' ink touches and
  // the scan jumps across. Demarcation between two baselines is ASYMMETRIC — descenders of the
  // upper line get ~28% of the gap, ascenders of the lower one ~72% (a midpoint clipped capitals).
  const nb = new Map()
  for (const r of runs) {
    let above = -Infinity, below = Infinity
    const rx0 = r.bbox.x, rx1 = r.bbox.x + r.bbox.w
    for (const o of runs) {
      if (o === r) continue
      if (Math.min(o.bbox.x + o.bbox.w, rx1) - Math.max(o.bbox.x, rx0) < 0.3 * Math.min(o.bbox.w, r.bbox.w)) continue
      if (o.y < r.y - 1 && o.y > above) above = o.y
      else if (o.y > r.y + 1 && o.y < below) below = o.y
    }
    nb.set(r, [above, below])
  }
  for (const r of runs) {
    const x0 = Math.floor(r.bbox.x * S), x1 = Math.ceil((r.bbox.x + r.bbox.w) * S)
    const size = r.size || 10
    // Scan OUT FROM THE BASELINE (the one trustworthy coordinate) through the glyph-only ink:
    // grow while rows have ink, stop at the first real gap (> 0.15em — bigger than any in-glyph
    // hole, smaller than the inter-line gap).
    const base = Math.round(r.y * S)
    let hardTop = Math.max(0, Math.round((r.y - size * 1.4) * S))
    let hardBot = Math.min(ph, Math.round((r.y + size * 0.55) * S))
    const [above, below] = nb.get(r)
    if (isFinite(above)) hardTop = Math.max(hardTop, Math.round((above + 0.28 * (r.y - above)) * S))
    if (isFinite(below)) hardBot = Math.min(hardBot, Math.round((r.y + 0.72 * (below - r.y)) * S))
    const gapMax = Math.max(2, Math.round(size * 0.15 * S))
    let top = base, gap = 0
    for (let y = base - 1; y >= hardTop; y--) {
      if (ink(x0, x1, y)) { top = y; gap = 0 } else if (++gap > gapMax) break
    }
    let bot = base, gap2 = 0
    for (let y = base; y < hardBot; y++) {
      if (ink(x0, x1, y)) { bot = y + 1; gap2 = 0 } else if (++gap2 > gapMax) break
    }
    // width is NOT ink-grown: the metric right edge comes exactly from the device span (stable,
    // independent of neighbours/whitespace)
    if (bot > top) r.bbox = { x: r.bbox.x, y: n2(top / S), w: r.bbox.w, h: n2((bot - top) / S) }
    delete r.sy0
    delete r.sy1
  }
  pix.destroy()
}

// TrueType face must carry a cmap or the browser's OTS rejects the FontFace
function sfntHasCmap(buf) {
  try {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const n = dv.getUint16(4)
    for (let i = 0; i < n; i++) { const r = 12 + i * 16; if (String.fromCharCode(buf[r], buf[r + 1], buf[r + 2], buf[r + 3]) === 'cmap') return true }
  } catch {} return false
}

// Font inventory of the document: clean name, embedded/subset flags, and — for browser-loadable
// TrueType faces (cmap present) — the raw bytes, so the rich editor can PREVIEW the PDF's own fonts.
function getFontsInfo() {
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
    const bf = o.get('BaseFont'); const raw = bf.isNull() ? '' : bf.asName()
    const name = cleanName(raw)
    if (!name || seen[name]) continue
    seen[name] = 1
    let embedded = false, bytes = null, tt = false
    if (d && !d.isNull()) {
      embedded = !d.get('FontFile2').isNull() || !d.get('FontFile3').isNull() || !d.get('FontFile').isNull()
      const ff2 = d.get('FontFile2')
      tt = !ff2.isNull() // only TrueType bytes can be re-embedded for our CID inserts (Type1/CFF mis-encode)
      if (tt) {
        try { const raw2 = ff2.readStream().asUint8Array(); if (sfntHasCmap(raw2)) bytes = new Uint8Array(raw2).buffer } catch (_) {}
      }
    }
    out.push({ name, embedded, subset: /^[A-Z]{6}\+/.test(raw), tt, bytes })
  }
  return out
}

// raw font-file bytes of a document font (FontFile/2/3) by clean name — used to insert/restyle text
// with the PDF's OWN font, so it looks exactly like the rest of the document
function docFontBytes(name) {
  const n = String(name).toLowerCase().replace(/[^a-z0-9]/g, '')
  let count = 0
  try { count = doc.countObjects() } catch { return null }
  for (let i = 1; i < count; i++) {
    let o; try { o = doc.newIndirect(i).resolve() } catch { continue }
    if (!o || !o.isDictionary || !o.isDictionary()) continue
    let ty; try { ty = o.get('Type') } catch { continue }
    if (!ty || ty.isNull() || ty.asName() !== 'Font') continue
    const bf = o.get('BaseFont')
    const nm = cleanName(bf.isNull() ? '' : bf.asName()).toLowerCase().replace(/[^a-z0-9]/g, '')
    if (nm !== n) continue
    let d = o.get('FontDescriptor')
    if (d.isNull()) { const df = o.get('DescendantFonts'); if (df.isArray() && df.length) d = df.get(0).resolve().get('FontDescriptor') }
    if (!d || d.isNull()) continue
    // TrueType ONLY: Type1/CFF bytes fed into a new CID font mis-encode every glyph ("ÜÜÜÜ…")
    const ff = d.get('FontFile2')
    if (!ff.isNull()) { try { return ff.readStream().asUint8Array() } catch (_) {} }
  }
  return null
}

// ---- inserting NEW text ------------------------------------------------------------------------
// Embed a full font (CID/Identity-H via doc.addFont) once per fontKey and register it in the page's
// /Resources/Font. Glyphs are encoded per character; advances position the spans.
// Unicode ranges covered by the up-front ToUnicode map: Latin (+ext), Greek, Cyrillic, punctuation,
// currency, letterlike. ~2000 encodeCharacter probes at font creation — milliseconds.
const UNI_RANGES = [[0x20, 0x24F], [0x370, 0x3FF], [0x400, 0x52F], [0x1E00, 0x1EFF], [0x2000, 0x206F], [0x20A0, 0x20BF], [0x2100, 0x214F]]

function ensureInsFont(pageIndex, key, bytes, family) {
  let rec = insFonts[key]
  if (!rec) {
    // the font's NAME must be the real family — it becomes /BaseFont, which the model reads back as
    // the run's font name (an internal key here would "lose" the font on the next restyle)
    const font = new mupdf.Font(family || key, new Uint8Array(bytes))
    rec = { font, ref: doc.addFont(font), name: 'EF' + insFontSeq++, uni: new Map() }
    // Build the COMPLETE ToUnicode map NOW, before the font ever enters the content: mupdf caches a
    // font on first load, so a ToUnicode attached (or extended) later is never seen again and the
    // text reads back as glyph-id garbage. One full map up front covers every future character.
    for (const [a, b] of UNI_RANGES) {
      for (let cp = a; cp <= b; cp++) {
        const gid = font.encodeCharacter(cp) & 0xffff
        if (gid && !rec.uni.has(gid)) rec.uni.set(gid, cp)
      }
    }
    updateToUnicode(rec)
    insFonts[key] = rec
  }
  return rec
}

// Put the font into the page's /Resources/Font. Called right before WRITING content — never before
// a redaction: applyRedactions rebuilds the resources and throws away a not-yet-used font, leaving
// the inserted text pointing at nothing (wrong face on screen, glyph-id garbage in the model).
// Always verifies the actual dictionary — a cached "already registered" flag can be stale.
function registerInsFont(pageIndex, rec) {
  const po = doc.findPage(pageIndex)
  let res = po.getInheritable('Resources')
  if (!res || res.isNull()) { res = doc.newDictionary(); po.put('Resources', res) }
  let fd = res.get('Font')
  if (fd.isNull()) { fd = doc.newDictionary(); res.put('Font', fd) }
  // A prior save may have baked EF0, EF1… into the file. insFontSeq restarts at 0 each session, so a
  // new font can be named "EF0" while a DIFFERENT (stale, possibly bold) EF0 already sits in the dict
  // — reusing that name would make our text render in the wrong face. Take a genuinely free name.
  if (!rec.registered) {
    while (!fd.get(rec.name).isNull()) rec.name = 'EF' + insFontSeq++
    rec.registered = true
  }
  if (fd.get(rec.name).isNull()) fd.put(rec.name, rec.ref)
}

// Can this font actually ENCODE the given sample text? Type1/CFF faces fed into our CID insert
// return one-and-the-same glyph for every char ("aaaaa…"). Checked BEFORE any deletion happens.
function fontEncodes(bytes, family, sample) {
  let font = null
  try {
    font = new mupdf.Font(family || 'F', new Uint8Array(bytes))
    const chars = [...new Set([...String(sample || 'Ag1')])].slice(0, 12)
    const gids = chars.map((ch) => font.encodeCharacter(ch.codePointAt(0)) & 0xffff)
    if (gids.every((g) => g === 0)) return false
    if (chars.length > 2 && new Set(gids).size === 1) return false // all different chars → one glyph = broken
    return true
  } catch (_) { return false } finally { try { font?.destroy?.() } catch (_) {} }
}

// Without /ToUnicode the inserted CID text reads back as raw glyph ids ("Estonia" → "(VWRQLD"-style
// garbage), which then cascades through every following restyle. We know the gid↔char mapping (we
// encoded it), so build the CMap ourselves and attach it to the font.
function updateToUnicode(rec) {
  if (!rec.uni.size) return
  const entries = [...rec.uni.entries()]
  let bf = ''
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100)
    bf += `${chunk.length} beginbfchar\n` + chunk.map(([g, cp]) => {
      let u
      if (cp > 0xffff) { const c = cp - 0x10000; u = (0xd800 + (c >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (c & 0x3ff)).toString(16).padStart(4, '0') }
      else u = cp.toString(16).padStart(4, '0')
      return `<${g.toString(16).padStart(4, '0')}> <${u}>`
    }).join('\n') + '\nendbfchar\n'
  }
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${bf}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`
  try {
    const dict = rec.ref.resolve ? rec.ref.resolve() : rec.ref
    dict.put('ToUnicode', doc.addStream(cmap, {}))
  } catch (e) { console.warn('[pdf worker] ToUnicode failed:', e?.message) }
}
const hexRgbOps = (hex) => (String(hex || '#000000').replace('#', '').match(/../g) || ['00', '00', '00']).slice(0, 3).map((h) => (parseInt(h, 16) / 255).toFixed(3)).join(' ')

// State at the very END of a content stream: how many q's are still open and which CTM would be
// active after closing them. Appended content inherits this state — many generators leave a FLIPPED
// CTM open (1 0 0 -1 …), which would mirror and displace anything we add.
function streamEndState(cs) {
  const toks = [...mask(cs).matchAll(TOKENS)]
  let ctm = [1, 0, 0, 1, 0, 0]
  const stk = []
  const num = []
  for (const mt of toks) {
    const t = mt[0]
    if (isNum(t)) { num.push(t); continue }
    if (t === 'q') stk.push(ctm.slice())
    else if (t === 'Q') { if (stk.length) ctm = stk.pop() }
    else if (t === 'cm') { const m = num.slice(-6).map(Number); if (m.length === 6) ctm = matMul(m, ctm) }
    num.length = 0
  }
  return { depth: stk.length, base: stk.length ? stk[0] : ctm } // base = CTM after popping every open q
}
const isIdentityM = (m) => Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6 && Math.abs(m[4]) < 1e-6 && Math.abs(m[5]) < 1e-6
function invertM(m) {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c || 1e-9
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

// THE single gate for fonts entering the document. For every key: resolve bytes ({pdf} → the
// document's own TrueType, else the provided file), VALIDATE they can encode this key's actual
// text, fall back to the provided fallback font, and only then embed. Throws BEFORE any mutation —
// so no operation built on top of it can ever delete content and then fail to draw ("aaaa…").
function prepareInsFonts(pageIndex, fonts, fallback, samples) {
  const recs = {}
  for (const k of Object.keys(fonts || {})) {
    const f = fonts[k]
    const sample = samples[k] || 'Ag1'
    let bytes = f.bytes || (f.pdf ? docFontBytes(f.pdf) : null)
    let family = f.family || f.pdf || k
    if (!bytes || !fontEncodes(bytes, family, sample)) {
      if (fallback?.bytes && fontEncodes(fallback.bytes, fallback.family, sample)) {
        console.warn(`[pdf worker] font "${family}" cannot encode the text → fallback "${fallback.family}"`)
        bytes = fallback.bytes
        family = fallback.family || 'Arial'
      } else {
        throw new Error(`font "${family}" cannot encode the text and no usable fallback`)
      }
    }
    recs[k] = ensureInsFont(pageIndex, family + '|' + (bytes === fallback?.bytes ? 'fb' : k), bytes, family)
  }
  return recs
}
const samplesOf = (spec) => {
  const out = {}
  for (const line of spec.lines || []) for (const s of line) out[s.fontKey] = (out[s.fontKey] || '') + s.text
  return out
}

// Append new text to the page content. spec.lines = [ [ {text, size, color, fontKey, x, baseline,
// ls} ] ] — every run carries its EXACT page coordinates (measured from the editor's real DOM
// rects), so the text lands precisely where it was typed. ls → Tc (letter spacing). Each LINE is
// its own BT..ET, so it parses back as a separate, individually selectable unit.
function insertText(pageIndex, spec, fonts, fallback) {
  const recs = prepareInsFonts(pageIndex, fonts, fallback, samplesOf(spec)) // throws BEFORE any write
  insertTextWithRecs(pageIndex, spec, recs)
}
function insertTextWithRecs(pageIndex, spec, recs) {
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const pageObj = doc.findPage(pageIndex)
  for (const k of Object.keys(recs)) registerInsFont(pageIndex, recs[k]) // AFTER any redaction, right before writing
  console.log('[pdf worker] insert:', JSON.stringify((spec.lines || []).map((l) => l.map((s) => ({ t: s.text, x: s.x, b: s.baseline, ls: s.ls || 0 })))))
  // ONE BT..ET block for the whole insertion, lines positioned with relative Td — exactly how
  // native PDFs write paragraphs, so the lines read back as ONE block (bN.l0, bN.l1, …) and
  // block-selection / future editing treats them as one object
  let body = ''
  let curX = null, curY = null
  for (const line of spec.lines || []) {
    for (const s of line) {
      const rec = recs[s.fontKey]
      if (!rec || !s.text) continue
      let hex = '', nat = 0
      for (const ch of s.text) {
        const gid = rec.font.encodeCharacter(ch.codePointAt(0)) & 0xffff
        nat += rec.font.advanceGlyph(gid, 0)
        hex += gid.toString(16).padStart(4, '0')
      }
      // no explicit LS but a target width → fit Tc so the new run spans EXACTLY the original width
      // (covers spacing baked in as TJ kerning / per-glyph positions, which can't be read as one number)
      let ls = s.ls
      if ((ls === undefined || ls === null) && s.fitW > 0 && s.text.length > 1) {
        ls = Math.max(-3, Math.min(10, (s.fitW - nat * (s.size || 12)) / (s.text.length - 1)))
      }
      const tx = s.x, ty = H - s.baseline
      const pos = curX === null ? `1 0 0 1 ${n2(tx)} ${n2(ty)} Tm` : `${n2(tx - curX)} ${n2(ty - curY)} Td`
      curX = tx; curY = ty
      body += `${hexRgbOps(s.color)} rg /${rec.name} ${n2(s.size || 12)} Tf ${n2(ls || 0)} Tc ${pos} <${hex}> Tj\n`
    }
  }
  const ops = body ? '\nq BT\n' + body + 'ET Q\n' : '\n'
  // (ToUnicode is complete since font creation — no post-hoc updates: mupdf would never re-read them)
  const cs = readStream(pageObj, 0)
  // neutralise whatever graphics state the stream ends in: close every open q, then undo any
  // remaining root CTM (a leftover flip would mirror our glyphs and shift the position)
  const end = streamEndState(cs)
  let prefix = end.depth > 0 ? 'Q'.repeat(end.depth) + '\n' : ''
  let suffix = ''
  if (!isIdentityM(end.base)) {
    const iv = invertM(end.base)
    prefix += `q ${iv.map((v) => +v.toFixed(6)).join(' ')} cm\n`
    suffix = 'Q\n'
  }
  writeStream(pageObj, 0, cs + '\n' + prefix + ops + suffix)
}

// Surgical text delete: match each item to ITS OWN show operator by the exact baseline anchor and
// blank it with same-length spaces (byte offsets stay intact, graphics state untouched) — a
// rectangle-based redaction would also eat any neighbouring text whose box merely overlaps.
// Returns the items no show could be matched for (they fall back to redaction).
function blankTextShows(pageIndex, items, strict = false) {
  const texts = (items || []).filter((it) => it.type === 'text')
  if (!texts.length) return []
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const pageObj = doc.findPage(pageIndex)
  const units = collectUnits(pageObj, H)
  // phase 1: match EVERY item to its own show first — nothing is written until all are resolved
  const leftovers = []
  const byStream = {}
  const used = new Set()
  for (const it of texts) {
    let best = null, bestD = 3, bestU = null, nearest = Infinity
    for (const u of units) {
      if (u.type !== 'text' || !u.shows) continue
      for (const sh of u.shows) {
        if (used.has(sh)) continue
        const d = it.x !== undefined ? Math.hypot(sh.px - it.x, sh.py - it.y) : Infinity
        if (d < nearest) nearest = d
        if (d < bestD) { bestD = d; best = sh; bestU = u }
      }
    }
    if (!best) {
      console.warn(`[pdf worker] no show op at anchor (${it.x},${it.y}) "${(it.text || '').slice(0, 20)}" — nearest ${nearest.toFixed(1)}pt`)
      leftovers.push(it)
      continue
    }
    // one visual run is often painted by SEVERAL show ops ("(L) Tj (eon…) Tj") that the device pass
    // merges into one span — blank EVERY show of this unit that falls inside the item's own line
    // range, or the leftovers would keep drawing under the replacement
    const x0 = (it.bbox?.x ?? it.x) - 1, x1 = (it.bbox ? it.bbox.x + it.bbox.w : it.x) + 1
    for (const sh of bestU.shows) {
      if (used.has(sh)) continue
      if (Math.abs(sh.py - it.y) < 2 && sh.px >= x0 && sh.px <= x1) {
        used.add(sh)
        ;(byStream[bestU.stream] = byStream[bestU.stream] || []).push(sh)
      }
    }
  }
  // strict (replace/restyle): a single miss aborts the WHOLE operation before any write — an
  // imprecise delete would leave duplicates / eat neighbours
  if (strict && leftovers.length) throw new Error(`cannot precisely locate ${leftovers.length} text run(s) in the stream — nothing changed`)
  // phase 2: blank the matched shows with same-length spaces (offsets stay intact)
  for (const sk of Object.keys(byStream)) {
    const s = Number(sk)
    let cs = readStream(pageObj, s)
    for (const sh of byStream[sk]) cs = cs.slice(0, sh.start) + ' '.repeat(sh.end - sh.start) + cs.slice(sh.end)
    writeStream(pageObj, s, cs)
  }
  return leftovers
}

// Resize an image/vector: wrap its (q/Q-balanced) unit in a transform that maps the old device
// bbox onto the new one. W is computed in the unit's own space through its full CTM, so rotated /
// nested content scales correctly too.
function resizeObject(pageIndex, item, nb) {
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const pageObj = doc.findPage(pageIndex)
  const units = collectUnits(pageObj, H)
  const u = matchUnit(units, item)
  if (!u || !u.ctm) throw new Error('cannot locate the object in the stream — nothing changed')
  const ob = item.bbox
  const sx = nb.w / ob.w, sy = nb.h / ob.h
  // device-space transform: scale around the OLD top-left, then move to the NEW top-left.
  // In root user space (y-up): anchor (x, H - y).
  const ax = ob.x, ayU = H - ob.y
  const mUser = [sx, 0, 0, sy, ax * (1 - sx) + (nb.x - ob.x), ayU * (1 - sy) - (nb.y - ob.y)]
  // The wrap goes AROUND the unit, so conjugate through the CTM at the unit's START (ctmStart) —
  // the paint-time ctm includes the unit's own cm (an image's placement, a previous wrap) and
  // would skew the translation ("shrink from the left → the right edge drifts").
  const prior = u.ctmStart || [1, 0, 0, 1, 0, 0]
  const W = matMul(matMul(prior, mUser), invertM(prior))
  const cs = readStream(pageObj, u.stream)
  // a unit we already wrapped before keeps its closing Q AFTER the paint op — swallow those, or the
  // re-wrap would orphan them (gstate underflow → the whole page flips/shifts)
  const segEnd = extendOverTrailingQs(cs, u.start, u.end)
  const seg = balanceSeg(cs.slice(u.start, segEnd))
  // leading/trailing newlines are ESSENTIAL: units start flush against the previous operator, and
  // "…W n" + "q…" would fuse into the invalid token "nq" (breaks the whole page)
  const wrapped = `\nq ${W.map((v) => +v.toFixed(6)).join(' ')} cm\n` + seg + '\nQ\n'
  writeStream(pageObj, u.stream, cs.slice(0, u.start) + wrapped + cs.slice(u.end < segEnd ? segEnd : u.end))
}

// Recolor a vector: replace its stroke (RG/G/K) and/or fill (rg/g/k) colour operators inside the
// unit; a unit with no own colour op (inherited state) gets one prefixed.
function recolorVector(pageIndex, item, colors) {
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const pageObj = doc.findPage(pageIndex)
  const units = collectUnits(pageObj, H)
  const u = matchUnit(units, item)
  if (!u) throw new Error('cannot locate the vector in the stream')
  const cs = readStream(pageObj, u.stream)
  const segEnd = extendOverTrailingQs(cs, u.start, u.end)
  let seg = cs.slice(u.start, segEnd)
  const lastPaintPos = () => {
    const re = /([\s>)\]])(S|s|f\*?|B\*?|b\*?)(?![A-Za-z*])/g
    let last = null, m
    while ((m = re.exec(seg))) last = m
    return last ? last.index + last[1].length : -1
  }
  const N3 = '(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+'
  const apply = (hex, ops) => {
    const col = hexRgbOps(hex)
    let hit = false
    seg = seg
      .replace(new RegExp(N3 + ops[0] + '\\b', 'g'), () => { hit = true; return `${col} ${ops[0]}` }) // RGB
      .replace(new RegExp('(-?[\\d.]+)\\s+' + ops[1] + '\\b', 'g'), () => { hit = true; return `${col} ${ops[0]}` }) // gray → RGB
      .replace(new RegExp(N3 + '(-?[\\d.]+)\\s+' + ops[2] + '\\b', 'g'), () => { hit = true; return `${col} ${ops[0]}` }) // CMYK → RGB
    if (!hit) {
      // no own colour op — inject one right BEFORE the paint op (the unit's own q…Q wrapping would
      // cancel anything prefixed outside of it, leaving the default black)
      const at = lastPaintPos()
      if (at >= 0) seg = seg.slice(0, at) + `${col} ${ops[0]}\n` + seg.slice(at)
      else seg = `\n${col} ${ops[0]}\n` + seg
    }
  }
  const hasStroke = colors.stroke && colors.stroke !== 'none'
  const hasFill = colors.fill && colors.fill !== 'none'
  if (hasStroke) apply(colors.stroke, ['RG', 'G', 'K'])
  if (hasFill) apply(colors.fill, ['rg', 'g', 'k'])
  // the paint op decides WHAT is drawn: upgrade it when a colour is added to a side that wasn't
  // painted, downgrade it for 'none' (transparent stroke/fill)
  const setPaint = (map) => {
    const re = /([\s>)\]])(S|s|f\*?|B\*?|b\*?)(?![A-Za-z*])/g
    let last = null, m
    while ((m = re.exec(seg))) last = m
    if (last && map[last[2]]) seg = seg.slice(0, last.index) + last[1] + map[last[2]] + seg.slice(last.index + last[0].length)
  }
  if (hasFill) setPaint({ S: 'B', s: 'b' })
  if (hasStroke) setPaint({ 'f*': 'B*', f: 'B' })
  if (colors.stroke === 'none') setPaint({ S: 'n', s: 'n', B: 'f', 'B*': 'f*', b: 'f', 'b*': 'f*' })
  if (colors.fill === 'none') setPaint({ f: 'n', 'f*': 'n', B: 'S', 'B*': 'S', b: 's', 'b*': 's' })
  writeStream(pageObj, u.stream, cs.slice(0, u.start) + seg + cs.slice(segEnd))
}

// Set an object's opacity (0..1): an ExtGState with CA/ca is registered on the page and applied
// inside a q..Q wrap around the unit (so the alpha can't leak into the following content).
let insGsSeq = 0
function setOpacity(pageIndex, item, alpha) {
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const pageObj = doc.findPage(pageIndex)
  const units = collectUnits(pageObj, H)
  const u = matchUnit(units, item)
  if (!u) throw new Error('cannot locate the object in the stream')
  // register /EFGSn { CA, ca } in the page resources
  const name = 'EFGS' + insGsSeq++
  let res = pageObj.getInheritable('Resources')
  if (!res || res.isNull()) { res = doc.newDictionary(); pageObj.put('Resources', res) }
  let eg = res.get('ExtGState')
  if (eg.isNull()) { eg = doc.newDictionary(); res.put('ExtGState', eg) }
  const d = doc.newDictionary()
  d.put('CA', alpha)
  d.put('ca', alpha)
  eg.put(name, doc.addObject(d))
  const cs = readStream(pageObj, u.stream)
  const segEnd = extendOverTrailingQs(cs, u.start, u.end)
  let seg = cs.slice(u.start, segEnd)
  if (/\/EFGS\d+ gs/.test(seg)) seg = seg.replace(/\/EFGS\d+ gs/g, `/${name} gs`) // re-tint an already wrapped unit
  else seg = `\nq /${name} gs\n` + balanceSeg(seg) + '\nQ\n'
  writeStream(pageObj, u.stream, cs.slice(0, u.start) + seg + cs.slice(segEnd))
}

// Move a line/arrow ENDPOINT: the construction ops are rebuilt from the new endpoints (in the
// unit's own space through the inverse CTM); colour/width/dash/paint and the %EFL note follow.
function setLineGeo(pageIndex, item, geo) {
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const pageObj = doc.findPage(pageIndex)
  const units = collectUnits(pageObj, H)
  const u = matchUnit(units, item)
  if (!u || !u.efl) throw new Error('not an editable line/arrow')
  const cs = readStream(pageObj, u.stream)
  const segEnd = extendOverTrailingQs(cs, u.start, u.end)
  const seg = cs.slice(u.start, segEnd)
  const inv = invertM(u.ctm)
  const toU = (dx, dyTop) => { const uy = H - dyTop; return [inv[0] * dx + inv[2] * uy + inv[4], inv[1] * dx + inv[3] * uy + inv[5]] }
  const [ux1, uy1] = toU(geo.x1, geo.y1)
  const [ux2, uy2] = toU(geo.x2, geo.y2)
  const sc = Math.abs(u.ctm[0]) || 1
  const swU = +((seg.match(/(-?[\d.]+)\s+w\b/) || [])[1] || 1)
  const a = arrowPathUV(ux1, uy1, ux2, uy2, u.efl.head, Math.max(7, swU * sc * 4) / sc)
  const CONSTR = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h'])
  let first = -1, last = -1, numStart = -1
  for (const mt of mask(seg).matchAll(TOKENS)) {
    if (isNum(mt[0])) { if (numStart < 0) numStart = mt.index; continue }
    if (CONSTR.has(mt[0])) {
      if (first < 0) first = numStart >= 0 ? numStart : mt.index
      last = mt.index + mt[0].length
    }
    numStart = -1
  }
  if (first < 0) throw new Error('no path found in the unit')
  let seg2 = seg.slice(0, first) + a.p + seg.slice(last)
  seg2 = seg2.replace(/%EFL \w+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+/, `%EFL ${u.efl.head} ${n2(geo.x1)} ${n2(geo.y1)} ${n2(geo.x2)} ${n2(geo.y2)}`)
  writeStream(pageObj, u.stream, cs.slice(0, u.start) + seg2 + cs.slice(segEnd))
}

// Set a vector's line type (solid/dashed/dotted/dashdot): replace its `[..] n d` op, or inject one.
function setDash(pageIndex, item, key) {
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const pageObj = doc.findPage(pageIndex)
  const units = collectUnits(pageObj, H)
  const u = matchUnit(units, item)
  if (!u) throw new Error('cannot locate the vector in the stream')
  const cs = readStream(pageObj, u.stream)
  const segEnd = extendOverTrailingQs(cs, u.start, u.end)
  let seg = cs.slice(u.start, segEnd)
  const swU = (seg.match(/(-?[\d.]+)\s+w\b/) || [])[1]
  const op = dashOps(key, swU ? +swU * Math.abs(u.sa || 1) : 1).trim() || '[] 0 d'
  let hit = false
  seg = seg.replace(/\[[^\]]*\]\s*[-\d.]+\s+d\b/g, () => { hit = true; return op })
  if (!hit) {
    // `d` is graphics-STATE: it must come BEFORE the path construction starts — inserted after an
    // `m`/`re` it is a syntax error the renderer silently drops ("the dropdown does nothing")
    const CONSTR = new Set(['m', 'l', 'c', 'v', 'y', 're'])
    let at = -1, numStart = -1
    for (const mt of mask(seg).matchAll(TOKENS)) {
      if (isNum(mt[0])) { if (numStart < 0) numStart = mt.index; continue }
      if (CONSTR.has(mt[0])) { at = numStart >= 0 ? numStart : mt.index; break }
      numStart = -1
    }
    if (at >= 0) seg = seg.slice(0, at) + `${op}\n` + seg.slice(at)
    else seg = `\n${op}\n` + seg
  }
  writeStream(pageObj, u.stream, cs.slice(0, u.start) + seg + cs.slice(segEnd))
}

// Set a vector's stroke width: replace its own `n w` op(s), or inject one before the paint op.
function setStrokeWidth(pageIndex, item, wpt) {
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const pageObj = doc.findPage(pageIndex)
  const units = collectUnits(pageObj, H)
  const u = matchUnit(units, item)
  if (!u) throw new Error('cannot locate the vector in the stream')
  const cs = readStream(pageObj, u.stream)
  const segEnd = extendOverTrailingQs(cs, u.start, u.end)
  let seg = cs.slice(u.start, segEnd)
  const wU = wpt / (Math.abs(u.ctm?.[0]) || 1) // width is given in device pt
  let hit = false
  seg = seg.replace(/(-?[\d.]+)\s+w\b/g, () => { hit = true; return `${n2(wU)} w` })
  if (!hit) {
    const re = /([\s>)\]])(S|s|f\*?|B\*?|b\*?)(?![A-Za-z*])/g
    let last = null, m
    while ((m = re.exec(seg))) last = m
    if (last) seg = seg.slice(0, last.index + last[1].length) + `${n2(wU)} w\n` + seg.slice(last.index + last[1].length)
  }
  writeStream(pageObj, u.stream, cs.slice(0, u.start) + seg + cs.slice(segEnd))
}

// Insert a vector shape (rect with optional corner radius / line / ellipse), stroked in the given
// colour. Same end-of-stream neutralisation as text/images.
const K = 0.5523 // bezier circle constant
// dash pattern op by type key, scaled by the stroke width (round caps turn the dots round)
function dashOps(key, sw) {
  const s = Math.max(1, sw || 1)
  if (key === 'dashed') return `[${n2(4 * s)} ${n2(3 * s)}] 0 d `
  if (key === 'dotted') return `[0.01 ${n2(2.5 * s)}] 0 d `
  if (key === 'dashdot') return `[${n2(6 * s)} ${n2(2.5 * s)} 0.01 ${n2(2.5 * s)}] 0 d `
  return '' // solid
}
// arrow path in plain Y-up coordinates (both root user space and unit space use this)
function arrowPathUV(x1, y1, x2, y2, head, hs) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1
  const ux = dx / len, uy = dy / len, px = -uy, py = ux
  const vee = (tx, ty, dirx, diry) =>
    `${n2(tx - dirx * hs + px * hs * 0.5)} ${n2(ty - diry * hs + py * hs * 0.5)} m ${n2(tx)} ${n2(ty)} l ${n2(tx - dirx * hs - px * hs * 0.5)} ${n2(ty - diry * hs - py * hs * 0.5)} l `
  if (head === 'filled') {
    // shaft stops short, the head is a filled triangle — ONE paint op (B) keeps it one unit
    const bx = x2 - ux * hs * 0.7, by = y2 - uy * hs * 0.7
    const tri = `${n2(x2)} ${n2(y2)} m ${n2(x2 - ux * hs + px * hs * 0.5)} ${n2(y2 - uy * hs + py * hs * 0.5)} l ${n2(x2 - ux * hs - px * hs * 0.5)} ${n2(y2 - uy * hs - py * hs * 0.5)} l h `
    return { p: `${n2(x1)} ${n2(y1)} m ${n2(bx)} ${n2(by)} l ${tri}`, filled: true }
  }
  if (head === 'line') return { p: `${n2(x1)} ${n2(y1)} m ${n2(x2)} ${n2(y2)} l `, filled: false }
  let p = `${n2(x1)} ${n2(y1)} m ${n2(x2)} ${n2(y2)} l ${vee(x2, y2, ux, uy)}`
  if (head === 'double') p += vee(x1, y1, -ux, -uy)
  if (head === 'bar') p += `${n2(x1 + px * hs * 0.6)} ${n2(y1 + py * hs * 0.6)} m ${n2(x1 - px * hs * 0.6)} ${n2(y1 - py * hs * 0.6)} l `
  return { p, filled: false }
}
function shapeOps(kind, g, style, H) {
  const col = hexRgbOps(style.color || '#000000')
  const sw = style.strokeW || 1
  const dash = dashOps(style.dash, sw)
  if (kind === 'arrow') {
    // free-angle arrow from (x1,y1) to (x2,y2); heads: open | filled | double | bar
    const a = arrowPathUV(g.x1, H - g.y1, g.x2, H - g.y2, style.head || 'open', Math.max(7, sw * 4))
    return a.filled
      ? `q ${col} RG ${col} rg ${n2(sw)} w 1 j 1 J ${dash}${a.p}B Q\n`
      : `q ${col} RG ${n2(sw)} w 1 j 1 J ${dash}${a.p}S Q\n`
  }
  let p = ''
  if (kind === 'line') {
    p = `${n2(g.x1)} ${n2(H - g.y1)} m ${n2(g.x2)} ${n2(H - g.y2)} l`
  } else if (kind === 'ellipse') {
    const cx = g.x + g.w / 2, cy = H - g.y - g.h / 2, rx = g.w / 2, ry = g.h / 2
    p = `${n2(cx + rx)} ${n2(cy)} m ` +
      `${n2(cx + rx)} ${n2(cy + ry * K)} ${n2(cx + rx * K)} ${n2(cy + ry)} ${n2(cx)} ${n2(cy + ry)} c ` +
      `${n2(cx - rx * K)} ${n2(cy + ry)} ${n2(cx - rx)} ${n2(cy + ry * K)} ${n2(cx - rx)} ${n2(cy)} c ` +
      `${n2(cx - rx)} ${n2(cy - ry * K)} ${n2(cx - rx * K)} ${n2(cy - ry)} ${n2(cx)} ${n2(cy - ry)} c ` +
      `${n2(cx + rx * K)} ${n2(cy - ry)} ${n2(cx + rx)} ${n2(cy - ry * K)} ${n2(cx + rx)} ${n2(cy)} c h`
  } else if (kind === 'check') { // ✓ two strokes across the box
    const x = g.x, yB = H - g.y - g.h, w = g.w, h = g.h
    p = `${n2(x + 0.12 * w)} ${n2(yB + 0.5 * h)} m ${n2(x + 0.4 * w)} ${n2(yB + 0.18 * h)} l ${n2(x + 0.88 * w)} ${n2(yB + 0.82 * h)} l`
  } else if (kind === 'cross') { // ✕ two diagonals
    const x = g.x, yB = H - g.y - g.h, w = g.w, h = g.h
    p = `${n2(x + 0.15 * w)} ${n2(yB + 0.85 * h)} m ${n2(x + 0.85 * w)} ${n2(yB + 0.15 * h)} l ` +
      `${n2(x + 0.85 * w)} ${n2(yB + 0.85 * h)} m ${n2(x + 0.15 * w)} ${n2(yB + 0.15 * h)} l`
  } else { // rect, optionally rounded
    p = roundRectPath(g.x, H - g.y - g.h, g.w, g.h, style.radius || 0)
  }
  return `q ${col} RG ${n2(sw)} w 1 j 1 J ${p} S Q\n`
}
// rectangle path ops in USER coordinates (y-up, yB = bottom), rounded with bezier arcs
function roundRectPath(x, yB, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  if (r < 0.1) return `${n2(x)} ${n2(yB)} ${n2(w)} ${n2(h)} re`
  const k = K * r
  return `${n2(x + r)} ${n2(yB)} m ` +
    `${n2(x + w - r)} ${n2(yB)} l ` +
    `${n2(x + w - r + k)} ${n2(yB)} ${n2(x + w)} ${n2(yB + r - k)} ${n2(x + w)} ${n2(yB + r)} c ` +
    `${n2(x + w)} ${n2(yB + h - r)} l ` +
    `${n2(x + w)} ${n2(yB + h - r + k)} ${n2(x + w - r + k)} ${n2(yB + h)} ${n2(x + w - r)} ${n2(yB + h)} c ` +
    `${n2(x + r)} ${n2(yB + h)} l ` +
    `${n2(x + r - k)} ${n2(yB + h)} ${n2(x)} ${n2(yB + h - r + k)} ${n2(x)} ${n2(yB + h - r)} c ` +
    `${n2(x)} ${n2(yB + r)} l ` +
    `${n2(x)} ${n2(yB + r - k)} ${n2(x + r - k)} ${n2(yB)} ${n2(x + r)} ${n2(yB)} c h`
}
// Set a vector's corner radius: its path-construction ops are REBUILT as a rounded rectangle over
// the same bbox (in the unit's own user space, through the inverse CTM). Colour/width/paint stay.
function setVectorRadius(pageIndex, item, radius) {
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const pageObj = doc.findPage(pageIndex)
  const units = collectUnits(pageObj, H)
  const u = matchUnit(units, item)
  if (!u || !u.ctm) throw new Error('cannot locate the vector in the stream')
  const cs = readStream(pageObj, u.stream)
  const segEnd = extendOverTrailingQs(cs, u.start, u.end)
  const seg = cs.slice(u.start, segEnd)
  // unit bbox (device, top-left) → the unit's user space
  const inv = invertM(u.ctm)
  const toU = (dx, dyTop) => { const uy = H - dyTop; return [inv[0] * dx + inv[2] * uy + inv[4], inv[1] * dx + inv[3] * uy + inv[5]] }
  const [xA, yA] = toU(u.bbox[0], u.bbox[1])
  const [xB, yB] = toU(u.bbox[2], u.bbox[3])
  const x = Math.min(xA, xB), yBot = Math.min(yA, yB), w = Math.abs(xB - xA), h = Math.abs(yB - yA)
  const rU = radius / (Math.abs(u.ctm[0]) || 1) // radius is given in device pt
  const path = roundRectPath(x, yBot, w, h, rU)
  // swap ONLY the construction ops (first m/re/… to the last one before the paint op)
  const CONSTR = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h'])
  let first = -1, last = -1, numStart = -1
  for (const mt of mask(seg).matchAll(TOKENS)) {
    if (isNum(mt[0])) { if (numStart < 0) numStart = mt.index; continue }
    if (CONSTR.has(mt[0])) {
      if (first < 0) first = numStart >= 0 ? numStart : mt.index
      last = mt.index + mt[0].length
    }
    numStart = -1
  }
  if (first < 0) throw new Error('no path found in the unit')
  let seg2 = seg.slice(0, first) + path + seg.slice(last)
  // persist the radius as a %EFR comment INSIDE the unit — PDF has no "corner radius" property
  // (only the curves), so this is what the model reads back into the panel
  if (/%EFR [\d.]+/.test(seg2)) seg2 = seg2.replace(/%EFR [\d.]+/, `%EFR ${n2(radius)}`)
  else seg2 = `\n%EFR ${n2(radius)}\n` + seg2
  writeStream(pageObj, u.stream, cs.slice(0, u.start) + seg2 + cs.slice(segEnd))
}
function insertShape(pageIndex, kind, geo, style) {
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const po = doc.findPage(pageIndex)
  const cs = readStream(po, 0)
  const end = streamEndState(cs)
  let prefix = end.depth > 0 ? 'Q'.repeat(end.depth) + '\n' : ''
  let suffix = ''
  if (!isIdentityM(end.base)) {
    const iv = invertM(end.base)
    prefix += `q ${iv.map((v) => +v.toFixed(6)).join(' ')} cm\n`
    suffix = 'Q\n'
  }
  let ops = shapeOps(kind, geo, style, H)
  if (kind === 'rect' && style.radius > 0) ops = `%EFR ${n2(style.radius)}\n` + ops // readable back as the vector's radius
  // lines/arrows persist their endpoints (device pt, top-left) — the UI drags them freely
  if (kind === 'line' || kind === 'arrow') ops = `%EFL ${kind === 'line' ? 'line' : style.head || 'open'} ${n2(geo.x1)} ${n2(geo.y1)} ${n2(geo.x2)} ${n2(geo.y2)}\n` + ops
  writeStream(po, 0, cs + '\n' + prefix + ops + suffix)
}

// Variable definitions (the PDF template fields) live in the document catalog under a private key
// /EFVariables as a JSON string — so they travel inside the file and survive save/reopen.
function pdfDoc() { return doc.asPDF ? (doc.asPDF() || doc) : doc }
function writeVariables(json) {
  const pdf = pdfDoc()
  const root = pdf.getTrailer().get('Root')
  if (json && json.length) root.put('EFVariables', pdf.newString(json))
  else { try { root.delete('EFVariables') } catch (_) {} }
}
function readVariables() {
  try {
    const o = pdfDoc().getTrailer().get('Root').get('EFVariables')
    if (o && !(o.isNull && o.isNull())) return o.asString()
  } catch (_) {}
  return null
}

// Insert a raster image (PNG/JPEG bytes) at x/y (pt, top-left) with the given size. Same
// end-of-stream neutralisation as text, so a leftover flipped CTM can't mirror or displace it.
let insImgSeq = 0
function insertImage(pageIndex, bytes, x, y, w, h) {
  const img = new mupdf.Image(new Uint8Array(bytes))
  const ref = doc.addImage(img)
  const name = 'EFIm' + insImgSeq++
  const po = doc.findPage(pageIndex)
  let res = po.getInheritable('Resources')
  if (!res || res.isNull()) { res = doc.newDictionary(); po.put('Resources', res) }
  let xo = res.get('XObject')
  if (xo.isNull()) { xo = doc.newDictionary(); res.put('XObject', xo) }
  xo.put(name, ref)
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const cs = readStream(po, 0)
  const end = streamEndState(cs)
  let prefix = end.depth > 0 ? 'Q'.repeat(end.depth) + '\n' : ''
  let suffix = ''
  if (!isIdentityM(end.base)) {
    const iv = invertM(end.base)
    prefix += `q ${iv.map((v) => +v.toFixed(6)).join(' ')} cm\n`
    suffix = 'Q\n'
  }
  const ops = `q ${n2(w)} 0 0 ${n2(h)} ${n2(x)} ${n2(H - y - h)} cm /${name} Do Q\n`
  writeStream(po, 0, cs + '\n' + prefix + ops + suffix)
}

// Shift object coordinates INSIDE the content stream: text → Tm (or the first Td), image → its
// positioning cm, vector → path construction points. items: [{ type, bbox, x?, y?, dx, dy }] (dx/dy
// in pt, screen-down positive). Each item is matched to its unit by exact anchor first, and several
// items sharing one unit shift it ONCE.
function moveObjectsImpl(pageIndex, items) {
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const pageObj = doc.findPage(pageIndex)
  const units = collectUnits(pageObj, H)
  const jobMap = new Map() // unit → {dx, dy}
  const lineSeen = new Set()
  const lineJobs = [] // per-LINE moves inside a multi-line text unit
  for (const it of items || []) {
    const best = matchUnit(units, it)
    if (!best) continue
    const pys = best.type === 'text' && best.shows ? best.shows.map((sh) => sh.py) : []
    const spread = pys.length > 1 ? Math.max(...pys) - Math.min(...pys) : 0
    if (spread > 3 && it.type === 'text' && it.y !== undefined) {
      // a multi-line BT..ET block: shift ONLY the picked line — a Td before its first show and the
      // INVERSE Td after its last one, so the text line matrix (and every following line) stays put
      const k = best.start + '|' + Math.round(it.y * 2)
      if (!lineSeen.has(k)) { lineSeen.add(k); lineJobs.push({ u: best, y: it.y, dx: it.dx, dy: it.dy }) }
    } else if (!jobMap.has(best)) jobMap.set(best, { dx: it.dx, dy: it.dy })
  }
  const byStream = {}
  for (const [u, d] of jobMap) (byStream[u.stream] = byStream[u.stream] || []).push({ kind: 'unit', u, dx: d.dx, dy: d.dy })
  for (const j of lineJobs) (byStream[j.u.stream] = byStream[j.u.stream] || []).push({ kind: 'line', ...j })
  let moved = 0
  for (const sk of Object.keys(byStream)) {
    const s = Number(sk)
    let cs = readStream(pageObj, s)
    const edits = []
    for (const job of byStream[sk]) {
      if (job.kind === 'unit') {
        edits.push({ pos: job.u.start, run: () => { cs = cs.slice(0, job.u.start) + shiftSeg(job.u, cs.slice(job.u.start, job.u.end), job.dx, job.dy) + cs.slice(job.u.end) } })
      } else {
        const shows = job.u.shows.filter((sh) => Math.abs(sh.py - job.y) < 2).sort((a, b) => a.start - b.start)
        if (!shows.length) continue
        // Td offsets live in TEXT space: they are multiplied by the line matrix (a 7pt Tm scales a
        // Td by 7) — divide by both the CTM scale and the line-matrix scale
        const de = job.dx / (job.u.sa || 1) / (shows[0].ta || 1), df = -job.dy / (job.u.sd || 1) / (shows[0].td || 1)
        const first = shows[0].start, last = shows[shows.length - 1].end
        edits.push({ pos: first, run: () => {
          cs = cs.slice(0, last) + `\n${n2(-de)} ${n2(-df)} Td\n` + cs.slice(last)
          cs = cs.slice(0, first) + `\n${n2(de)} ${n2(df)} Td\n` + cs.slice(first)
        } })
      }
      moved++
    }
    edits.sort((a, b) => b.pos - a.pos) // right-to-left keeps byte offsets valid
    for (const e of edits) e.run()
    writeStream(pageObj, s, cs)
  }
  return moved
}

// Duplicate objects INSIDE the stream: each matched unit's bytes are re-inserted after the original
// (same graphics state, so fonts/colors carry over), coordinates shifted by dx/dy (screen-down pt).
function copyObjectsImpl(pageIndex, items, dx, dy) {
  const lp = doc.loadPage(pageIndex)
  const H = lp.getBounds()[3]; lp.destroy()
  const pageObj = doc.findPage(pageIndex)
  const units = collectUnits(pageObj, H)
  const found = new Set()
  for (const it of items || []) {
    const best = matchUnit(units, it)
    if (best) found.add(best)
  }
  const byStream = {}
  for (const u of found) (byStream[u.stream] = byStream[u.stream] || []).push(u)
  for (const sk of Object.keys(byStream)) {
    const s = Number(sk)
    let cs = readStream(pageObj, s)
    const list = byStream[sk].sort((a, b) => b.end - a.end) // right-to-left keeps offsets valid
    for (const u of list) {
      // the copy must land AFTER the original's closing Q's — inserting right after the paint op
      // would put it INSIDE the original's q-blocks, and a self-wrapped unit (our inserted shapes
      // carry their own anti-flip cm) would apply that transform TWICE (copy came out 4-17x the
      // size). segEnd also makes the copied segment self-contained (q's + their Q's).
      const segEnd = extendOverTrailingQs(cs, u.start, u.end)
      // balance the copy (an unmatched Q inside would cancel any wrapper and leak state), then
      // shift its own coordinates — same operator surgery as moveObjects
      const copy = shiftSeg(u, balanceSeg(cs.slice(u.start, segEnd)), dx, dy)
      cs = cs.slice(0, segEnd) + '\n' + copy + '\n' + cs.slice(segEnd)
    }
    writeStream(pageObj, s, cs)
  }
  return found.size
}

// physically remove objects from the page stream: text — surgically (blank its own show op);
// images/vectors and unmatched text — via redaction, grouped by type so each pass only touches
// its own kind (text redaction won't eat an image underneath, etc.)
function deleteObjectsImpl(pageIndex, items, textOnly = false) {
  const textLeftovers = blankTextShows(pageIndex, items)
  // variables re-apply blanks a chain whose extra pieces were ALREADY blanked on a prior edit — those
  // "leftovers" must be dropped silently, never redacted (redaction would paint boxes over the page)
  if (textOnly) return
  const page = doc.loadPage(pageIndex)
  try {
    const groups = { text: [], image: [], vector: [] }
    for (const it of textLeftovers) groups.text.push(it.bbox)
    for (const it of items || []) if (it.type !== 'text' && groups[it.type]) groups[it.type].push(it.bbox)
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
  } finally { page.destroy() }
}

// Test hooks: the SAME functions the worker runs are importable in Node — no copies, one source of
// truth for behaviour. Harmless in the browser (module worker).
export const __test = {
  setDoc: (d) => { doc = d; insFonts = {}; insFontSeq = 0 },
  getModel: (...a) => getModel(...a),
  collectUnits,
  moveObjectsImpl: (...a) => moveObjectsImpl(...a),
  copyObjectsImpl: (...a) => copyObjectsImpl(...a),
  deleteObjectsImpl: (...a) => deleteObjectsImpl(...a),
  insertShape: (...a) => insertShape(...a),
  insertImage: (...a) => insertImage(...a),
  resizeObject: (...a) => resizeObject(...a),
  recolorVector: (...a) => recolorVector(...a),
  setVectorRadius: (...a) => setVectorRadius(...a),
  setStrokeWidth: (...a) => setStrokeWidth(...a),
  setOpacity: (...a) => setOpacity(...a),
  setDash: (...a) => setDash(...a),
  setLineGeo: (...a) => setLineGeo(...a),
  readStreamOf: (pageObj, n) => readStream(pageObj, n),
  textOnlyPixmap: (...a) => textOnlyPixmap(...a),
  matchUnit,
  replaceTextImpl: (pageIndex, items, spec, fonts, fallback, textOnly) => {
    const recs = prepareInsFonts(pageIndex, fonts, fallback, samplesOf(spec))
    deleteObjectsImpl(pageIndex, items, textOnly)
    insertTextWithRecs(pageIndex, spec, recs)
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') self.postMessage({ ready: true })
if (typeof self !== 'undefined') self.onmessage = (e) => {
  const { id, type, params } = e.data
  try {
    if (type === 'open') {
      doc = mupdf.Document.openDocument(new Uint8Array(params.data), 'application/pdf')
      insFonts = {}; insFontSeq = 0
      self.postMessage({ id, result: { pageCount: doc.countPages() } })
    } else if (type === 'getModel') {
      if (!doc) throw new Error('no document open')
      self.postMessage({ id, result: getModel(params.pageIndex) })
    } else if (type === 'renderImage') {
      if (!doc) throw new Error('no document open')
      const r = renderImage(params.pageIndex, params.scale)
      self.postMessage({ id, result: r }, [r.png])
    } else if (type === 'moveObjects') {
      if (!doc) throw new Error('no document open')
      const moved = moveObjectsImpl(params.pageIndex, params.items)
      self.postMessage({ id, result: { ok: true, moved, of: (params.items || []).length } })
    } else if (type === 'renderObjects') {
      if (!doc) throw new Error('no document open')
      const r = renderObjects(params.pageIndex, params.zs, params.bbox, params.scale)
      self.postMessage({ id, result: r }, [r.png])
    } else if (type === 'recolorVector') {
      if (!doc) throw new Error('no document open')
      recolorVector(params.pageIndex, params.item, params.colors)
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'setVectorRadius') {
      if (!doc) throw new Error('no document open')
      setVectorRadius(params.pageIndex, params.item, params.radius)
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'setStrokeWidth') {
      if (!doc) throw new Error('no document open')
      setStrokeWidth(params.pageIndex, params.item, params.w)
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'setLineGeo') {
      if (!doc) throw new Error('no document open')
      setLineGeo(params.pageIndex, params.item, params.geo)
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'setDash') {
      if (!doc) throw new Error('no document open')
      setDash(params.pageIndex, params.item, params.dash)
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'setOpacity') {
      if (!doc) throw new Error('no document open')
      setOpacity(params.pageIndex, params.item, params.alpha)
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'insertShape') {
      if (!doc) throw new Error('no document open')
      insertShape(params.pageIndex, params.kind, params.geo, params.style)
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'resizeObject') {
      if (!doc) throw new Error('no document open')
      resizeObject(params.pageIndex, params.item, params.nb)
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'insertImage') {
      if (!doc) throw new Error('no document open')
      insertImage(params.pageIndex, params.bytes, params.x, params.y, params.w, params.h)
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'insertText') {
      if (!doc) throw new Error('no document open')
      insertText(params.pageIndex, params.spec, params.fonts, params.fallback)
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'getFontsInfo') {
      if (!doc) throw new Error('no document open')
      const fonts = getFontsInfo()
      self.postMessage({ id, result: { fonts } }, fonts.map((f) => f.bytes).filter(Boolean))
    } else if (type === 'writeVariables') {
      if (!doc) throw new Error('no document open')
      writeVariables(params.json)
      self.postMessage({ id, result: { ok: true } })
    } else if (type === 'readVariables') {
      if (!doc) throw new Error('no document open')
      self.postMessage({ id, result: { json: readVariables() } })
    } else if (type === 'save') {
      // serialise the in-memory working copy (with all moves/deletes applied) back to PDF bytes
      if (!doc) throw new Error('no document open')
      const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array())
      self.postMessage({ id, result: { bytes: bytes.buffer } }, [bytes.buffer])
    } else if (type === 'copyObjects') {
      if (!doc) throw new Error('no document open')
      self.postMessage({ id, result: { ok: true, copied: copyObjectsImpl(params.pageIndex, params.items, params.dx || 0, params.dy || 0) } })
    } else if (type === 'deleteObjects') {
      if (!doc) throw new Error('no document open')
      deleteObjectsImpl(params.pageIndex, params.items)
      self.postMessage({ id, result: { ok: true, deleted: (params.items || []).length } })
    } else if (type === 'replaceText') {
      // ATOMIC delete+insert: fonts are resolved and VALIDATED first — if anything is wrong the
      // operation throws here and nothing has been deleted
      if (!doc) throw new Error('no document open')
      const recs = prepareInsFonts(params.pageIndex, params.fonts, params.fallback, samplesOf(params.spec))
      deleteObjectsImpl(params.pageIndex, params.items, params.textOnly)
      insertTextWithRecs(params.pageIndex, params.spec, recs)
      self.postMessage({ id, result: { ok: true } })
    } else throw new Error('unknown request: ' + type)
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) })
  }
}
