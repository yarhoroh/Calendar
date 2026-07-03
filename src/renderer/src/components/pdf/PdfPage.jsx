import { useEffect, useRef, useState } from 'react'
import RichTextEditor from './RichTextEditor'

// One page: a raster <img> (the exact visual) + a SINGLE transparent overlay that captures the mouse.
// Everything is computed from the JSON model — no per-object divs:
//  • click             → hit-test (topmost by z, ties → smaller box) → select one object
//  • drag on empty     → rubber-band; on release every object intersecting it forms a group (only the
//                        union frame is drawn — not each object)
//  • drag ON selection → move: a ghost (a CSS window into the LIVE page raster, so it stays crisp
//                        across zoom) follows the cursor; on drop the coordinates are shifted inside
//                        the PDF stream
//  • double-click IN the selection → the objects are physically removed from the PDF stream
const PAD = 2 // pt — extra hit slack around hairline-thin objects

// distance from a point to a segment — lines/arrows are hit along their TRAJECTORY, not their bbox
const distSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1
  const ll = dx * dx + dy * dy
  const t = ll ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / ll)) : 0
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}
const lineHitPad = (o) => (o.strokeW || 1) / 2 + 3 // half stroke + finger padding, pt
const hitTest = (objects, x, y) => {
  const under = (o) => {
    if (o.line) return distSeg(x, y, o.line.x1, o.line.y1, o.line.x2, o.line.y2) <= lineHitPad(o)
    const padX = o.bbox.w < PAD ? PAD : 0
    const padY = o.bbox.h < PAD ? PAD : 0
    return x >= o.bbox.x - padX && x <= o.bbox.x + o.bbox.w + padX && y >= o.bbox.y - padY && y <= o.bbox.y + o.bbox.h + padY
  }
  const pick = (list) => {
    let best = null
    for (const o of list) {
      if (!under(o)) continue
      if (!best) { best = o; continue }
      if ((o.z || 0) > (best.z || 0)) best = o
      else if ((o.z || 0) === (best.z || 0) && o.bbox.w * o.bbox.h < best.bbox.w * best.bbox.h) best = o
    }
    return best
  }
  // TEXT first: a click on text picks the text, even if an art object sits on top of it; only when
  // no text is under the cursor do images/vectors get selected
  return pick(objects.filter((o) => o.type === 'text')) || pick(objects.filter((o) => o.type !== 'text'))
}
const unionOf = (objs) => {
  if (!objs.length) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const o of objs) { x0 = Math.min(x0, o.bbox.x); y0 = Math.min(y0, o.bbox.y); x1 = Math.max(x1, o.bbox.x + o.bbox.w); y1 = Math.max(y1, o.bbox.y + o.bbox.h) }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
const inside = (r, x, y) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

// resize handles: 4 corners + 4 edge midpoints, standard cursors
const HANDLES = [
  ['nw', 0, 0, 'nwse-resize'], ['n', 0.5, 0, 'ns-resize'], ['ne', 1, 0, 'nesw-resize'],
  ['e', 1, 0.5, 'ew-resize'], ['se', 1, 1, 'nwse-resize'], ['s', 0.5, 1, 'ns-resize'],
  ['sw', 0, 1, 'nesw-resize'], ['w', 0, 0.5, 'ew-resize']
]

