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

export default function PdfPage({ page, image, scale, selected, selMode, showAll, nudge, insertMode, textEdit, pipette, rte, onSelect, onMove, onResize, onLineGeo, onLiveGeo, onSprite, onMenu, onInsertAt, onPipettePick, onTextCommit, onTextCancel }) {
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
  const dragRef = useRef(null)

  // the selection carries the resolved objects themselves — nothing is re-filtered from the model
  const selObjs = selected && selected.page === pageIndex ? selected.objs : []
  const union = unionOf(selObjs)

  const dropSprite = () => setSprite((s) => { if (s) URL.revokeObjectURL(s.url); return null })

  // a ghost parked after a drop dissolves as soon as the freshly rendered page image arrives
  useEffect(() => { setGhost((g) => { if (!g?.pending) return g; dropSprite(); return null }) }, [image?.url]) // eslint-disable-line react-hooks/exhaustive-deps

  const toPt = (e, el) => {
    const r = el.getBoundingClientRect()
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]
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
    }
    const snap = (dx, dy) => {
      const th = 4 / scale // ~4 screen pixels
      const edgesX = [u0.x + dx, u0.x + u0.w + dx] // dragged left, right
      const edgesY = [u0.y + dy, u0.y + u0.h + dy] // dragged top, bottom
      let bx = null, by = null
      for (const e of edgesX) for (const c of candX) { const d = c.v - e; if (Math.abs(d) < th && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, c } }
      for (const e of edgesY) for (const c of candY) { const d = c.v - e; if (Math.abs(d) < th && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, c } }
      return { dx: dx + (bx ? bx.d : 0), dy: dy + (by ? by.d : 0), gx: bx?.c || null, gy: by?.c || null }
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
      if (ev.shiftKey) { const s = snap(dx, dy); return [s.dx, s.dy, s.gx, s.gy] }
      return [dx, dy, null, null]
    }
    const move = (ev) => {
      const [mx, my] = toPt(ev, el)
      const [dx, dy, gx, gy] = resolve(mx - sx, my - sy, ev)
      setGhost({ dx, dy })
      setSnapLines(gx || gy ? { x: gx, y: gy } : null)
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
        {/* "All" — faint grey outline around every non-empty element, an element map of the page */}
        {showAll && objects.map((o) => (
          o.bbox.w > 1 && o.bbox.h > 0.5
            ? <div key={'a' + o.id} className="pdfed__allbox" style={px(o.bbox)} />
            : null
        ))}
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
            ghost is up it travels with it; while a handle is dragged it shows the live box */}
        {!(selObjs.length === 1 && selObjs[0].line) && union && (
          <div
            className="pdfed__frame"
            style={px(resizeBox
              ? resizeBox
              : {
                  x: union.x + (ghost?.dx || 0) + (nudge?.dx || 0),
                  y: union.y + (ghost?.dy || 0) + (nudge?.dy || 0),
                  w: union.w,
                  h: union.h
                })}
          />
        )}
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
            {/* magnetic snap guides (Shift): a bright line exactly where the union locks onto another
                object's edge/centre, spanning both objects so the alignment is obvious */}
            {!ghost.pending && snapLines?.x && (
              <div className="pdfed__snap is-v" style={{ left: snapLines.x.v * scale, top: Math.min(snapLines.x.a, union.y + ghost.dy) * scale, height: (Math.max(snapLines.x.z, union.y + union.h + ghost.dy) - Math.min(snapLines.x.a, union.y + ghost.dy)) * scale }} />
            )}
            {!ghost.pending && snapLines?.y && (
              <div className="pdfed__snap is-h" style={{ top: snapLines.y.v * scale, left: Math.min(snapLines.y.a, union.x + ghost.dx) * scale, width: (Math.max(snapLines.y.z, union.x + union.w + ghost.dx) - Math.min(snapLines.y.a, union.x + ghost.dx)) * scale }} />
            )}
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
