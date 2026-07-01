import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ZoomInIcon, ZoomOutIcon } from '../icons'
import { createPdfEngine } from './pdfEngine'
import PdfPage from './PdfPage'
import './PdfEditor.css'

// PDF editor. The worker parses each page into a text model (source of truth) + a vector SVG. Pages
// render as layered SVG (view) with a contenteditable that appears only while editing. Editing updates
// the model, which re-renders the SVG. Export back to PDF (model → PDF) is the next step.
// Ctrl+wheel zooms (anchored on the cursor); hold Space to pan.
export default function PdfEditor({ source }) {
  const [pages, setPages] = useState([]) // model: [{ pageIndex, width, height, gfx, runs }]
  const [pageCount, setPageCount] = useState(0)
  const [scale, setScale] = useState(1.5)
  const [status, setStatus] = useState('idle')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const [editing, setEditing] = useState(null) // { page, id, bbox, font, generic, size, bold, italic, color, text }
  const engineRef = useRef(null)
  const viewportRef = useRef(null)
  const panRef = useRef(null)
  const zoomAnchorRef = useRef(null) // keeps the point under the cursor fixed across a zoom step

  const edits = pages.reduce((n, p) => n + p.runs.filter((r) => r.dirty).length, 0)

  useEffect(() => { engineRef.current = createPdfEngine(); return () => engineRef.current?.dispose() }, [])

  // open the document when bytes arrive
  useEffect(() => {
    if (source === undefined || !engineRef.current) return
    let alive = true
    setStatus('loading')
    Promise.resolve(engineRef.current.open(source))
      .then((info) => { if (alive) setPageCount(info?.pageCount || 0) })
      .catch((err) => { console.error('[pdf] open failed:', err); if (alive) setStatus('error') })
    return () => { alive = false }
  }, [source])

  // parse every page into its model once
  useEffect(() => {
    if (!pageCount || !engineRef.current) return
    let alive = true
    setStatus('loading')
    ;(async () => {
      const out = []
      for (let i = 0; i < pageCount; i++) {
        const r = await engineRef.current.parsePage(i)
        if (!alive) return
        out.push({ pageIndex: i, width: r.width, height: r.height, gfx: r.gfx, runs: r.runs })
      }
      if (alive) { setPages(out); setStatus('ready') }
    })().catch(() => alive && setStatus('error'))
    return () => { alive = false }
  }, [pageCount])

  // load the PDF's embedded TrueType fonts as @font-face (registered under their clean family name)
  useEffect(() => {
    if (!pageCount || !engineRef.current) return
    let alive = true
    engineRef.current.getFonts().then(({ fonts }) => {
      for (const f of fonts || []) {
        if (!alive) break
        try { new FontFace(f.family, f.bytes).load().then((ff) => document.fonts.add(ff)).catch(() => {}) } catch (_) {}
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [pageCount])

  // Ctrl + wheel zoom (non-passive so we cancel the browser zoom). Anchor on the point under the cursor.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setScale((s) => {
        const ns = Math.min(10, Math.max(0.3, s * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
        if (ns !== s) zoomAnchorRef.current = { contentX: (el.scrollLeft + cx) / s, contentY: (el.scrollTop + cy) / s, cx, cy }
        return ns
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // After a zoom re-layout, scroll so the recorded content point sits back under the cursor.
  useLayoutEffect(() => {
    const a = zoomAnchorRef.current
    const el = viewportRef.current
    if (!a || !el) return
    el.scrollLeft = a.contentX * scale - a.cx
    el.scrollTop = a.contentY * scale - a.cy
    zoomAnchorRef.current = null
  }, [scale])

  // Hold Space to pan the view like a hand tool
  useEffect(() => {
    const isField = (n) => n instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)
    const down = (e) => { if (e.code !== 'Space' || isField(e.target) || e.target?.isContentEditable) return; e.preventDefault(); setSpaceHeld(true) }
    const up = (e) => { if (e.code === 'Space') setSpaceHeld(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  const onPanMouseDown = (e) => {
    const el = viewportRef.current
    if (!spaceHeld || !el) return
    e.preventDefault()
    setPanning(true)
    panRef.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
    const move = (ev) => {
      const p = panRef.current
      if (!p || !viewportRef.current) return
      viewportRef.current.scrollLeft = p.left - (ev.clientX - p.x)
      viewportRef.current.scrollTop = p.top - (ev.clientY - p.y)
    }
    const upp = () => { panRef.current = null; setPanning(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', upp) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', upp)
  }

  // ---- editing (model is the source of truth) ----
  const startEdit = (pageIndex, run) => { if (!spaceHeld) setEditing({ page: pageIndex, ...run }) }
  const commitEdit = (pageIndex, id, newText, dx = 0, dy = 0) => {
    setPages((prev) => prev.map((p) => {
      if (p.pageIndex !== pageIndex) return p
      return { ...p, runs: p.runs.map((r) => {
        if (r.id !== id) return r
        const textChanged = r.text !== newText
        if (!textChanged && !dx && !dy) return r // nothing changed → keep pristine (per-glyph kerning)
        return {
          ...r,
          text: newText,
          x: r.x + dx,
          y: r.y + dy,
          bbox: { ...r.bbox, x: r.bbox.x + dx, y: r.bbox.y + dy },
          glyphs: r.glyphs.map((g) => ({ ...g, x: g.x + dx })),
          edited: r.edited || textChanged, // once text changes, per-glyph x is stale → render from a single start x
          dirty: true
        }
      }) }
    }))
    setEditing(null)
  }
  const cancelEdit = () => setEditing(null)

  return (
    <div className="pdfed">
      <div className="pdfed__toolbar">
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.max(0.3, s / 1.15))} title="Zoom out"><ZoomOutIcon /></button>
        <span className="pdfed__zoom">{Math.round(scale * 100)}%</span>
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.min(10, s * 1.15))} title="Zoom in"><ZoomInIcon /></button>
        <span className="pdfed__spacer" />
        {edits > 0 && <span className="pdfed__edits">{edits} edited</span>}
        <span className="pdfed__status">{status === 'loading' ? '…' : `${pageCount} p.`}</span>
      </div>

      <div className="pdfed__body">
        <div
          className="pdfed__viewport"
          ref={viewportRef}
          style={{ cursor: spaceHeld ? (panning ? 'grabbing' : 'grab') : undefined }}
          onMouseDown={onPanMouseDown}
        >
          <div className="pdfed__pages" style={{ pointerEvents: spaceHeld ? 'none' : undefined }}>
            {pages.map((p) => (
              <PdfPage
                key={p.pageIndex}
                page={p}
                scale={scale}
                editing={editing}
                onEdit={startEdit}
                onCommit={commitEdit}
                onCancel={cancelEdit}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
