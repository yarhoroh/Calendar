import { useEffect, useRef, useState } from 'react'

const pt = (v) => `${v}pt`
const MoveIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
  </svg>
)

// One page, three layers:
//  • gfx  — vector/background SVG (paths, lines, art, images)
//  • txt  — SVG <text> from the model; the whole run is the hit target (pointer-events: bounding-box).
//  • edit — while editing: a framed contenteditable over the run (SVG copy hidden) + a move handle
//           (bottom-right) to change its coordinates. Click away → commit text + new coords to the model.
// The model is the source of truth: commit updates it, the SVG re-renders from it.
export default function PdfPage({ page, scale, editing, onEdit, onCommit, onCancel }) {
  const { pageIndex, width, height, gfx, runs } = page
  const edit = editing && editing.page === pageIndex ? editing : null
  const [hover, setHover] = useState(null)
  const [delta, setDelta] = useState({ dx: 0, dy: 0 }) // live move offset while editing (pt)
  const editRef = useRef(null)

  // reset the move offset and focus the editor (caret at end) whenever a new run opens
  useEffect(() => {
    setDelta({ dx: 0, dy: 0 })
    const el = editRef.current
    if (!edit || !el) return
    el.focus()
    const sel = window.getSelection(); const range = document.createRange()
    range.selectNodeContents(el); range.collapse(false)
    sel.removeAllRanges(); sel.addRange(range)
  }, [edit?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickId = (e) => e.target?.closest?.('text[data-id]')?.getAttribute('data-id') || null
  const hoverRun = hover && !edit ? runs.find((r) => r.id === hover) : null

  const commit = () => { if (edit && editRef.current) onCommit(pageIndex, edit.id, editRef.current.textContent, delta.dx, delta.dy) }

  // drag the bottom-right handle to move the run; preventDefault keeps the editor focused (no blur/commit)
  const startMove = (e) => {
    e.preventDefault(); e.stopPropagation()
    const sx = e.clientX, sy = e.clientY, base = { ...delta }
    const mv = (ev) => setDelta({ dx: base.dx + (ev.clientX - sx) / scale, dy: base.dy + (ev.clientY - sy) / scale })
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up)
  }

  return (
    <div className="pdfed__page" style={{ width: pt(width * scale), height: pt(height * scale) }}>
      <div className="pdfed__layer" style={{ width: pt(width), height: pt(height), transform: `scale(${scale})` }}>
        <div className="pdfed__gfx" dangerouslySetInnerHTML={{ __html: gfx }} />

        <svg
          className="pdfed__txt"
          viewBox={`0 0 ${width} ${height}`}
          xmlns="http://www.w3.org/2000/svg"
          onMouseMove={(e) => setHover(pickId(e))}
          onMouseLeave={() => setHover(null)}
        >
          {runs.map((r) =>
            edit && edit.id === r.id ? null : (
              <text
                key={r.id}
                data-id={r.id}
                fontFamily={`"${r.font}", ${r.generic}`}
                fontSize={r.size}
                fontWeight={r.bold ? 'bold' : undefined}
                fontStyle={r.italic ? 'italic' : undefined}
                fill={r.color}
                xmlSpace="preserve"
                onMouseDown={(e) => { e.stopPropagation(); onEdit(pageIndex, r) }}
              >
                {/* per-glyph x while pristine (kerning 1:1); a single start x once the text was edited */}
                <tspan x={r.edited ? r.x : r.glyphs.map((g) => g.x).join(' ')} y={r.y}>{r.text}</tspan>
              </text>
            )
          )}
          {hoverRun && (
            <rect className="pdfed__hoverbox" x={hoverRun.bbox.x} y={hoverRun.bbox.y} width={hoverRun.bbox.w} height={hoverRun.bbox.h} />
          )}
        </svg>

        {edit && (
          <>
            <div
              ref={editRef}
              className="pdfed__edit"
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              style={{
                left: pt(edit.bbox.x + delta.dx),
                top: pt(edit.bbox.y + delta.dy),
                minWidth: pt(edit.bbox.w),
                height: pt(edit.bbox.h),
                fontFamily: `"${edit.font}", ${edit.generic}`,
                fontSize: pt(edit.size),
                fontWeight: edit.bold ? 'bold' : undefined,
                fontStyle: edit.italic ? 'italic' : undefined,
                color: edit.color
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
              }}
              onBlur={commit}
            >
              {edit.text}
            </div>
            <div
              className="pdfed__movehandle"
              style={{ left: pt(edit.bbox.x + delta.dx + edit.bbox.w), top: pt(edit.bbox.y + delta.dy + edit.bbox.h) }}
              onMouseDown={startMove}
              title="Move"
            >
              <MoveIcon />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