export default function PdfPage({ page, image, scale, selected, selMode, showAll, nudge, insertMode, textEdit, pipette, rte, onSelect, onMove, onResize, onResizeRot, onRotate, onLineGeo, onLiveGeo, onSprite, onMenu, onInsertAt, onPipettePick, onTextCommit, onTextCancel }) {
  const { pageIndex, runs, images, vectors } = page
  const objects = [...runs, ...(images || []), ...(vectors || [])]
  const W = (image?.width ?? page.width) * scale
  const H = (image?.height ?? page.height) * scale
  const [marquee, setMarquee] = useState(null) // {x,y,w,h} in pt while rubber-banding
  const [ghost, setGhost] = useState(null) // {dx,dy} in pt while moving the selection
  const [resizeBox, setResizeBox] = useState(null) // live bbox while dragging a handle
  const [lineDrag, setLineDrag] = useState(null) // live endpoints while dragging a line/arrow end
  const [sprite, setSprite] = useState(null) // transparent render of ONLY the dragged objects
  const [snapLines, setSnapLines] = useState(null) // { x:{v,a,b}, y:{v,a,b} } — magnetic guides while snapping
  const [pivot, setPivot] = useState(null) // {x,y} pt — rotation centre; null = selection centre
  const [rotDrag, setRotDrag] = useState(null) // { angle, cx, cy, pending? } — live rotation preview
  const [rotResize, setRotResize] = useState(null) // live oriented box while resizing a rotated object
  const dragRef = useRef(null)

  // the selection carries the resolved objects themselves — nothing is re-filtered from the model
  const selObjs = selected && selected.page === pageIndex ? selected.objs : []
  const union = unionOf(selObjs)

  const dropSprite = () => setSprite((s) => { if (s) URL.revokeObjectURL(s.url); return null })

  // a ghost parked after a drop dissolves as soon as the freshly rendered page image arrives
  useEffect(() => {
    setGhost((g) => { if (!g?.pending) return g; dropSprite(); return null })
    setRotDrag((r) => { if (!r?.pending) return r; dropSprite(); return null })
  }, [image?.url]) // eslint-disable-line react-hooks/exhaustive-deps

  // the rotation pivot belongs to ONE selection — a new selection gets a fresh (centred) pivot.
  // EXCEPT right after a rotation commit: the reselect must NOT swallow a user-moved pivot, or the
  // next turn spins around a different point ("the centre jumps"). A parked (pending) rotation
  // preview dies here always: the refreshed selection already carries the new angle, so base+delta
  // would double-rotate for one frame (the frame "flashed" on release).
  const keepPivotRef = useRef(false)
  useEffect(() => {
    if (keepPivotRef.current) keepPivotRef.current = false
    else setPivot(null)
    setRotDrag((r) => (r?.pending ? null : r))
    // a parked MOVE ghost dies here too: the shifted selection already carries the destination, so
    // union+ghost.dx would DOUBLE the shift for one frame (the frame jumped by 2× the move)
    setGhost((g) => { if (!g?.pending) return g; dropSprite(); return null })
  }, [selected])

  const toPt = (e, el) => {
    const r = el.getBoundingClientRect()
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]
  }

  // ROTATED frame of a single rotated object, anchored at its TOP-LEFT re-derived from the angle
  // (render with transform-origin 0 0). Text: exact baseline anchor from the stream + font metrics
  // (asc 0.78em / desc 0.22em). Vector/image: the worker's oriented box (local bounds × ctm — exact
  // at ANY angle). Returns { x, y (top-left, pt), w, h, ang (screen deg), u, d (axis unit vectors) }.
  const rotFrameOf = (o) => {
    if (!o?.rot) return null
    const ang = -o.rot // screen angle = −pdf rot
    const rad = ang * Math.PI / 180
    const cA = Math.cos(rad), sA = Math.sin(rad)
    const u = { x: cA, y: sA } // along the object
    const d = { x: -sA, y: cA } // perpendicular, descent side (down-screen at ang=0)
    // the worker's oriented box (ink-scanned for text, local-bounds for vectors/images) — exact
    if (o.obw > 0 && o.obh > 0 && o.ox !== undefined) return { x: o.ox, y: o.oy, w: o.obw, h: o.obh, ang, u, d }
    if (o.type === 'text') {
      // metric fallback (ink box unavailable): baseline anchor + font metrics
      const size = o.size || 10
      const asc = size * 0.78, desc = size * 0.22, h = asc + desc
      const cAb = Math.abs(cA), sAb = Math.abs(sA)
      const w = cAb >= sAb ? (o.bbox.w - h * sAb) / cAb : (o.bbox.h - h * cAb) / sAb
      if (!(w > 1)) return null
      return { x: o.x - d.x * asc, y: o.y - d.y * asc, w, h, ang, u, d } // top-left = baseline − d·asc
    }
    return null
  }

  // resize a ROTATED object by its handles: deltas are projected onto the object's OWN axes, the
  // opposite corner stays pinned; commit sends {kx, ky, anchor, ang} — the worker scales along the
  // object's axes (an axis-space scale would skew it)
  const startResizeRot = (e, fx, fy) => {
    e.preventDefault(); e.stopPropagation()
    const el = e.currentTarget.closest('.pdfed__overlay')
    const o = selObjs[0]
    const fr0 = rotFrameOf(o)
    if (!fr0) return
    const { u, d } = fr0
    const sxd = fx === 0 ? -1 : fx === 1 ? 1 : 0
    const syd = fy === 0 ? -1 : fy === 1 ? 1 : 0
    const axf = 1 - fx, ayf = 1 - fy // the fixed (opposite) corner in frame fractions
    const A = { x: fr0.x + u.x * axf * fr0.w + d.x * ayf * fr0.h, y: fr0.y + u.y * axf * fr0.w + d.y * ayf * fr0.h }
    const [mx0, my0] = toPt(e, el)
    const calc = (ev) => {
      const [mx, my] = toPt(ev, el)
      const dx = mx - mx0, dy = my - my0
      const du = dx * u.x + dy * u.y, dv = dx * d.x + dy * d.y // mouse delta in LOCAL axes
      let W = sxd ? Math.max(2, fr0.w + du * sxd) : fr0.w
      let Hh = syd ? Math.max(2, fr0.h + dv * syd) : fr0.h
      if (ev.shiftKey && sxd && syd) { const k = Math.max(W / fr0.w, Hh / fr0.h); W = fr0.w * k; Hh = fr0.h * k }
      return { x: A.x - u.x * axf * W - d.x * ayf * Hh, y: A.y - u.y * axf * W - d.y * ayf * Hh, w: W, h: Hh, ang: fr0.ang, u, d, kx: W / fr0.w, ky: Hh / fr0.h }
    }
    const move = (ev) => setRotResize(calc(ev))
    const up = (ev) => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
      setRotResize(null)
      const r = calc(ev)
      if (Math.abs(r.kx - 1) > 0.01 || Math.abs(r.ky - 1) > 0.01) onResizeRot?.(pageIndex, o, { kx: r.kx, ky: r.ky, ax: A.x, ay: A.y, ang: fr0.ang })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // drag the rotate handle: live angle around the pivot; Shift snaps to 15° steps (0/45/90…).
  // The PDF changes once, on drop — same contract as move/resize.
  const startRotate = (e, c) => {
    e.stopPropagation(); e.preventDefault()
    const el = e.currentTarget.closest('.pdfed__overlay')
    onSprite?.(pageIndex, selObjs).then((s) => { if (s) setSprite((old) => { if (old) URL.revokeObjectURL(old.url); return s }) })
    const fr0 = selObjs.length === 1 ? rotFrameOf(selObjs[0]) : null // frozen at drag start
    const u0 = unionOf(selObjs)
    const [sx0, sy0] = toPt(e, el)
    const a0 = Math.atan2(sy0 - c.y, sx0 - c.x)
    // Shift snaps the object's TOTAL angle to 15° steps relative to the PAGE (0/45/90…), not the
    // drag delta — so a tilted text can be squared up straight to 0°
    const rot0 = selObjs.length === 1 ? -(selObjs[0].rot || 0) : 0
    let cur = 0
    const move = (ev) => {
      const [mx, my] = toPt(ev, el)
      let a = (Math.atan2(my - c.y, mx - c.x) - a0) * 180 / Math.PI
      a = ((a + 540) % 360) - 180 // normalize to (-180, 180]
      if (ev.shiftKey) a = Math.round((rot0 + a) / 15) * 15 - rot0
      cur = a
      setRotDrag({ angle: a, cx: c.x, cy: c.y })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (Math.abs(cur) > 0.3) {
        // park a FROZEN snapshot of the final frame until the fresh render lands: a live-computed
        // preview would re-read the UPDATED selection (new angle) for one frame and double-rotate
        const rad2 = cur * Math.PI / 180
        const cd = Math.cos(rad2), sd = Math.sin(rad2)
        const frame = fr0
          ? { x: c.x + cd * (fr0.x - c.x) - sd * (fr0.y - c.y), y: c.y + sd * (fr0.x - c.x) + cd * (fr0.y - c.y), w: fr0.w, h: fr0.h, ang: fr0.ang + cur }
          : u0
            ? { x: u0.x, y: u0.y, w: u0.w, h: u0.h, ang: cur, px: c.x - u0.x, py: c.y - u0.y } // axis box spins about the pivot
            : null
        keepPivotRef.current = true // a user-moved pivot survives the commit's reselect
        setRotDrag({ angle: cur, cx: c.x, cy: c.y, pending: true, frame })
        onRotate?.(pageIndex, selObjs, cur, c.x, c.y)
      } else { setRotDrag(null); dropSprite() }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const startPivotDrag = (e) => {
    e.stopPropagation(); e.preventDefault()
    const el = e.currentTarget.closest('.pdfed__overlay')
    const move = (ev) => { const [mx, my] = toPt(ev, el); setPivot({ x: mx, y: my }) }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // press-and-drag: ghost follows the cursor, the PDF changes once, on drop; a plain click (<1pt)
  // just leaves the selection in place (double-click on it → delete)
  const startMoveDrag = (el, sx, sy, objs) => {
    // ask for a clean sprite of ONLY the dragged objects (until it lands, per-object raster windows serve)
    onSprite?.(pageIndex, objs).then((s) => { if (s) setSprite((old) => { if (old) URL.revokeObjectURL(old.url); return s }) })
    const u0 = unionOf(objs)
    // snap candidates: the left/centre/right and top/middle/bottom lines of every OTHER object
    // (computed once at drag start). With Shift held, the union magnetically sticks to a line within
    // ~3 screen px and releases when pulled away.
    const selIds = new Set(objs.map((o) => o.id))
    const candX = [], candY = []
    for (const o of objects) {
      if (selIds.has(o.id)) continue
      const b = o.bbox
      candX.push({ v: b.x, a: b.y, z: b.y + b.h }, { v: b.x + b.w, a: b.y, z: b.y + b.h }) // left, right edges
      candY.push({ v: b.y, a: b.x, z: b.x + b.w }, { v: b.y + b.h, a: b.x, z: b.x + b.w }) // top, bottom edges
      // text: also its BASELINE — the exact, non-raster coordinate. Aligning two texts by baseline
      // puts them truly on one row (bbox tops are ink-tightened and can be ~1px fuzzy)
      if (o.type === 'text' && o.y != null) candY.push({ v: o.y, a: b.x, z: b.x + b.w })
    }
    // the dragged object's OWN baseline (single text) participates in the Y-snap too
    const dragBase = objs.length === 1 && objs[0].type === 'text' && objs[0].y != null ? objs[0].y : null
    const yEdges = (dy) => dragBase != null ? [u0.y + dy, u0.y + u0.h + dy, dragBase + dy] : [u0.y + dy, u0.y + u0.h + dy]
    const snap = (dx, dy) => {
      const th = 4 / scale // ~4 screen pixels
      // best correction per axis (nearest edge within threshold)
      const bestD = (edges, cand) => {
        let best = null
        for (const e of edges) for (const c of cand) { const d = c.v - e; if (Math.abs(d) < th && (best === null || Math.abs(d) < Math.abs(best))) best = d }
        return best
      }
      const cx = bestD([u0.x + dx, u0.x + u0.w + dx], candX)
      const cy = bestD(yEdges(dy), candY)
      const ndx = dx + (cx ?? 0), ndy = dy + (cy ?? 0)
      // AFTER snapping, show a guide for EVERY candidate edge that now coincides with a dragged edge
      // (so aligning bottoms shows the BOTTOM line, and if tops line up too, both appear)
      const fex = [u0.x + ndx, u0.x + u0.w + ndx]
      const fey = yEdges(ndy)
      const gxs = cx === null ? [] : candX.filter((c) => fex.some((e) => Math.abs(c.v - e) < 0.5))
      const gys = cy === null ? [] : candY.filter((c) => fey.some((e) => Math.abs(c.v - e) < 0.5))
      return { dx: ndx, dy: ndy, gxs, gys }
    }
    // Ctrl while dragging → the move is locked to the axis of the FIRST significant displacement
    let axis = null
    const lock = (dx, dy, ctrl) => {
      if (!ctrl) { axis = null; return [dx, dy] }
      if (!axis && Math.hypot(dx, dy) > 3) axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
      return axis === 'x' ? [dx, 0] : axis === 'y' ? [0, dy] : [dx, dy]
    }
    const resolve = (rawx, rawy, ev) => {
      const [dx, dy] = lock(rawx, rawy, ev.ctrlKey)
      if (ev.shiftKey) { const s = snap(dx, dy); return [s.dx, s.dy, s.gxs, s.gys] }
      return [dx, dy, [], []]
    }
    const move = (ev) => {
      const [mx, my] = toPt(ev, el)
      const [dx, dy, gxs, gys] = resolve(mx - sx, my - sy, ev)
      setGhost({ dx, dy })
      setSnapLines(gxs.length || gys.length ? { xs: gxs, ys: gys } : null)
      if (u0) onLiveGeo?.({ x: u0.x + dx, y: u0.y + dy, w: u0.w, h: u0.h }) // live X/Y in the panel
    }
    const up = (ev) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      onLiveGeo?.(null)
      setSnapLines(null)
      const [ux, uy] = toPt(ev, el)
      const [dx, dy] = resolve(ux - sx, uy - sy, ev)
      if (Math.hypot(dx, dy) >= 1) {
        // keep the ghost parked at the drop spot while the worker re-renders the page — the object
        // looks like it's already there instead of vanishing and "jumping" seconds later
        setGhost({ dx, dy, pending: true })
        onMove(pageIndex, objs, dx, dy)
      } else { setGhost(null); dropSprite() }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const onDown = (e) => {
    const el = e.currentTarget
    const [x, y] = toPt(e, el)
    e.stopPropagation()

    // eyedropper first — it must work WHILE editing (click any text to copy its style into the
    // open editor); it never changes the selection or closes the editor
    if (pipette) {
      const hit = hitTest(objects, x, y)
      if (hit && hit.type === 'text') onPipettePick(pageIndex, hit)
      return
    }

    // otherwise an open text editor swallows this click: it only commits/closes the editor and must
    // NOT select whatever element happens to be under the cursor
    if (textEdit) return

    // shape mode: click places a default-size shape, drag draws it to size (marquee preview)
    if (insertMode?.shape) {
      const move = (ev) => {
        const [mx, my] = toPt(ev, el)
        setMarquee({ x: Math.min(x, mx), y: Math.min(y, my), w: Math.abs(mx - x), h: Math.abs(my - y) })
      }
      const up = (ev) => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        setMarquee(null)
        const [ux, uy] = toPt(ev, el)
        onInsertAt(pageIndex, x, y, { x1: x, y1: y, x2: ux, y2: uy })
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      return
    }

    // insert text/image mode: the click just places it
    if (insertMode) { onInsertAt(pageIndex, x, y); return }

    // In 'block' mode a click on any line of a multi-line text BLOCK (bN.l0, bN.l1, …) selects the
    // whole block — it is ONE object in the PDF. 'single' mode (and the rubber-band) picks lines.
    const blockOf = (o) => (o.type === 'text' ? String(o.id).split('.')[0] : null)
    const groupHit = (h) => {
      if (selMode !== 'block') return [h]
      const b = blockOf(h)
      if (!b) return [h]
      const grp = objects.filter((o) => blockOf(o) === b)
      return grp.length ? grp : [h]
    }

    // Shift/Ctrl + click: add objects to the selection one by one (click a selected one → remove it).
    // Same result as the rubber-band, just piecewise. Never starts a drag or a marquee.
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const hit = hitTest(objects, x, y)
      if (hit) {
        const grp = groupHit(hit)
        const ids = new Set(grp.map((o) => o.id))
        const has = selObjs.some((o) => ids.has(o.id))
        onSelect(pageIndex, has ? selObjs.filter((o) => !ids.has(o.id)) : [...selObjs, ...grp.filter((o) => !selObjs.some((s) => s.id === o.id))])
      }
      return // empty additive click keeps the selection as is
    }

    // a single selected line/arrow moves only when grabbed NEAR ITS PATH — its axis-aligned bbox
    // (huge for a slanted line) must not swallow clicks on other content
    const selIsLine = selObjs.length === 1 && selObjs[0].line
    const onSel = selIsLine
      ? distSeg(x, y, selObjs[0].line.x1, selObjs[0].line.y1, selObjs[0].line.x2, selObjs[0].line.y2) <= lineHitPad(selObjs[0]) + 2
      : inside(union, x, y)
    if (onSel) { startMoveDrag(el, x, y, selObjs); return } // drag the existing selection

    const hit = hitTest(objects, x, y)
    if (hit) { const grp = groupHit(hit); onSelect(pageIndex, grp); startMoveDrag(el, x, y, grp); return } // select AND move in one gesture (whole text block)

    // empty space → rubber-band
    onSelect(pageIndex, null)
    dragRef.current = { x, y }
    const move = (ev) => {
      const [mx, my] = toPt(ev, el)
      const d = dragRef.current
      if (!d) return
      setMarquee({ x: Math.min(d.x, mx), y: Math.min(d.y, my), w: Math.abs(mx - d.x), h: Math.abs(my - d.y) })
    }
    const up = (ev) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const d = dragRef.current
      dragRef.current = null
      setMarquee(null)
      if (!d) return
      const [ux, uy] = toPt(ev, el)
      const box = { x: Math.min(d.x, ux), y: Math.min(d.y, uy), w: Math.abs(ux - d.x), h: Math.abs(uy - d.y) }
      if (box.w < 3 / scale && box.h < 3 / scale) return // just a click on empty space
      const objs = objects.filter((o) => o.bbox.x < box.x + box.w && o.bbox.x + o.bbox.w > box.x && o.bbox.y < box.y + box.h && o.bbox.y + o.bbox.h > box.y)
      onSelect(pageIndex, objs)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // right-click: on the selection (or an object — which gets selected first) → Copy/Delete menu;
  // on empty space → Paste menu, pasting AT the clicked point
  // drag a frame handle → live-resize the box; on drop the object is stretched in the stream.
  // Shift keeps the aspect ratio on corner handles.
  const nextBox = (b, h, dx, dy, keepRatio) => {
    let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h
    if (h.includes('w')) x0 += dx
    if (h.includes('e')) x1 += dx
    if (h.includes('n')) y0 += dy
    if (h.includes('s')) y1 += dy
    if (keepRatio && h.length === 2) { // corner + Shift → proportional
      const r = b.w / b.h
      const w = x1 - x0, hh = y1 - y0
      if (Math.abs(w) / r > Math.abs(hh)) { const nh = (Math.abs(w) / r) * Math.sign(hh || 1); if (h.includes('n')) y0 = y1 - nh; else y1 = y0 + nh }
      else { const nw = Math.abs(hh) * r * Math.sign(w || 1); if (h.includes('w')) x0 = x1 - nw; else x1 = x0 + nw }
    }
    const MIN = 2
    return {
      x: +Math.min(x0, x1).toFixed(2),
      y: +Math.min(y0, y1).toFixed(2),
      w: +Math.max(MIN, Math.abs(x1 - x0)).toFixed(2),
      h: +Math.max(MIN, Math.abs(y1 - y0)).toFixed(2)
    }
  }
  const startResize = (e, h) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget.closest('.pdfed__overlay')
    const obj = selObjs[0]
    const ob = obj.bbox
    const [sx0, sy0] = toPt(e, el)
    const move = (ev) => {
      const [mx, my] = toPt(ev, el)
      const nb = nextBox(ob, h, mx - sx0, my - sy0, ev.shiftKey)
      setResizeBox(nb)
      onLiveGeo?.(nb) // live W/H in the panel
    }
    const up = (ev) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setResizeBox(null)
      onLiveGeo?.(null)
      const [ux, uy] = toPt(ev, el)
      const nb = nextBox(ob, h, ux - sx0, uy - sy0, ev.shiftKey)
      if (Math.abs(nb.w - ob.w) > 0.5 || Math.abs(nb.h - ob.h) > 0.5 || Math.abs(nb.x - ob.x) > 0.5 || Math.abs(nb.y - ob.y) > 0.5) onResize(pageIndex, obj, nb)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // drag ONE endpoint of a line/arrow anywhere (free rotation); the other end stays pinned
  const startLineDrag = (e, which) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget.closest('.pdfed__overlay')
    const obj = selObjs[0]
    const L = obj.line
    const move = (ev) => {
      const [mx, my] = toPt(ev, el)
      const g = which === 1 ? { ...L, x1: mx, y1: my } : { ...L, x2: mx, y2: my }
      setLineDrag(g)
      onLiveGeo?.({ line: g }) // live X/Y/L in the panel
    }
    const up = (ev) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setLineDrag(null)
      onLiveGeo?.(null)
      const [ux, uy] = toPt(ev, el)
      const geo = which === 1 ? { ...L, x1: ux, y1: uy } : { ...L, x2: ux, y2: uy }
      if (Math.hypot(geo.x1 - L.x1, geo.y1 - L.y1) > 0.5 || Math.hypot(geo.x2 - L.x2, geo.y2 - L.y2) > 0.5) onLineGeo(pageIndex, obj, geo)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const onContext = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const [x, y] = toPt(e, e.currentTarget)
    if (inside(union, x, y)) { onMenu({ page: pageIndex, kind: 'sel', sx: e.clientX, sy: e.clientY }); return }
    const hit = hitTest(objects, x, y)
    if (hit) { onSelect(pageIndex, [hit]); onMenu({ page: pageIndex, kind: 'sel', sx: e.clientX, sy: e.clientY }); return }
    onMenu({ page: pageIndex, kind: 'empty', sx: e.clientX, sy: e.clientY, x, y })
  }

  const px = (r) => ({ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale })

  return (
    <div className="pdfed__page" style={{ width: W, height: H }}>
      {image && <img className="pdfed__img" src={image.url} width={W} height={H} draggable={false} alt="" />}
      <div className="pdfed__overlay" style={{ cursor: pipette ? 'copy' : insertMode === 'text' ? 'text' : insertMode ? 'crosshair' : undefined }} onMouseDown={onDown} onContextMenu={onContext}>
        {/* "All" — faint grey outline map of the page. Follows the cursor mode: 'block' outlines whole
            text GROUPS (bN), 'single' outlines individual elements — same granularity a click selects */}
        {showAll && (() => {
          let boxes = objects
          if (selMode === 'block') {
            const groups = new Map(); boxes = []
            for (const o of objects) {
              const b = o.type === 'text' ? String(o.id).split('.')[0] : null
              if (!b) { boxes.push(o); continue }
              const g = groups.get(b)
              if (!g) { const nb = { id: 'g' + b, bbox: { ...o.bbox } }; groups.set(b, nb); boxes.push(nb) }
              else {
                const x0 = Math.min(g.bbox.x, o.bbox.x), y0 = Math.min(g.bbox.y, o.bbox.y)
                const x1 = Math.max(g.bbox.x + g.bbox.w, o.bbox.x + o.bbox.w), y1 = Math.max(g.bbox.y + g.bbox.h, o.bbox.y + o.bbox.h)
                g.bbox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
              }
            }
          }
          return boxes.map((o) => (o.bbox.w > 1 && o.bbox.h > 0.5
            ? <div key={'a' + o.id} className="pdfed__allbox" style={px(o.bbox)} />
            : null))
        })()}
        {/* a single line/arrow gets a ROTATED frame hugging its path (an axis-aligned box around a
            slanted line is huge and misleading); it travels with the ghost/nudge */}
        {selObjs.length === 1 && selObjs[0].line && (() => {
          const o = selObjs[0]
          const L = lineDrag || o.line
          const gdx = ((ghost?.dx || 0) + (nudge?.dx || 0)) * scale, gdy = ((ghost?.dy || 0) + (nudge?.dy || 0)) * scale
          const x1 = L.x1 * scale + gdx, y1 = L.y1 * scale + gdy, x2 = L.x2 * scale + gdx, y2 = L.y2 * scale + gdy
          const padPx = 3 + ((o.strokeW || 1) / 2) * scale + (o.line.head && o.line.head !== 'line' ? Math.max(7, (o.strokeW || 1) * 4) * 0.5 * scale : 0)
          const len = Math.hypot(x2 - x1, y2 - y1) + padPx * 2
          const ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI
          return (
            <div
              className="pdfed__frame pdfed__frame--rot"
              style={{
                left: (x1 + x2) / 2 - len / 2,
                top: (y1 + y2) / 2 - padPx,
                width: len,
                height: padPx * 2,
                transform: `rotate(${ang}deg)`
              }}
            />
          )
        })()}
        {/* selection frame — the same light dashed box for one object or a whole group; while a
            ghost is up it travels with it; while a handle is dragged it shows the live box.
            A single ROTATED object gets a frame ALONG its own axis (like the line frames) — the
            axis-aligned quad box would look like it cuts / overshoots the slanted content. */}
        {!(selObjs.length === 1 && selObjs[0].line) && union && !rotDrag && (() => {
          const gdx = (ghost?.dx || 0) + (nudge?.dx || 0), gdy = (ghost?.dy || 0) + (nudge?.dy || 0)
          const fr = rotResize || (!resizeBox && selObjs.length === 1 ? rotFrameOf(selObjs[0]) : null)
          if (fr) {
            // top-left is re-derived from the angle every render; origin 0 0 keeps it exact
            return (
              <div
                className="pdfed__frame pdfed__frame--rot"
                style={{ left: (fr.x + gdx) * scale, top: (fr.y + gdy) * scale, width: fr.w * scale, height: fr.h * scale, transform: `rotate(${fr.ang}deg)`, transformOrigin: '0 0' }}
              />
            )
          }
          return (
            <div
              className="pdfed__frame"
              style={px(resizeBox
                ? resizeBox
                : { x: union.x + gdx, y: union.y + gdy, w: union.w, h: union.h })}
            />
          )
        })()}
        {/* rotation UI: pivot dot (draggable — the rotation centre) + a rotate grip at the bottom-right
            corner. Dragging the grip previews the rotation live (frame + sprite); Shift snaps to 15°.
            Works for a single object or a whole multi-selection (rotates as a group). */}
        {union && !ghost && !resizeBox && !rotResize && !textEdit && !insertMode && !lineDrag && (() => {
          // the rotate grip sits at the OBJECT'S OWN bottom-right corner — for a rotated object that
          // corner is re-derived from the angle every render (it turns with the object)
          const fr0 = selObjs.length === 1 ? rotFrameOf(selObjs[0]) : null
          const pad = 10 / scale
          const c = pivot || (fr0
            ? { x: fr0.x + fr0.u.x * fr0.w / 2 + fr0.d.x * fr0.h / 2, y: fr0.y + fr0.u.y * fr0.w / 2 + fr0.d.y * fr0.h / 2 }
            : { x: union.x + union.w / 2, y: union.y + union.h / 2 })
          const gx = fr0 ? fr0.x + fr0.u.x * (fr0.w + pad) + fr0.d.x * (fr0.h + pad) : union.x + union.w + pad
          const gy = fr0 ? fr0.y + fr0.u.y * (fr0.w + pad) + fr0.d.y * (fr0.h + pad) : union.y + union.h + pad
          return (
            <>
              {rotDrag && (() => {
                if (rotDrag.pending) {
                  // FROZEN final frame — computed at mouseup, independent of the (already updating)
                  // model/selection, so nothing can double-rotate or jump while the render lands
                  const f = rotDrag.frame
                  if (!f) return null
                  return f.px !== undefined
                    ? <div className="pdfed__frame pdfed__frame--rot" style={{ left: f.x * scale, top: f.y * scale, width: f.w * scale, height: f.h * scale, transform: `rotate(${f.ang}deg)`, transformOrigin: `${f.px * scale}px ${f.py * scale}px` }} />
                    : <div className="pdfed__frame pdfed__frame--rot" style={{ left: f.x * scale, top: f.y * scale, width: f.w * scale, height: f.h * scale, transform: `rotate(${f.ang}deg)`, transformOrigin: '0 0' }} />
                }
                if (!fr0) {
                  // unrotated base: spinning the div about the pivot point IS the desired transform
                  return <div className="pdfed__frame pdfed__frame--rot" style={{ ...px(union), transform: `rotate(${rotDrag.angle}deg)`, transformOrigin: `${(c.x - union.x) * scale}px ${(c.y - union.y) * scale}px` }} />
                }
                // rotated base: the preview = R_pivot(delta) ∘ R_topLeft(base). Composed: the top-left
                // ORBITS the pivot by delta, and the frame turns by base+delta about it — one origin
                // switch was wrong (the frame jumped by exactly the pivot offset at drag start)
                const rad = rotDrag.angle * Math.PI / 180
                const cd = Math.cos(rad), sd = Math.sin(rad)
                const tx = c.x + cd * (fr0.x - c.x) - sd * (fr0.y - c.y)
                const ty = c.y + sd * (fr0.x - c.x) + cd * (fr0.y - c.y)
                return <div className="pdfed__frame pdfed__frame--rot" style={{ left: tx * scale, top: ty * scale, width: fr0.w * scale, height: fr0.h * scale, transform: `rotate(${fr0.ang + rotDrag.angle}deg)`, transformOrigin: '0 0' }} />
              })()}
              {rotDrag && sprite && (
                <img
                  className="pdfed__ghost"
                  src={sprite.url}
                  style={{ ...px({ x: sprite.x, y: sprite.y, w: sprite.w, h: sprite.h }), transform: `rotate(${rotDrag.angle}deg)`, transformOrigin: `${(rotDrag.cx - sprite.x) * scale}px ${(rotDrag.cy - sprite.y) * scale}px` }}
                  draggable={false}
                  alt=""
                />
              )}
              {rotDrag && <div className="pdfed__rotbadge" style={{ left: c.x * scale + 12, top: c.y * scale - 28 }}>{Math.round(rotDrag.angle)}°</div>}
              <div className="pdfed__pivot" style={{ left: c.x * scale - 5, top: c.y * scale - 5 }} onMouseDown={startPivotDrag} title="Rotation centre — drag to move" />
              {!rotDrag && (
                <div
                  className="pdfed__rotate"
                  style={{ left: gx * scale - 9, top: gy * scale - 9 }}
                  onMouseDown={(e) => startRotate(e, c)}
                  title="Rotate around the pivot (Shift = squares to the page: 15° steps of the total angle)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-3-6.7" />
                    <path d="M21 3v6h-6" />
                  </svg>
                </div>
              )}
            </>
          )
        })()}
        {/* a line/arrow gets TWO endpoint handles — each drags anywhere (free rotation); while
            dragging, a live rubber line previews the result */}
        {selObjs.length === 1 && selObjs[0].line && !ghost && (() => {
          const L = lineDrag || selObjs[0].line
          return (
            <>
              {lineDrag && (() => {
                const x1 = L.x1 * scale, y1 = L.y1 * scale, x2 = L.x2 * scale, y2 = L.y2 * scale
                const len = Math.hypot(x2 - x1, y2 - y1)
                const ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI
                return <div className="pdfed__rubber" style={{ left: x1, top: y1, width: len, transform: `rotate(${ang}deg)` }} />
              })()}
              <div className="pdfed__handle" style={{ left: L.x1 * scale - 4, top: L.y1 * scale - 4, cursor: 'crosshair' }} onMouseDown={(e) => startLineDrag(e, 1)} />
              <div className="pdfed__handle" style={{ left: L.x2 * scale - 4, top: L.y2 * scale - 4, cursor: 'crosshair' }} onMouseDown={(e) => startLineDrag(e, 2)} />
            </>
          )
        })()}
        {/* resize handles — single image/vector only (text scales through its font size). A flat
            vector (a line) gets ONLY its along-axis handles: length is draggable, thickness comes
            from the stroke-width control, not from stretching */}
        {selObjs.length === 1 && selObjs[0].type !== 'text' && !selObjs[0].line && !ghost && union && (() => {
          // a ROTATED object gets its handles ON the rotated frame (positions re-derived from the
          // angle every render) and resizes along its own axes
          const fr = rotResize || rotFrameOf(selObjs[0])
          if (fr) {
            return HANDLES.map(([h, fx, fy]) => (
              <div
                key={h}
                className="pdfed__handle"
                style={{ left: (fr.x + fr.u.x * fx * fr.w + fr.d.x * fy * fr.h) * scale - 4, top: (fr.y + fr.u.y * fx * fr.w + fr.d.y * fy * fr.h) * scale - 4, cursor: 'crosshair' }}
                onMouseDown={(e) => startResizeRot(e, fx, fy)}
              />
            ))
          }
          const b = resizeBox || union
          const flatH = b.h < 3, flatV = b.w < 3
          const list = HANDLES.filter(([h]) => (flatH ? h === 'e' || h === 'w' : flatV ? h === 'n' || h === 's' : true))
          return list.map(([h, fx, fy, cur]) => (
            <div
              key={h}
              className="pdfed__handle"
              style={{ left: (b.x + b.w * fx) * scale - 4, top: (b.y + b.h * fy) * scale - 4, cursor: cur }}
              onMouseDown={(e) => startResize(e, h)}
            />
          ))
        })()}
        {ghost && union && image && (
          <>
            {/* alignment guides while actively dragging: faint green lines from the ghost's edges
                across the whole page, to line the selection up with other content */}
            {!ghost.pending && (
              <>
                <div className="pdfed__guide is-h" style={{ top: (union.y + ghost.dy) * scale }} />
                <div className="pdfed__guide is-h" style={{ top: (union.y + union.h + ghost.dy) * scale }} />
                <div className="pdfed__guide is-v" style={{ left: (union.x + ghost.dx) * scale }} />
                <div className="pdfed__guide is-v" style={{ left: (union.x + union.w + ghost.dx) * scale }} />
              </>
            )}
            {/* magnetic snap guides (Shift): a bright line at every aligned edge, spanning from the
                other object to the dragged one so the alignment is obvious */}
            {!ghost.pending && snapLines?.xs?.map((c, i) => (
              <div key={'sx' + i} className="pdfed__snap is-v" style={{ left: c.v * scale, top: Math.min(c.a, union.y + ghost.dy) * scale, height: (Math.max(c.z, union.y + union.h + ghost.dy) - Math.min(c.a, union.y + ghost.dy)) * scale }} />
            ))}
            {!ghost.pending && snapLines?.ys?.map((c, i) => (
              <div key={'sy' + i} className="pdfed__snap is-h" style={{ top: c.v * scale, left: Math.min(c.a, union.x + ghost.dx) * scale, width: (Math.max(c.z, union.x + union.w + ghost.dx) - Math.min(c.a, union.x + ghost.dx)) * scale }} />
            ))}
            {/* the dragged content: a transparent sprite of ONLY the selected objects (nothing around
                them, no clipped neighbours). Until it arrives, per-object raster windows fill in. */}
            {sprite ? (
              <img
                className="pdfed__ghost"
                src={sprite.url}
                style={px({ x: sprite.x + ghost.dx, y: sprite.y + ghost.dy, w: sprite.w, h: sprite.h })}
                draggable={false}
                alt=""
              />
            ) : (
              selObjs.map((o) => (
                <div
                  key={o.id}
                  className="pdfed__ghost"
                  style={{
                    ...px({ x: o.bbox.x + ghost.dx, y: o.bbox.y + ghost.dy, w: o.bbox.w, h: o.bbox.h }),
                    backgroundImage: `url(${image.url})`,
                    backgroundSize: `${W}px ${H}px`,
                    backgroundPosition: `${-o.bbox.x * scale}px ${-o.bbox.y * scale}px`
                  }}
                />
              ))
            )}
          </>
        )}
        {marquee && <div className="pdfed__marquee" style={px(marquee)} />}
        {textEdit && textEdit.page === pageIndex && (
          <RichTextEditor
            ref={rte.ref}
            x={textEdit.x}
            y={textEdit.y}
            scale={scale}
            font={rte.font}
            color={rte.color}
            size={rte.size}
            bold={rte.bold}
            italic={rte.italic}
            lineHeight={rte.lineHeight}
            letterSpacing={rte.letterSpacing}
            pipette={rte.pipette}
            onPipette={rte.onPipette}
            onCommit={(lines) => onTextCommit(lines)}
            onCancel={onTextCancel}
          />
        )}
      </div>
    </div>
  )
}
