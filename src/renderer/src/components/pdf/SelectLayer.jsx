import { Fragment, useEffect, useRef, useState } from 'react'

// Object manipulation layer over a page: click to select (shift to add), drag to move, marquee on
// empty space to select many, Delete to remove. Selectable objects = text blocks + images + vectors.
// All edits are LOCAL (move/remove kept in state) — writing them back to the PDF is a later stage.
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const normRect = (m) => ({
  x: Math.min(m.x0, m.x1),
  y: Math.min(m.y0, m.y1),
  w: Math.abs(m.x1 - m.x0),
  h: Math.abs(m.y1 - m.y0),
})
const hit = (a, b) => !(a.x > b.x + b.w || a.x + a.w < b.x || a.y > b.y + b.h || a.y + a.h < b.y)

// objects: [{ key, type, x, y, width, height }] in PDF points
export default function SelectLayer({ objects, runs, scale, spaceHeld, showBoxes, onSelection, onCommit, onMoveStart, onMoveApply, onMoveEnd, onEditObject }) {
  const [sel, setSel] = useState(() => new Set())
  const [moves, setMoves] = useState({}) // key → { dx, dy } in points
  const [removed, setRemoved] = useState(() => new Set())
  const [marquee, setMarquee] = useState(null)
  const [dragging, setDragging] = useState(false) // suppress object hover while dragging
  const ref = useRef(null)
  const drag = useRef(null)

  const ptOf = (e) => {
    const r = ref.current.getBoundingClientRect()
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }
  const posOf = (o) => {
    const m = moves[o.key] || { dx: 0, dy: 0 }
    return { x: o.x + m.dx, y: o.y + m.dy, w: o.width, h: o.height }
  }
  const inside = (o, p) => {
    const r = posOf(o)
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
  }
  const topAt = (p) => {
    // text sits on top → pick a text object first; only fall back to images/vectors underneath
    for (const o of objects) if (o.type === 'text' && !removed.has(o.key) && inside(o, p)) return o
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i]
      if (!removed.has(o.key) && inside(o, p)) return o
    }
    return null
  }
  // bounding box of the current selection (for grabbing the whole group from any spot inside it)
  const selFrame = () => {
    const so = objects.filter((o) => sel.has(o.key) && !removed.has(o.key))
    if (!so.length) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const o of so) {
      const r = posOf(o)
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h)
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  const startMove = (p, keys) => {
    const orig = {}
    for (const k of keys) orig[k] = moves[k] || { dx: 0, dy: 0 }
    drag.current = { mode: 'move', start: p, keys: [...keys], orig }
    onMoveStart?.() // worker snapshots the baseline stream
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onMove = (e) => {
    const d = drag.current
    if (!d) return
    const p = ptOf(e)
    if (d.mode === 'move') {
      const dx = p.x - d.start.x
      const dy = p.y - d.start.y
      d.lastDx = dx // keep the final delta on the drag ref (state closure in onUp would be stale)
      d.lastDy = dy
      setMoves((prev) => {
        const n = { ...prev }
        for (const k of d.keys) n[k] = { dx: d.orig[k].dx + dx, dy: d.orig[k].dy + dy }
        return n
      })
      // live: apply the FULL delta to the stream (parent throttles latest-wins)
      const items = []
      for (const k of d.keys) {
        const o = objects.find((x) => x.key === k)
        if (o?.z?.length) for (const z of o.z) items.push({ stream: o.stream || 0, block: z, dx, dy })
      }
      if (items.length) onMoveApply?.(items)
    } else if (d.mode === 'marquee') {
      setMarquee({ x0: d.start.x, y0: d.start.y, x1: p.x, y1: p.y })
    }
  }
  const onUp = (e) => {
    const d = drag.current
    if (d?.mode === 'marquee') {
      const r = normRect({ x0: d.start.x, y0: d.start.y, x1: ptOf(e).x, y1: ptOf(e).y })
      const next = new Set(e.shiftKey ? sel : [])
      if (r.w > 2 || r.h > 2) {
        for (const o of objects) {
          if (removed.has(o.key)) continue
          if (hit(r, posOf(o))) next.add(o.key)
        }
      }
      setSel(next)
      setMarquee(null)
    } else if (d?.mode === 'move') {
      // finish: stream already moved. Report final deltas (from the ref, not the stale state closure)
      // so the parent updates object positions in place — no re-analysis — then drop the local offset.
      const deltas = {}
      if (d.lastDx || d.lastDy) for (const k of d.keys) deltas[k] = { dx: d.lastDx || 0, dy: d.lastDy || 0 }
      onMoveEnd?.(deltas)
      setMoves((prev) => {
        const n = { ...prev }
        for (const k of d.keys) delete n[k]
        return n
      })
    }
    drag.current = null
    setDragging(false)
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  const onDown = (e) => {
    if (e.button !== 0 || spaceHeld) return // let space-pan through
    setDragging(true)
    const p = ptOf(e)
    // grab anywhere inside the current selection's frame → move the whole group
    const f = selFrame()
    if (f && !e.shiftKey && p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h) {
      startMove(p, [...sel])
      e.preventDefault()
      return
    }
    const o = topAt(p)
    if (o) {
      let next = new Set(sel)
      if (e.shiftKey) (next.has(o.key) ? next.delete(o.key) : next.add(o.key))
      else if (!sel.has(o.key)) next = new Set([o.key])
      setSel(next)
      startMove(p, [...next])
    } else {
      if (!e.shiftKey) setSel(new Set())
      drag.current = { mode: 'marquee', start: p }
      setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
    e.preventDefault()
  }

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) {
        const rects = objects
          .filter((o) => sel.has(o.key) && !removed.has(o.key))
          .map((o) => {
            const m = moves[o.key] || { dx: 0, dy: 0 }
            return { x: o.x + m.dx, y: o.y + m.dy, width: o.width, height: o.height, type: o.type }
          })
        setRemoved((prev) => new Set([...prev, ...sel]))
        setSel(new Set())
        onCommit?.({ type: 'delete', rects }) // really remove from the working copy
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel, objects, moves, removed]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onSelection?.([...sel])
  }, [sel]) // eslint-disable-line react-hooks/exhaustive-deps

  const px = (r) => ({ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale })

  // selection bounding frame
  const selObjs = objects.filter((o) => sel.has(o.key) && !removed.has(o.key))
  let frame = null
  if (selObjs.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const o of selObjs) {
      const r = posOf(o)
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h)
    }
    frame = px({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
  }

  const onDouble = (e) => {
    if (spaceHeld) return
    const o = topAt(ptOf(e))
    if (o && o.type === 'text') onEditObject?.(o.key)
  }

  return (
    <div className={'pdfed__select' + (dragging ? ' is-dragging' : '')} ref={ref} onMouseDown={onDown} onDoubleClick={onDouble}>
      {/* runs — grey dashed, non-interactive visual hint of the style spans */}
      {showBoxes &&
        runs.map((r, i) => <div key={'r' + i} className="pdfed__ov pdfed__ov--run is-bare" style={px({ x: r.x, y: r.y, w: r.width, h: r.height })} />)}

      {/* selectable objects */}
      {objects.map((o) => {
        if (removed.has(o.key)) return null
        const r = posOf(o)
        const isSel = sel.has(o.key)
        return (
          <div
            key={o.key}
            className={`pdfed__obj pdfed__obj--${o.type}` + (isSel ? ' is-sel' : '') + (showBoxes ? '' : ' is-bare')}
            style={px({ x: r.x, y: r.y, w: r.w, h: r.h })}
          />
        )
      })}

      {frame && (
        <div className="pdfed__frame" style={frame}>
          {HANDLES.map((h) => (
            <span key={h} className={`pdfed__handle pdfed__handle--${h}`} />
          ))}
        </div>
      )}

      {marquee && <div className="pdfed__rubber" style={px(normRect(marquee))} />}
    </div>
  )
}
