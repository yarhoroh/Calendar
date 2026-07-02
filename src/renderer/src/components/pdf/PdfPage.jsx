import { useRef, useState } from 'react'

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

export default function PdfPage({ page, image, scale, selected, onSelect, onDelete, onMove }) {
  const { pageIndex, runs, images, vectors } = page
  const objects = [...runs, ...(images || []), ...(vectors || [])]
  const W = (image?.width ?? page.width) * scale
  const H = (image?.height ?? page.height) * scale
  const [marquee, setMarquee] = useState(null) // {x,y,w,h} in pt while rubber-banding
  const [ghost, setGhost] = useState(null) // {dx,dy} in pt while moving the selection
  const dragRef = useRef(null)

  const selIds = selected && selected.page === pageIndex ? selected.ids : null
  const selObjs = selIds ? objects.filter((o) => selIds.includes(o.id)) : []
  const union = unionOf(selObjs)

  const toPt = (e, el) => {
    const r = el.getBoundingClientRect()
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]
  }

  const onDown = (e) => {
    const el = e.currentTarget
    const [x, y] = toPt(e, el)
    e.stopPropagation()

    if (inside(union, x, y)) {
      // drag the whole selection — PDF changes once, on drop
      const start = { x, y }
      const move = (ev) => {
        const [mx, my] = toPt(ev, el)
        setGhost({ dx: mx - start.x, dy: my - start.y })
      }
      const up = (ev) => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        setGhost(null)
        const [ux, uy] = toPt(ev, el)
        const dx = ux - start.x, dy = uy - start.y
        if (Math.hypot(dx, dy) >= 1) onMove(dx, dy) // a plain click keeps the selection (double-click → delete)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      return
    }

    const hit = hitTest(objects, x, y)
    if (hit) { onSelect(pageIndex, [hit.id]); return }

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
      const ids = objects
        .filter((o) => o.bbox.x < box.x + box.w && o.bbox.x + o.bbox.w > box.x && o.bbox.y < box.y + box.h && o.bbox.y + o.bbox.h > box.y)
        .map((o) => o.id)
      onSelect(pageIndex, ids)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const onDouble = (e) => {
    const [x, y] = toPt(e, e.currentTarget)
    if (inside(union, x, y)) { e.stopPropagation(); onDelete() }
  }

  const px = (r) => ({ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale })

  return (
    <div className="pdfed__page" style={{ width: W, height: H }}>
      {image && <img className="pdfed__img" src={image.url} width={W} height={H} draggable={false} alt="" />}
      <div className="pdfed__overlay" onMouseDown={onDown} onDoubleClick={onDouble}>
        {selObjs.length === 1 && <div className={`pdfed__frame is-${selObjs[0].type}`} style={px(selObjs[0].bbox)} />}
        {selObjs.length > 1 && union && <div className="pdfed__frame is-union" style={px({ x: union.x - 2, y: union.y - 2, w: union.w + 4, h: union.h + 4 })} />}
        {ghost && union && image && (
          <>
            {/* alignment guides: faint green lines running from the ghost's edges across the whole
                page, to line the selection up with other content */}
            <div className="pdfed__guide is-h" style={{ top: (union.y + ghost.dy) * scale }} />
            <div className="pdfed__guide is-h" style={{ top: (union.y + union.h + ghost.dy) * scale }} />
            <div className="pdfed__guide is-v" style={{ left: (union.x + ghost.dx) * scale }} />
            <div className="pdfed__guide is-v" style={{ left: (union.x + union.w + ghost.dx) * scale }} />
            {/* a window into the live raster: crisp at any zoom because the raster itself re-renders per scale */}
            <div
              className="pdfed__ghost"
              style={{
                ...px({ x: union.x + ghost.dx, y: union.y + ghost.dy, w: union.w, h: union.h }),
                backgroundImage: `url(${image.url})`,
                backgroundSize: `${W}px ${H}px`,
                backgroundPosition: `${-union.x * scale}px ${-union.y * scale}px`
              }}
            />
          </>
        )}
        {marquee && <div className="pdfed__marquee" style={px(marquee)} />}
      </div>
    </div>
  )
}
