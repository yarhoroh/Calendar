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

const hitTest = (objects, x, y) => {
  let best = null
  for (const o of objects) {
    const padX = o.bbox.w < PAD ? PAD : 0
    const padY = o.bbox.h < PAD ? PAD : 0
    if (x < o.bbox.x - padX || x > o.bbox.x + o.bbox.w + padX) continue
    if (y < o.bbox.y - padY || y > o.bbox.y + o.bbox.h + padY) continue
    if (!best) { best = o; continue }
    if ((o.z || 0) > (best.z || 0)) best = o
    else if ((o.z || 0) === (best.z || 0) && o.bbox.w * o.bbox.h < best.bbox.w * best.bbox.h) best = o
  }
  return best
}
const unionOf = (objs) => {
  if (!objs.length) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const o of objs) { x0 = Math.min(x0, o.bbox.x); y0 = Math.min(y0, o.bbox.y); x1 = Math.max(x1, o.bbox.x + o.bbox.w); y1 = Math.max(y1, o.bbox.y + o.bbox.h) }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
const inside = (r, x, y) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

export default function PdfPage({ page, image, scale, selected, nudge, insertMode, textEdit, pipette, rte, onSelect, onMove, onSprite, onMenu, onInsertAt, onPipettePick, onTextCommit, onTextCancel }) {
  const { pageIndex, runs, images, vectors } = page
  const objects = [...runs, ...(images || []), ...(vectors || [])]
  const W = (image?.width ?? page.width) * scale
  const H = (image?.height ?? page.height) * scale
  const [marquee, setMarquee] = useState(null) // {x,y,w,h} in pt while rubber-banding
  const [ghost, setGhost] = useState(null) // {dx,dy} in pt while moving the selection
  const [sprite, setSprite] = useState(null) // transparent render of ONLY the dragged objects
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
    const move = (ev) => {
      const [mx, my] = toPt(ev, el)
      setGhost({ dx: mx - sx, dy: my - sy })
    }
    const up = (ev) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const [ux, uy] = toPt(ev, el)
      const dx = ux - sx, dy = uy - sy
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

    // eyedropper: pick the clicked text's style for the rich editor (no selection change)
    if (pipette) {
      const hit = hitTest(objects, x, y)
      if (hit && hit.type === 'text') onPipettePick(pageIndex, hit)
      return
    }

    // insert-text mode: the click just places the rich-text editor
    if (insertMode) { onInsertAt(pageIndex, x, y); return }

    // Shift/Ctrl + click: add objects to the selection one by one (click a selected one → remove it).
    // Same result as the rubber-band, just piecewise. Never starts a drag or a marquee.
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const hit = hitTest(objects, x, y)
      if (hit) {
        const has = selObjs.some((o) => o.id === hit.id)
        onSelect(pageIndex, has ? selObjs.filter((o) => o.id !== hit.id) : [...selObjs, hit])
      }
      return // empty additive click keeps the selection as is
    }

    if (inside(union, x, y)) { startMoveDrag(el, x, y, selObjs); return } // drag the existing selection

    const hit = hitTest(objects, x, y)
    if (hit) { onSelect(pageIndex, [hit]); startMoveDrag(el, x, y, [hit]); return } // select AND move in one gesture

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
      <div className="pdfed__overlay" style={{ cursor: pipette ? 'copy' : insertMode ? 'text' : undefined }} onMouseDown={onDown} onContextMenu={onContext}>
        {/* selection frame — the same light dashed box for one object or a whole group; while a
            ghost is up it travels with it */}
        {union && (
          <div
            className="pdfed__frame"
            style={px({
              x: union.x - 2 + (ghost?.dx || 0) + (nudge?.dx || 0),
              y: union.y - 2 + (ghost?.dy || 0) + (nudge?.dy || 0),
              w: union.w + 4,
              h: union.h + 4
            })}
          />
        )}
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
