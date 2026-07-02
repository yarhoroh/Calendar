import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ZoomInIcon, ZoomOutIcon, CopyIcon, PasteIcon, TrashIcon, PipetteIcon } from '../icons'
import api from '../../lib/api'
import ContextMenu from '../ContextMenu'
import { createPdfEngine } from './pdfEngine'
import PdfPage from './PdfPage'
import './PdfEditor.css'

const SIZES = [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72, 80, 90]
const LH_OPTS = [1, 1.15, 1.25, 1.4, 1.5, 1.75, 2]
const LS_OPTS = [-2, -1.5, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 1.5, 2, 3, 5]

// Colour swatch button + dropdown panel: the document's palette, Transparent, and a custom picker.
// Used for vector stroke/fill (value may be 'none').
function ColorDrop({ value, colors, onPick, title }) {
  const [open, setOpen] = useState(null)
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!e.target.closest('.pdfed__colorpanel')) setOpen(null) }
    window.addEventListener('mousedown', close, true)
    return () => window.removeEventListener('mousedown', close, true)
  }, [open])
  return (
    <span className="pdfed__colorwrap">
      <button
        className="pdfed__btn"
        title={title}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setOpen((v) => (v ? null : { x: r.left, y: r.bottom + 4 }))
        }}
      >
        <span className={'pdfed__swatch' + (value === 'none' ? ' is-none' : '')} style={value === 'none' ? undefined : { background: value }} />
      </button>
      {open && (
        <div className="pdfed__colorpanel" style={{ left: open.x, top: open.y }}>
          <div className="pdfed__swatches">
            {(colors || []).map((c) => (
              <button
                key={c}
                className={'pdfed__swatchbtn' + (c === value ? ' is-on' : '')}
                style={{ background: c }}
                title={c}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(c); setOpen(null) }}
              />
            ))}
          </div>
          <button className="pdfed__custom pdfed__custom--btn" onClick={() => { onPick('none'); setOpen(null) }}>
            <span className="pdfed__swatch is-none" /> Transparent
          </button>
          <label className="pdfed__custom">
            Custom
            <input type="color" value={value === 'none' ? '#000000' : value} onChange={(e) => onPick(e.target.value)} />
          </label>
        </div>
      )}
    </span>
  )
}

// Number input + a dropdown of standard values sharing one box. The input keeps a local draft so
// partial entries ("-", "1.", "") survive typing — the parent is only notified on valid numbers.
function ComboNum({ value, onPick, opts, step = 1, min, max, width, title, onGrab, disabled }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const push = (raw) => {
    const v = parseFloat(raw)
    if (!isNaN(v)) onPick(Math.min(max, Math.max(min, v)))
  }
  return (
    <span className={'pdfed__combo' + (disabled ? ' is-locked' : '')} style={width ? { width } : undefined} title={title}>
      <input
        className="pdfed__num"
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        onMouseDown={onGrab}
        onChange={(e) => { setDraft(e.target.value); push(e.target.value) }}
        onBlur={() => setDraft(String(value))}
        onKeyDown={(e) => { if (e.key === 'Enter') push(e.currentTarget.value) }}
      />
      {opts?.length > 0 && (
        <select className="pdfed__combosel" value="" disabled={disabled} onMouseDown={onGrab} onChange={(e) => onPick(parseFloat(e.target.value))}>
          <option value="" hidden></option>
          {opts.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      )}
    </span>
  )
}

// "insert shape" — a square with a plus (local: only the PDF toolbar uses it)
const InsertShapeIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="7" width="12" height="12" rx="2" />
    <path d="M19 3v6M16 6h6" />
  </svg>
)

// "insert image" — a picture with a plus (local: only the PDF toolbar uses it)
const InsertImageIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="14" height="14" rx="2" />
    <circle cx="8" cy="10" r="1.5" />
    <path d="m3 17 4-4 3 3 4-4 3 3" />
    <path d="M19 3v6M16 6h6" />
  </svg>
)

// "insert text" — a T with a plus (local: only the PDF toolbar uses it)
const InsertTextIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5V3h12v2M10 3v14M7 17h6" />
    <path d="M18 15v6M15 18h6" />
  </svg>
)

// PDF editor. Each page is a raster image (exact visual) + a JSON text model loaded in parallel.
// Clicking a run selects it and frames it on the image (Stage 1); later stages add area selection,
// rich-text editing of the selected runs, and export back into the PDF stream.
// Ctrl+wheel zooms (anchored on the cursor); hold Space to pan.
export default function PdfEditor({ source, path }) {
  const [model, setModel] = useState([]) // [{ pageIndex, width, height, runs }]
  const [imgs, setImgs] = useState([]) // [{ pageIndex, url, width, height }] — re-rendered per scale
  const [pageCount, setPageCount] = useState(0)
  const [scale, setScale] = useState(1.5)
  const [status, setStatus] = useState('idle')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const [selected, setSelected] = useState(null) // { page, objs: [...] } — the resolved objects themselves (no re-filtering per action)
  const [saving, setSaving] = useState(false)
  const [nudge, setNudge] = useState(null) // accumulated arrow-key shift (pt), not yet committed
  const nudgeRef = useRef(null)
  const [clip, setClip] = useState(null) // clipboard: { page, items:[{type,bbox}] } for copy/paste duplication
  const [menu, setMenu] = useState(null) // right-click menu: { page, kind:'sel'|'empty', sx, sy, x?, y? }
  const [docFonts, setDocFonts] = useState([]) // PDF fonts: { name, embedded, subset, match } (match = similar system font)
  const [sysFonts, setSysFonts] = useState([]) // system/bundled font families
  const [fontSel, setFontSel] = useState('')
  const [colorSel, setColorSel] = useState('#000000')
  const [colorOpen, setColorOpen] = useState(false)
  const [insertMode, setInsertMode] = useState(false) // false | 'text' | { image: {bytes,w,h} } — the next click places it
  const [textEdit, setTextEdit] = useState(null) // active rich-text editor: { page, x, y } (pt)
  const [fontSize, setFontSize] = useState(12) // pt
  const [boldSel, setBoldSel] = useState(false) // sticky style state: survives deselection, so a new
  const [italicSel, setItalicSel] = useState(false) // text starts with the last clicked text's style
  const [lineH, setLineH] = useState(1.25) // line-height multiplier (editor layout — coords carry it into the PDF)
  const [letterS, setLetterS] = useState(0) // letter spacing, pt → Tc
  const [pipette, setPipette] = useState(false) // eyedropper: next click on a text copies its full style into the editor
  const [shapeMenu, setShapeMenu] = useState(null) // shape-kind picker popover: { x, y }
  const [strokeW, setStrokeW] = useState(1) // shape stroke width, pt
  const [cornerR, setCornerR] = useState(0) // rect corner radius, pt
  const [dashSel, setDashSel] = useState('solid') // line type for inserted shapes
  const [showAll, setShowAll] = useState(false) // faint grey frames around EVERY (non-empty) element
  const rteRef = useRef(null)
  const engineRef = useRef(null)
  const urlsRef = useRef([])
  const viewportRef = useRef(null)
  const panRef = useRef(null)
  const zoomAnchorRef = useRef(null) // keeps the point under the cursor fixed across a zoom step

  const revoke = () => { for (const u of urlsRef.current) URL.revokeObjectURL(u); urlsRef.current = [] }

  useEffect(() => { engineRef.current = createPdfEngine(); return () => { engineRef.current?.dispose(); revoke() } }, [])

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

  // load the JSON text model once (scale-independent)
  useEffect(() => {
    if (!pageCount || !engineRef.current) return
    let alive = true
    ;(async () => {
      const out = []
      for (let i = 0; i < pageCount; i++) {
        const r = await engineRef.current.getModel(i)
        if (!alive) return
        out.push({ pageIndex: i, ...r }) // width/height, palettes (fonts/colors), runs, images, vectors
      }
      if (alive) setModel(out)
    })().catch((err) => console.error('[pdf] getModel failed:', err))
    return () => { alive = false }
  }, [pageCount])

  // Raster resolution is capped: above RENDER_CAP× the same bitmap is stretched by CSS. A full A4 at
  // 7× would be ~25 Mpx per re-render (seconds of rasterise+PNG-encode on every move/zoom step);
  // at 4× it stays ~8 Mpx, and zooming past the cap doesn't touch the worker at all.
  const RENDER_CAP = 4
  const renderScale = Math.min(scale, RENDER_CAP)

  // render page images whenever the doc opens or the (capped) render scale changes
  useEffect(() => {
    if (!pageCount || !engineRef.current) return
    let alive = true
    setStatus('loading')
    ;(async () => {
      const out = []
      for (let i = 0; i < pageCount; i++) {
        const r = await engineRef.current.renderImage(i, renderScale)
        if (!alive) return
        out.push({ pageIndex: i, url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), width: r.width, height: r.height })
      }
      if (!alive) { for (const p of out) URL.revokeObjectURL(p.url); return }
      revoke(); urlsRef.current = out.map((p) => p.url); setImgs(out); setStatus('ready')
    })().catch(() => alive && setStatus('error'))
    return () => { alive = false }
  }, [pageCount, renderScale])

  // Font inventory for the dropdown: the document's own fonts first (each non-embedded or subset one
  // paired with the most similar installed family), then every system font.
  useEffect(() => {
    if (!pageCount || !engineRef.current) return
    let alive = true
    ;(async () => {
      const [info, sys] = await Promise.all([
        engineRef.current.getFontsInfo().catch(() => ({ fonts: [] })),
        Promise.resolve(api.fonts?.list?.()).catch(() => [])
      ])
      if (!alive) return
      const families = (Array.isArray(sys) ? sys : []).map((f) => f?.family || f).filter(Boolean)
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
      const nf = families.map((f) => [norm(f), f])
      const similar = (name) => {
        const n = norm(name)
        const hit = nf.find(([k]) => k === n) || nf.find(([k]) => k.length > 3 && (n.includes(k) || k.includes(n)))
        if (hit) return hit[1]
        // well-known clone families first, then a generic guess
        if (/nimbussans|helvetica|arimo|liberationsans/i.test(name)) return 'Arial'
        if (/nimbusroman|nimbusserif|tinos|liberationserif|times|roman|georgia|garamond|book|serif/i.test(name)) return 'Times New Roman'
        if (/nimbusmono|cousine|liberationmono|courier|mono/i.test(name)) return 'Courier New'
        return 'Arial'
      }
      // every PDF font may need a lookalike for NEW text (subset / non-embedded / non-loadable)
      const fonts = (info.fonts || []).map((f) => ({ ...f, match: f.embedded && !f.subset ? null : similar(f.name) }))
      // Register a @font-face under the PDF font's OWN NAME for every document font, so
      // font-family: "NimbusSans-Regular" actually renders in the editor:
      //  • browser-loadable embedded faces (TrueType + cmap) use their real bytes;
      //  • everything else gets the bytes of its closest system lookalike under that name.
      for (const f of fonts) {
        try {
          if (f.bytes) { new FontFace(f.name, f.bytes).load().then((ff) => document.fonts.add(ff)).catch(() => {}); continue }
          const look = f.match || similar(f.name)
          Promise.resolve(api.fonts.file(look, {})).then((sys) => {
            if (sys?.bytes) new FontFace(f.name, sys.bytes).load().then((ff) => document.fonts.add(ff)).catch(() => {})
          }).catch(() => {})
        } catch (_) {}
      }
      setDocFonts(fonts)
      setSysFonts(families)
      if (fonts.length) setFontSel((v) => v || fonts[0].name)
    })()
    return () => { alive = false }
  }, [pageCount])

  // every colour used in the document (text + art), merged across pages — the colour dropdown
  const docColors = [...new Set(model.flatMap((p) => p.colors || []))]

  // a single selected TEXT object shows ITS font/size/colour (and B/I light up) in the toolbar;
  // any wider selection locks the style controls instead
  const singleText = !textEdit && selected?.objs.length === 1 && selected.objs[0].type === 'text' ? selected.objs[0] : null
  const styleLocked = !textEdit && !!selected && !singleText
  const selPg = selected ? model.find((p) => p.pageIndex === selected.page) : null
  useEffect(() => {
    if (!singleText || !selPg) return
    const f = selPg.fonts?.[singleText.f]
    if (f) { setFontSel(f.name); setBoldSel(!!f.bold); setItalicSel(!!f.italic) }
    if (singleText.c !== undefined && selPg.colors?.[singleText.c]) setColorSel(selPg.colors[singleText.c])
    if (singleText.size) setFontSize(singleText.size)
    setLetterS(singleText.ls || 0) // the run's ORIGINAL Tc from the stream (e.g. -1.1)
    // …and the values STAY after deselection — a new text starts with the last clicked style
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  // the colour panel closes on any press outside it (capture — overlays stop propagation)
  useEffect(() => {
    if (!colorOpen) return
    const close = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.pdfed__colorwrap')) setColorOpen(null) }
    window.addEventListener('mousedown', close, true)
    return () => window.removeEventListener('mousedown', close, true)
  }, [colorOpen])

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

  // Keyboard: arrows nudge the selection by one screen pixel (page scroll suppressed) — the frame
  // moves instantly, the accumulated shift is committed to the stream after a short pause. Ctrl+C
  // copies the selection to the internal clipboard, Ctrl+V duplicates it into the stream.
  useEffect(() => {
    const isField = (n) => n instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) || n.isContentEditable)
    const onKey = (e) => {
      if (isField(e.target)) return
      if (e.key === 'Escape' && pipette) { setPipette(false); return }
      // physical keys (e.code), so the shortcuts work in any keyboard layout (RU gives e.key='с'/'м')
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') { if (selected) { e.preventDefault(); copySelected() } return }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') { if (clip) { e.preventDefault(); pasteClip() } return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); deleteSelected(); return } // same as the trash button / context menu
      const K = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
      if (!K || !selected || e.ctrlKey || e.metaKey) return
      e.preventDefault() // keep the viewport from scrolling
      const step = (e.shiftKey ? 10 : 1) / scale // one screen pixel per press, 10 with Shift
      const cur = nudgeRef.current || { dx: 0, dy: 0, page: selected.page, objs: selected.objs }
      cur.dx += K[0] * step
      cur.dy += K[1] * step
      nudgeRef.current = cur
      setNudge({ page: cur.page, dx: cur.dx, dy: cur.dy })
      clearTimeout(cur.timer)
      cur.timer = setTimeout(() => {
        const n = nudgeRef.current
        nudgeRef.current = null
        setNudge(null)
        if (n && (n.dx || n.dy)) moveSelected(n.page, n.objs, n.dx, n.dy)
      }, 350)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, clip, model, scale, pipette])

  // While the context menu is open, ANY mousedown outside it closes it. Capture phase — the page
  // overlays stopPropagation their mousedowns, so the menu's own document listener never sees them.
  useEffect(() => {
    if (!menu) return
    const close = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.ctx-menu')) setMenu(null) }
    window.addEventListener('mousedown', close, true)
    return () => window.removeEventListener('mousedown', close, true)
  }, [menu])

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

  // debug: one compact line per object, so selection/copy/paste lists can be compared
  const dbg = (o) => `${o.id} ${o.type} z${o.z} [${o.bbox.x},${o.bbox.y},${o.bbox.w},${o.bbox.h}]${o.text ? ' "' + o.text.slice(0, 30) + '"' : ''}`

  const onSelect = (pageIndex, objs) => {
    // any selection change discards an uncommitted arrow-key nudge — its timer must never fire
    // against a selection that no longer exists
    if (nudgeRef.current) { clearTimeout(nudgeRef.current.timer); nudgeRef.current = null; setNudge(null) }
    console.log(`[pdf][select] page ${pageIndex}, ${objs?.length || 0} objs:\n` + (objs || []).map(dbg).join('\n'))
    setSelected(objs && objs.length ? { page: pageIndex, objs } : null)
  }
  const imgOf = (i) => imgs.find((im) => im.pageIndex === i)

  // transparent sprite of ONLY the given objects (for the drag ghost) — nothing around them leaks in
  const spriteFor = async (pageIndex, objs) => {
    const zs = objs.map((o) => o.z).filter((z) => z >= 0)
    if (!zs.length) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const o of objs) { x0 = Math.min(x0, o.bbox.x); y0 = Math.min(y0, o.bbox.y); x1 = Math.max(x1, o.bbox.x + o.bbox.w); y1 = Math.max(y1, o.bbox.y + o.bbox.h) }
    try {
      const r = await engineRef.current.renderObjects(pageIndex, zs, { x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 }, renderScale)
      return { url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), x: r.x, y: r.y, w: r.w, h: r.h }
    } catch (err) { console.error('[pdf] sprite failed:', err); return null }
  }

  // Save: OS save dialog starting at the source file (same name → the OS confirms the overwrite,
  // a new name → a copy), then write the worker's edited document to disk.
  const handleSave = async () => {
    if (!engineRef.current || saving) return
    setSaving(true)
    try {
      const out = await api.pdf.saveDialog(path)
      if (out) {
        const r = await engineRef.current.save()
        const w = await api.pdf.write(out, new Uint8Array(r.bytes))
        if (!w?.ok) throw new Error(w?.error || 'write failed')
      }
    } catch (err) { console.error('[pdf] save failed:', err) } finally { setSaving(false) }
  }

  // re-render one page's image + model after a mutation; returns the fresh model
  const refreshPage = async (pageIndex) => {
    const [im, m] = await Promise.all([engineRef.current.renderImage(pageIndex, scale), engineRef.current.getModel(pageIndex)])
    const url = URL.createObjectURL(new Blob([im.png], { type: 'image/png' }))
    urlsRef.current.push(url)
    setImgs((prev) => prev.map((p) => (p.pageIndex === pageIndex ? { pageIndex, url, width: im.width, height: im.height } : p)))
    setModel((prev) => prev.map((p) => (p.pageIndex === pageIndex ? { pageIndex, ...m } : p)))
    return m
  }

  // drag → shift the objects' coordinates inside the PDF stream, then re-render. The objects arrive
  // as an argument (not from state) so press-and-drag works in ONE gesture, before the state lands.
  const moveSelected = async (pageIndex, objs, dx, dy) => {
    if (!objs?.length) return
    const items = objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y, dx, dy })) // x/y = exact text anchor
    try {
      await engineRef.current.moveObjects(pageIndex, items)
      await refreshPage(pageIndex)
      // keep the SAME selection, just shifted — no re-computing from the fresh model (which could
      // return inflated/merged boxes when the objects land next to other content). The selection
      // lives until the user clicks something else.
      const shifted = objs.map((o) => ({
        ...o,
        bbox: { ...o.bbox, x: o.bbox.x + dx, y: o.bbox.y + dy },
        x: o.x + dx,
        y: o.y + dy,
        // a line/arrow carries its endpoints too — the handles must travel with the move
        line: o.line ? { ...o.line, x1: o.line.x1 + dx, y1: o.line.y1 + dy, x2: o.line.x2 + dx, y2: o.line.y2 + dy } : undefined
      }))
      console.log(`[pdf][move] d=(${dx.toFixed(1)},${dy.toFixed(1)}), ${shifted.length} object(s) shifted`)
      onSelect(pageIndex, shifted)
    } catch (err) { console.error('[pdf] move failed:', err) }
  }

  // object signature that survives a re-parse: for text — stext metrics + the string itself (the
  // raster bbox tightening can shift y/h when a copy overlaps a neighbour, so those stay out of it)
  const sigOf = (o) => (o.type === 'text'
    ? `t|${o.bbox.x.toFixed(1)}|${o.bbox.w.toFixed(1)}|${o.size}|${o.text}`
    : `${o.type}|${o.bbox.x.toFixed(1)},${o.bbox.y.toFixed(1)},${o.bbox.w.toFixed(1)},${o.bbox.h.toFixed(1)}|${o.kind || ''}`)
  const allOf = (pg) => [...pg.runs, ...(pg.images || []), ...(pg.vectors || [])]

  // one mutation at a time: rapid clicks (B, B, I…) while a delete+insert+re-render is in flight
  // would operate on stale bboxes and shred neighbouring content
  const busyRef = useRef(false)

  // universal fallback font for every text mutation — the worker swaps it in whenever a chosen
  // font can't encode the text (validated BEFORE anything is deleted)
  const fallbackRef = useRef(null)
  const getFallback = async () => {
    if (!fallbackRef.current) {
      const f = await api.fonts.file('Arial', {}).catch(() => null)
      if (f?.bytes) fallbackRef.current = { bytes: f.bytes, family: 'Arial' }
    }
    return fallbackRef.current
  }

  // Resolve the font FILE for a family+style. A document font reuses its own bytes (pdf: name → the
  // worker pulls them from the file) so restyled text looks exactly like the rest of the document.
  // BUT: for NEW text a subset/non-embedded PDF font can't be trusted (missing glyphs) — the system
  // lookalike steps in. A style change (bold/italic) also falls back to the lookalike in that style.
  const fontSourceFor = async (family, bold, italic, forNewText = false) => {
    const df = docFonts.find((f) => f.name === family)
    // own bytes only for TrueType document fonts (Type1/CFF mis-encode through our CID insert),
    // unstyled, and — for NEW text — only full (non-subset) faces
    if (df && df.tt && !bold && !italic && !(forNewText && (df.subset || !df.embedded))) return { pdf: family }
    if (df) family = df.match || df.name
    const f = await api.fonts.file(family, { bold, italic })
    return f?.bytes ? { bytes: f.bytes, family } : null
  }

  // Re-style the SELECTED text objects on the page: delete their units and re-insert the same text
  // at the same baselines with the new font/colour/style — position is untouched by construction.
  const restyleSelected = async (patch) => {
    if (!selected || busyRef.current) return
    const pg = model.find((p) => p.pageIndex === selected.page)
    if (!pg) return
    const texts = selected.objs.filter((o) => o.type === 'text')
    if (!texts.length) return
    busyRef.current = true
    try {
      const fonts = {}
      const lines = []
      for (const o of texts) {
        const cur = pg.fonts?.[o.f] || {}
        const family = patch.family || cur.name || 'Arial'
        const bold = patch.bold !== undefined ? patch.bold : !!cur.bold
        const italic = patch.italic !== undefined ? patch.italic : !!cur.italic
        const k = `${family}|${bold ? 'b' : ''}${italic ? 'i' : ''}`
        if (!fonts[k]) {
          const src = await fontSourceFor(family, bold, italic)
          if (src) fonts[k] = src
        }
        // LS is a DELTA over the run's own base layout, never an absolute Tc of the replacement
        // font: base = current width minus its current spacing; target = base + wanted LS. So
        // LS=0 always returns to the run's ORIGINAL width (whatever font/kerning produced it),
        // and 5↔0 cycles are exact.
        const gaps = Math.max(1, (o.text || '').length - 1)
        const sizeScale = patch.size ? patch.size / (o.size || patch.size) : 1
        const baseW = (o.bbox.w - (o.ls || 0) * gaps) * sizeScale
        const wantLS = patch.ls !== undefined ? patch.ls : (o.ls || 0)
        lines.push([{
          text: o.text,
          size: patch.size || o.size,
          color: patch.color || pg.colors?.[o.c] || '#000000',
          fontKey: k,
          x: o.x,
          baseline: o.y,
          ls: undefined, // the worker always fits Tc to the target width
          fitW: baseW + wantLS * gaps
        }])
      }
      const before = new Set(allOf(pg).map(sigOf))
      // ATOMIC replace: the worker validates every font against the actual text FIRST — if a font
      // can't encode it (and the fallback can't either), nothing gets deleted
      await engineRef.current.replaceText(
        selected.page,
        texts.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })), // x/y anchors → each run's OWN show op is blanked, neighbours untouched
        { lines },
        fonts,
        await getFallback()
      )
      const m = await refreshPage(selected.page)
      const changed = allOf(m).filter((o) => !before.has(sigOf(o)))
      console.log(`[pdf][restyle] ${texts.length} run(s) →`, patch)
      onSelect(selected.page, changed)
    } catch (err) { console.error('[pdf] restyle failed (nothing deleted):', err) } finally { busyRef.current = false }
  }

  // CSS family for a font name: a document font falls back to its system lookalike, so the editor
  // previews something sensible even when the embedded face couldn't be loaded into the browser
  const cssFontFor = (family) => {
    const df = docFonts.find((f) => f.name === family)
    return df?.match ? `"${family}", "${df.match}"` : `"${family}"`
  }

  // typing into a number box fires per keystroke — batch the page-mutations into ONE (450ms after
  // the last change); the open rich-editor is styled immediately (cheap, local)
  const deferRef = useRef(null)
  const deferMutation = (fn) => { clearTimeout(deferRef.current); deferRef.current = setTimeout(fn, 450) }

  // toolbar controls: an open rich-editor gets the command; otherwise the page selection is restyled
  const pickFont = (family) => { setFontSel(family); if (textEdit) rteRef.current?.exec('fontName', cssFontFor(family)); else restyleSelected({ family }) }
  const pickColor = (hex) => { setColorSel(hex); if (textEdit) rteRef.current?.exec('foreColor', hex); else restyleSelected({ color: hex }) }
  const pickSize = (v) => { const s = Math.max(4, Math.min(200, v || 12)); setFontSize(s); if (textEdit) rteRef.current?.exec('size', s); else deferMutation(() => restyleSelected({ size: s })) }
  const allBold = () => { const pg = model.find((p) => p.pageIndex === selected?.page); return !!pg && selected.objs.filter((o) => o.type === 'text').every((o) => pg.fonts?.[o.f]?.bold) }
  const allItalic = () => { const pg = model.find((p) => p.pageIndex === selected?.page); return !!pg && selected.objs.filter((o) => o.type === 'text').every((o) => pg.fonts?.[o.f]?.italic) }
  const toggleBold = () => {
    if (textEdit) { setBoldSel((v) => !v); rteRef.current?.exec('bold') }
    else if (selected) { const b = !allBold(); setBoldSel(b); restyleSelected({ bold: b }) }
    else setBoldSel((v) => !v) // nothing open/selected → default for the next inserted text
  }
  const toggleItalic = () => {
    if (textEdit) { setItalicSel((v) => !v); rteRef.current?.exec('italic') }
    else if (selected) { const i = !allItalic(); setItalicSel(i); restyleSelected({ italic: i }) }
    else setItalicSel((v) => !v)
  }

  // LS on a selection: re-insert the runs with the letter spacing written as Tc
  const pickLS = (v) => {
    const ls = isNaN(v) ? 0 : v
    setLetterS(ls)
    if (!textEdit && selected) deferMutation(() => restyleSelected({ ls }))
  }
  // LH on a selection of SEVERAL text lines: respace their baselines (top line stays put,
  // every next baseline lands at prev + LH × its size) — plain per-item vertical moves
  const pickLH = (v) => {
    const lh = v || 1.25
    setLineH(lh)
    if (!textEdit && selected) deferMutation(() => applyLineHeight(lh))
  }
  const applyLineHeight = async (lh) => {
    if (busyRef.current || !selected) return
    const texts = selected.objs.filter((o) => o.type === 'text').sort((a, b) => a.y - b.y)
    if (texts.length < 2) { console.log('[pdf][line-height] needs 2+ selected text lines'); return }
    busyRef.current = true
    try {
      const items = []
      const shifted = [texts[0]]
      let target = texts[0].y
      for (let i = 1; i < texts.length; i++) {
        target += lh * (texts[i].size || 12)
        const dy = +(target - texts[i].y).toFixed(2)
        if (dy) items.push({ type: 'text', bbox: texts[i].bbox, x: texts[i].x, y: texts[i].y, dx: 0, dy })
        shifted.push({ ...texts[i], y: +target.toFixed(2), bbox: { ...texts[i].bbox, y: +(texts[i].bbox.y + dy).toFixed(2) } })
      }
      if (items.length) {
        await engineRef.current.moveObjects(selected.page, items)
        await refreshPage(selected.page)
      }
      console.log(`[pdf][line-height] ${lh} → ${items.length} line(s) moved`)
      onSelect(selected.page, shifted.concat(selected.objs.filter((o) => o.type !== 'text')))
    } catch (err) { console.error('[pdf] line-height failed:', err) } finally { busyRef.current = false }
  }

  // eyedropper: pick a text on the page → copy its FULL style (font, size, colour, bold/italic)
  // into the toolbar state AND the current target: the open rich editor, or the selected text
  // objects on the page (restyled in the stream)
  const pipettePick = (pageIndex, o) => {
    setPipette(false)
    const pg = model.find((p) => p.pageIndex === pageIndex)
    const f = pg?.fonts?.[o.f]
    if (!f) return
    const color = pg.colors?.[o.c] || '#000000'
    setFontSel(f.name); setFontSize(o.size); setColorSel(color); setBoldSel(!!f.bold); setItalicSel(!!f.italic)
    console.log('[pdf][pipette]', f.name, o.size, color, f.bold ? 'bold' : '', f.italic ? 'italic' : '')
    if (textEdit) {
      rteRef.current?.exec('applyStyle', { family: cssFontFor(f.name), sizePx: o.size, color, bold: !!f.bold, italic: !!f.italic })
    } else if (selected) {
      restyleSelected({ family: f.name, size: o.size, color, bold: !!f.bold, italic: !!f.italic })
    }
  }

  // one gateway for every in-place object mutation (recolor / radius / stroke width / opacity):
  // run the op, re-read the page, re-find the object by its centre so it stays selected
  const mutateObject = async (op, kinds = ['vector'], center = null) => {
    if (busyRef.current || !selObj1 || !kinds.includes(selObj1.type)) return
    busyRef.current = true
    const pageIndex = selected.page
    const obj = selObj1
    try {
      await op(pageIndex, { type: obj.type, bbox: obj.bbox })
      const m = await refreshPage(pageIndex)
      const pool = obj.type === 'vector' ? m.vectors : m.images
      // re-find where the object is EXPECTED to be: a geometry-changing op (endpoint drag) passes
      // the new centre — searching around the old bbox would lose a rotated line entirely
      const cx = center ? center.x : obj.bbox.x + obj.bbox.w / 2
      const cy = center ? center.y : obj.bbox.y + obj.bbox.h / 2
      let best = null, bestD = center ? 25 : 9
      for (const o of pool || []) {
        const d = Math.hypot(o.bbox.x + o.bbox.w / 2 - cx, o.bbox.y + o.bbox.h / 2 - cy)
        if (d < bestD) { bestD = d; best = o }
      }
      onSelect(pageIndex, best ? [best] : [obj])
    } catch (err) { console.error('[pdf] object op failed:', err) } finally { busyRef.current = false }
  }
  const recolorSelected = (colors) => mutateObject((p, it) => engineRef.current.recolorVector(p, it, colors))
  const radiusSelected = (r) => mutateObject((p, it) => engineRef.current.setVectorRadius(p, it, r))
  const strokeWidthSelected = (w) => mutateObject((p, it) => engineRef.current.setStrokeWidth(p, it, w))
  const opacitySelected = (pct) => mutateObject((p, it) => engineRef.current.setOpacity(p, it, Math.max(0, Math.min(100, pct)) / 100), ['vector', 'image'])
  const dashSelected = (d) => mutateObject((p, it) => engineRef.current.setDash(p, it, d))
  const lineGeoSelected = (pageIndex, obj, geo) =>
    mutateObject((p, it) => engineRef.current.setLineGeo(p, it, geo), ['vector'], { x: (geo.x1 + geo.x2) / 2, y: (geo.y1 + geo.y2) / 2 })

  // resize an image/vector to a new bbox (from the selection frame's handles)
  const resizeSelected = async (pageIndex, obj, nb) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      await engineRef.current.resizeObject(pageIndex, { type: obj.type, bbox: obj.bbox }, nb)
      await refreshPage(pageIndex)
      onSelect(pageIndex, [{ ...obj, bbox: nb }]) // keep it selected at its new size
    } catch (err) { console.error('[pdf] resize failed:', err) } finally { busyRef.current = false }
  }

  // ---- insert text: rich-editor content → styled runs → written into the PDF stream ----
  const startTextEdit = (pageIndex, x, y) => {
    setInsertMode(false)
    onSelect(pageIndex, null)
    setTextEdit({ page: pageIndex, x, y })
  }

  // ---- insert image: pick a PNG/JPEG/SVG, then click the page where it goes ----
  // PDF has no native SVG — an SVG is rasterised to PNG at 3x for headroom before embedding
  const svgToPng = (svgBytes) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svgBytes], { type: 'image/svg+xml' }))
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth || 300, h = img.naturalHeight || 300
      const c = document.createElement('canvas')
      c.width = Math.round(w * 3); c.height = Math.round(h * 3)
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      c.toBlob((b) => (b ? b.arrayBuffer().then(resolve) : reject(new Error('svg rasterise failed'))), 'image/png')
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('svg load failed')) }
    img.src = url
  })
  const pickImageFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/svg+xml,.svg'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      try {
        let bytes = await f.arrayBuffer()
        if (/svg/i.test(f.type) || /\.svg$/i.test(f.name)) bytes = await svgToPng(bytes)
        const bmp = await createImageBitmap(new Blob([bytes]))
        const px = /svg/i.test(f.type) || /\.svg$/i.test(f.name) ? 3 : 1 // undo the 3x headroom for the on-page size
        const scale = Math.min(1 / px, 300 / bmp.width, 300 / bmp.height) // sane default size, keeps ratio
        const w = +(bmp.width * scale).toFixed(2), h = +(bmp.height * scale).toFixed(2)
        bmp.close?.()
        setInsertMode({ image: { bytes, w, h } })
      } catch (err) { console.error('[pdf] image pick failed:', err) }
    }
    input.click()
  }
  const placeImage = async (pageIndex, x, y, img) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const before = new Set(allOf(model.find((p) => p.pageIndex === pageIndex) || { runs: [] }).map(sigOf))
      await engineRef.current.insertImage(pageIndex, img.bytes, x, y, img.w, img.h)
      const m = await refreshPage(pageIndex)
      onSelect(pageIndex, allOf(m).filter((o) => !before.has(sigOf(o)))) // the placed image comes out selected
    } catch (err) { console.error('[pdf] insert image failed:', err) } finally { busyRef.current = false }
  }
  // ---- insert shape: pick a kind, then click (default size) or drag (custom size) on the page ----
  const placeShape = async (pageIndex, kind, geo) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const before = new Set(allOf(model.find((p) => p.pageIndex === pageIndex) || { runs: [] }).map(sigOf))
      await engineRef.current.insertShape(pageIndex, kind.kind || kind, geo, { color: colorSel, strokeW, radius: cornerR, dash: dashSel, head: kind.head })
      const m = await refreshPage(pageIndex)
      onSelect(pageIndex, allOf(m).filter((o) => !before.has(sigOf(o))))
    } catch (err) { console.error('[pdf] insert shape failed:', err) } finally { busyRef.current = false }
  }

  // one entry point for every armed insert mode; `drag` carries the drawn rectangle for shapes
  const startInsertAt = (pageIndex, x, y, drag) => {
    const mode = insertMode
    setInsertMode(false)
    if (mode === 'text') startTextEdit(pageIndex, x, y)
    else if (mode?.image) placeImage(pageIndex, x, y, mode.image)
    else if (mode?.shape) {
      const kind = mode.shape.kind
      let geo
      if (drag && (Math.abs(drag.x2 - drag.x1) > 3 || Math.abs(drag.y2 - drag.y1) > 3)) {
        geo = {
          x: Math.min(drag.x1, drag.x2), y: Math.min(drag.y1, drag.y2),
          w: Math.max(2, Math.abs(drag.x2 - drag.x1)), h: Math.max(2, Math.abs(drag.y2 - drag.y1)),
          x1: drag.x1, y1: drag.y1, x2: drag.x2, y2: drag.y2
        }
      } else {
        // sensible click-defaults: marks are small (16pt), an arrow 60pt, boxes 120x80, a line 120
        const dw = kind === 'check' || kind === 'cross' ? 16 : kind === 'arrow' ? 60 : 120
        const dh = kind === 'line' || kind === 'arrow' ? 0 : kind === 'check' || kind === 'cross' ? 16 : 80
        geo = { x, y, w: dw, h: dh, x1: x, y1: y, x2: x + dw, y2: y + dh }
      }
      if (kind === 'line') {
        // a line snaps to the drag's dominant axis: strictly horizontal or strictly vertical
        if (Math.abs(geo.x2 - geo.x1) >= Math.abs(geo.y2 - geo.y1)) {
          const lx = Math.min(geo.x1, geo.x2), rx = Math.max(geo.x1, geo.x2)
          geo = { ...geo, x1: lx, x2: rx, y1: geo.y1, y2: geo.y1, x: lx, y: geo.y1, w: rx - lx, h: 0 }
        } else {
          const ty = Math.min(geo.y1, geo.y2), by = Math.max(geo.y1, geo.y2)
          geo = { ...geo, y1: ty, y2: by, x1: geo.x1, x2: geo.x1, x: geo.x1, y: ty, w: 0, h: by - ty }
        }
      }
      placeShape(pageIndex, mode.shape, geo)
    }
  }
  const commitText = async (lines) => {
    const te = textEdit
    if (!te || busyRef.current) return
    busyRef.current = true
    try {
      // one embedded font per unique family+style used in the text (document fonts keep their own bytes)
      const keyOf = (s) => `${s.fontName}|${s.bold ? 'b' : ''}${s.italic ? 'i' : ''}`
      const fonts = {}
      console.log('[pdf][insert-text] parsed lines:', JSON.stringify(lines))
      for (const l of lines) for (const s of l) {
        const k = keyOf(s)
        if (fonts[k]) continue
        const src = await fontSourceFor(s.fontName, s.bold, s.italic, true) // new text → full fonts only
        if (src) fonts[k] = src
        else console.warn('[pdf][insert-text] NO FONT for', k)
      }
      console.log('[pdf][insert-text] fonts:', Object.keys(fonts).map((k) => `${k}${fonts[k].pdf ? ' (pdf)' : ' (file)'}`).join(', ') || 'NONE')
      // every run carries its EXACT page coordinates measured from the editor's real DOM rects
      const spec = { lines: lines.map((l) => l.map((s) => ({ text: s.text, size: s.size, color: s.color, fontKey: keyOf(s), x: s.x, baseline: s.baseline, ls: s.ls }))) }
      const before = new Set(allOf(model.find((p) => p.pageIndex === te.page) || { runs: [] }).map(sigOf))
      await engineRef.current.insertText(te.page, spec, fonts, await getFallback())
      setTextEdit(null) // close ONLY after a successful insert — a font failure keeps the editor (and the text) alive
      const m = await refreshPage(te.page)
      const added = allOf(m).filter((o) => !before.has(sigOf(o)))
      console.log(`[pdf][insert-text] page ${te.page}, ${lines.length} line(s) → ${added.length} objects`)
      onSelect(te.page, added) // the inserted text comes out selected
    } catch (err) { console.error('[pdf] insert text failed (editor kept open):', err) } finally { busyRef.current = false }
  }

  // ---- copy / paste: duplicate the selected objects straight into the PDF stream ----
  const copySelected = () => {
    if (!selected) return
    const items = selected.objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })) // x/y = exact text anchor
    console.log(`[pdf][copy] page ${selected.page}, ${items.length} items to clipboard:\n` + selected.objs.map(dbg).join('\n'))
    if (items.length) setClip({ page: selected.page, items })
  }
  const doPaste = async (dx, dy) => {
    if (!clip) return
    try {
      const before = new Set(allOf(model.find((p) => p.pageIndex === clip.page) || { runs: [] }).map(sigOf))
      await engineRef.current.copyObjects(clip.page, clip.items, dx, dy)
      const m = await refreshPage(clip.page)
      // the pasted copies are EXACTLY the objects that didn't exist before the paste — no
      // geometric guessing, so the selection can't grab neighbouring originals
      const pasted = allOf(m).filter((o) => !before.has(sigOf(o)))
      console.log(`[pdf][paste] page ${clip.page}, d=(${dx.toFixed(1)},${dy.toFixed(1)}), pasted ${pasted.length} of ${clip.items.length}`)
      // the paste re-numbers/re-parses everything, so the clipboard's stored geometry is stale —
      // clear it (copy again to paste again); the pasted objects themselves come out selected
      setClip(null)
      onSelect(clip.page, pasted) // re-select through the ONE selection entry point — as if just selected by hand
    } catch (err) { console.error('[pdf] paste failed:', err) }
  }
  // Ctrl+V / toolbar: 24 screen pixels down-right — always visibly offset from the original
  const pasteClip = () => doPaste(24 / scale, 24 / scale)
  // context menu on empty space: paste AT the clicked point (the copies' top-left corner lands there)
  const pasteClipAt = (x, y) => {
    if (!clip) return
    const x0 = Math.min(...clip.items.map((it) => it.bbox.x))
    const y0 = Math.min(...clip.items.map((it) => it.bbox.y))
    return doPaste(x - x0, y - y0)
  }

  // double-click on the selection → physically remove the selected objects from the PDF stream.
  // (The file on disk is untouched; reopening the tab restores everything.)
  const deleteSelected = async () => {
    if (!selected) return
    const items = selected.objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })) // anchors → surgical text delete
    if (!items.length) return
    onSelect(selected.page, null) // selection (and any pending nudge) is gone with the objects
    try {
      await engineRef.current.deleteObjects(selected.page, items)
      await refreshPage(selected.page)
    } catch (err) { console.error('[pdf] delete failed:', err) }
  }

  // what the second (contextual) toolbar row edits: text controls, the selected object's panel,
  // or just a hint when nothing is selected (no confusing default font controls)
  const selKind = textEdit
    ? 'text'
    : !selected
      ? 'none'
      : selected.objs.every((o) => o.type === 'text')
        ? 'text'
        : selected.objs.length === 1
          ? selected.objs[0].type
          : 'mixed'
  const selObj1 = selected?.objs.length === 1 ? selected.objs[0] : null
  const pickObjX = (v) => { if (selObj1) deferMutation(() => moveSelected(selected.page, selected.objs, v - selObj1.bbox.x, 0)) }
  const pickObjY = (v) => { if (selObj1) deferMutation(() => moveSelected(selected.page, selected.objs, 0, v - selObj1.bbox.y)) }

  return (
    <div className="pdfed">
      <div className="pdfed__toolbar">
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.max(0.3, s / 1.15))} title="Zoom out"><ZoomOutIcon /></button>
        <span className="pdfed__zoom">{Math.round(scale * 100)}%</span>
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.min(10, s * 1.15))} title="Zoom in"><ZoomInIcon /></button>
        <span className="pdfed__sep" />
        {/* insert section: arm a mode (text / image; shapes coming), then click the page */}
        <button
          className={'pdfed__btn' + (insertMode === 'text' ? ' is-active' : '')}
          onClick={() => setInsertMode((m) => (m === 'text' ? false : 'text'))}
          title="Insert text — click the page where it should go"
        >
          <InsertTextIcon />
        </button>
        <button
          className={'pdfed__btn' + (insertMode?.image ? ' is-active' : '')}
          onClick={pickImageFile}
          title="Insert image (PNG/JPEG) — pick a file, then click the page"
        >
          <InsertImageIcon />
        </button>
        <button
          className={'pdfed__btn' + (insertMode?.shape ? ' is-active' : '')}
          onClick={(e) => {
            if (insertMode?.shape) { setInsertMode(false); return }
            const r = e.currentTarget.getBoundingClientRect()
            setShapeMenu({ x: r.left, y: r.bottom + 4 })
          }}
          title="Insert shape — pick a kind, then click or drag on the page"
        >
          <InsertShapeIcon />
        </button>
        <span className="pdfed__sep" />
        <button className="pdfed__btn" onClick={copySelected} disabled={!selected} title="Copy (Ctrl+C)"><CopyIcon /></button>
        <button className="pdfed__btn" onClick={pasteClip} disabled={!clip} title="Paste (Ctrl+V)"><PasteIcon /></button>
        <button className="pdfed__btn" onClick={deleteSelected} disabled={!selected} title="Delete"><TrashIcon /></button>
        <button className="pdfed__btn pdfed__btn--txt pdfed__btn--save" onClick={handleSave} disabled={saving || !path} title="Save">{saving ? '…' : 'Save'}</button>
        <span className="pdfed__spacer" />
        <label className="pdfed__check" title="Outline every element on the page (faint grey), so you can see where everything is">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          All
        </label>
        <span className="pdfed__status">{status === 'loading' ? '…' : `${pageCount} p.`}</span>
      </div>

      {/* second row — contextual: text style controls, shape parameters, or the object's panel */}
      <div className="pdfed__stylebar">
        {insertMode?.shape && (
          <>
            <span className="pdfed__sblabel">Shape · {insertMode.shape.kind}</span>
            {insertMode.shape.kind === 'rect' && (
              <label className="pdfed__mini" title="Corner radius, pt">
                R
                <ComboNum value={cornerR} onPick={(v) => setCornerR(Math.max(0, v || 0))} opts={[0, 2, 4, 6, 8, 12, 16, 24]} step={1} min={0} max={200} width={64} />
              </label>
            )}
            <label className="pdfed__mini" title="Stroke width, pt">
              W
              <ComboNum value={strokeW} onPick={(v) => setStrokeW(Math.max(0.2, v || 1))} opts={[0.5, 1, 1.5, 2, 3, 4, 6]} step={0.5} min={0.2} max={40} width={64} />
            </label>
            <select className="pdfed__fontsel pdfed__dashsel" value={dashSel} onChange={(e) => setDashSel(e.target.value)} title="Line type">
              <option value="solid">— Solid</option>
              <option value="dashed">– – Dashed</option>
              <option value="dotted">· · Dotted</option>
              <option value="dashdot">–·– Dash-dot</option>
            </select>
            <span className="pdfed__sbinfo">
              stroke <span className="pdfed__swatch" style={{ background: colorSel, display: 'inline-block', verticalAlign: '-3px' }} /> — click or drag on the page
            </span>
          </>
        )}
        {!insertMode?.shape && selKind === 'text' && (
          <>
        <select
          className="pdfed__fontsel"
          value={fontSel}
          disabled={styleLocked}
          onMouseDown={() => rteRef.current?.grabSel()}
          onChange={(e) => pickFont(e.target.value)}
          title={styleLocked ? 'Select a single text object to change its style' : 'Font'}
        >
          {docFonts.length > 0 && (
            <optgroup label="PDF">
              {docFonts.map((f) => (
                <option key={f.name} value={f.name}>{f.name + (f.match ? ` → ${f.match}` : '')}</option>
              ))}
            </optgroup>
          )}
          {docFonts.some((f) => f.match) && (
            /* system lookalikes of the document's fonts — full faces, safe for typing NEW text */
            <optgroup label="Similar (≈ PDF)">
              {[...new Map(docFonts.filter((f) => f.match).map((f) => [f.match, f])).entries()].map(([m, f]) => (
                <option key={'sim:' + m} value={m} style={{ fontFamily: m }}>{`${m} ≈ ${f.name}`}</option>
              ))}
            </optgroup>
          )}
          <optgroup label="System">
            {sysFonts.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </optgroup>
        </select>
        <ComboNum value={fontSize} onPick={pickSize} opts={SIZES} step={0.5} min={4} max={200} width={72} title="Font size (pt)" onGrab={() => rteRef.current?.grabSel()} disabled={styleLocked} />
        <button
          className={'pdfed__btn pdfed__btn--txt' + ((singleText ? selPg?.fonts?.[singleText.f]?.bold : boldSel) ? ' is-active' : '')}
          disabled={styleLocked}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleBold}
          title="Bold"
        ><b>B</b></button>
        <button
          className={'pdfed__btn pdfed__btn--txt' + ((singleText ? selPg?.fonts?.[singleText.f]?.italic : italicSel) ? ' is-active' : '')}
          disabled={styleLocked}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleItalic}
          title="Italic"
        ><i>I</i></button>
        <label className="pdfed__mini" title="Line height — select TWO OR MORE text lines to respace their baselines (top one stays); also the insert editor's spacing">
          LH
          <ComboNum
            value={lineH}
            onPick={pickLH}
            opts={LH_OPTS}
            step={0.05}
            min={0.8}
            max={3}
            width={64}
            disabled={!textEdit && !!selected && selected.objs.filter((o) => o.type === 'text').length < 2}
          />
        </label>
        <label className="pdfed__mini" title="Letter spacing, pt (Tc): applies to the selected text / the insert editor">
          LS
          <ComboNum value={letterS} onPick={pickLS} opts={LS_OPTS} step={0.1} min={-10} max={20} width={64} disabled={styleLocked && !selected?.objs.some((o) => o.type === 'text')} />
        </label>
        <div className="pdfed__colorwrap">
          <button
            className="pdfed__btn"
            disabled={styleLocked}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setColorOpen((v) => (v ? null : { x: r.left, y: r.bottom + 4 })) // fixed coords — the toolbar's overflow can't clip it
            }}
            title={styleLocked ? 'Select a single text object to change its style' : 'Color'}
          >
            <span className="pdfed__swatch" style={{ background: colorSel }} />
          </button>
          {colorOpen && (
            <div className="pdfed__colorpanel" style={{ left: colorOpen.x, top: colorOpen.y }}>
              <div className="pdfed__swatches">
                {docColors.map((c) => (
                  <button
                    key={c}
                    className={'pdfed__swatchbtn' + (c === colorSel ? ' is-on' : '')}
                    style={{ background: c }}
                    title={c}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { pickColor(c); setColorOpen(null) }}
                  />
                ))}
              </div>
              {/* any colour beyond the document palette — the native picker */}
              <label className="pdfed__custom">
                Custom
                <input type="color" value={colorSel} onChange={(e) => pickColor(e.target.value)} />
              </label>
            </div>
          )}
        </div>
        <button
          className={'pdfed__btn' + (pipette ? ' is-active' : '')}
          disabled={!textEdit && !selected}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPipette((v) => !v)}
          title="Pick style from any text — applies to the selection or the open editor"
        >
          <PipetteIcon />
        </button>
          </>
        )}
        {!insertMode?.shape && (selKind === 'image' || selKind === 'vector') && selObj1 && (
          /* object panel — position is editable now; resize, fill/stroke colours and corner
             radius land here next */
          <>
            <span className="pdfed__sblabel">{selKind === 'image' ? 'Image' : 'Vector'}</span>
            <label className="pdfed__mini" title="X (pt)">
              X
              <ComboNum value={selObj1.bbox.x} onPick={pickObjX} opts={[]} step={0.5} min={-10000} max={10000} width={72} />
            </label>
            <label className="pdfed__mini" title="Y (pt)">
              Y
              <ComboNum value={selObj1.bbox.y} onPick={pickObjY} opts={[]} step={0.5} min={-10000} max={10000} width={72} />
            </label>
            <span className="pdfed__sbinfo">W {selObj1.bbox.w} · H {selObj1.bbox.h}</span>
            <label className="pdfed__mini" title="Opacity, % — vectors and images (PDF ExtGState alpha)">
              Op
              <ComboNum value={selObj1.opacity ?? 100} onPick={(v) => deferMutation(() => opacitySelected(v ?? 100))} opts={[10, 25, 50, 75, 100]} step={5} min={0} max={100} width={60} />
            </label>
            {selKind === 'vector' && (
              <>
                <label className="pdfed__mini" title="Stroke colour">
                  Stroke
                  <ColorDrop
                    value={selObj1.kind === 'stroke' ? selPg?.colors?.[selObj1.c] || '#000000' : '#000000'}
                    colors={docColors}
                    onPick={(c) => recolorSelected({ stroke: c })}
                    title="Stroke colour (incl. Transparent)"
                  />
                </label>
                <label className="pdfed__mini" title="Fill colour">
                  Fill
                  <ColorDrop
                    value={selObj1.kind === 'fill' ? selPg?.colors?.[selObj1.c] || '#000000' : '#ffffff'}
                    colors={docColors}
                    onPick={(c) => recolorSelected({ fill: c })}
                    title="Fill colour (incl. Transparent)"
                  />
                </label>
                <label className="pdfed__mini" title="Stroke width, pt — any vector">
                  W
                  <ComboNum value={selObj1.strokeW ?? 1} onPick={(v) => deferMutation(() => strokeWidthSelected(Math.max(0.2, v || 1)))} opts={[0.5, 1, 1.5, 2, 3, 4, 6]} step={0.5} min={0.2} max={40} width={60} />
                </label>
                <label className="pdfed__mini" title="Corner radius, pt — rebuilds the path as a rounded rectangle over the same bounds">
                  R
                  <ComboNum value={selObj1.radius ?? 0} onPick={(v) => deferMutation(() => radiusSelected(Math.max(0, v || 0)))} opts={[0, 2, 4, 6, 8, 12, 16, 24]} step={1} min={0} max={200} width={60} />
                </label>
                <select className="pdfed__fontsel pdfed__dashsel" value={selObj1.dash || 'solid'} onChange={(e) => dashSelected(e.target.value)} title="Line type">
                  <option value="solid">— Solid</option>
                  <option value="dashed">– – Dashed</option>
                  <option value="dotted">· · Dotted</option>
                  <option value="dashdot">–·– Dash-dot</option>
                </select>
              </>
            )}
          </>
        )}
        {!insertMode?.shape && selKind === 'mixed' && <span className="pdfed__sbinfo">{selected.objs.length} objects selected</span>}
        {!insertMode?.shape && selKind === 'none' && <span className="pdfed__sbinfo">Select an element on the page — its properties appear here</span>}
      </div>

      {shapeMenu && (
        <ContextMenu
          x={shapeMenu.x}
          y={shapeMenu.y}
          items={[
            { label: 'Rectangle', onClick: () => setInsertMode({ shape: { kind: 'rect' } }) },
            { label: 'Ellipse', onClick: () => setInsertMode({ shape: { kind: 'ellipse' } }) },
            { label: 'Check ✓', onClick: () => setInsertMode({ shape: { kind: 'check' } }) },
            { label: 'Cross ✕', onClick: () => setInsertMode({ shape: { kind: 'cross' } }) },
            {
              label: 'Line',
              children: [
                { label: 'Line —', onClick: () => setInsertMode({ shape: { kind: 'line' } }) },
                { label: 'Arrow →', onClick: () => setInsertMode({ shape: { kind: 'arrow', head: 'open' } }) },
                { label: 'Arrow ▶', onClick: () => setInsertMode({ shape: { kind: 'arrow', head: 'filled' } }) },
                { label: 'Arrow ↔', onClick: () => setInsertMode({ shape: { kind: 'arrow', head: 'double' } }) },
                { label: 'Arrow ⊸', onClick: () => setInsertMode({ shape: { kind: 'arrow', head: 'bar' } }) }
              ]
            }
          ]}
          onClose={() => setShapeMenu(null)}
        />
      )}

      <div className="pdfed__body">
        <div
          className="pdfed__viewport"
          ref={viewportRef}
          style={{ cursor: spaceHeld ? (panning ? 'grabbing' : 'grab') : undefined }}
          onMouseDown={onPanMouseDown}
        >
          <div className="pdfed__pages" style={{ pointerEvents: spaceHeld ? 'none' : undefined }}>
            {model.map((p) => (
              <PdfPage
                key={p.pageIndex}
                page={p}
                image={imgOf(p.pageIndex)}
                scale={scale}
                selected={selected}
                showAll={showAll}
                nudge={nudge && nudge.page === p.pageIndex ? nudge : null}
                insertMode={insertMode}
                textEdit={textEdit}
                pipette={pipette}
                rte={{
                  ref: rteRef,
                  font: cssFontFor(fontSel),
                  color: colorSel,
                  size: fontSize,
                  bold: boldSel,
                  italic: italicSel,
                  lineHeight: lineH,
                  letterSpacing: letterS,
                  pipette,
                  onPipette: () => setPipette((v) => !v)
                }}
                onSelect={onSelect}
                onMove={moveSelected}
                onResize={resizeSelected}
                onLineGeo={lineGeoSelected}
                onSprite={spriteFor}
                onMenu={setMenu}
                onInsertAt={startInsertAt}
                onPipettePick={pipettePick}
                onTextCommit={commitText}
                onTextCancel={() => setTextEdit(null)}
              />
            ))}
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.sx}
          y={menu.sy}
          items={
            menu.kind === 'sel'
              ? [
                  { label: <span className="pdfed__mi"><CopyIcon /> Copy</span>, onClick: copySelected },
                  { label: <span className="pdfed__mi"><TrashIcon /> Delete</span>, onClick: deleteSelected }
                ]
              : [
                  ...(clip ? [{ label: <span className="pdfed__mi"><PasteIcon /> Paste</span>, onClick: () => pasteClipAt(menu.x, menu.y) }] : []),
                  { label: <span className="pdfed__mi"><InsertTextIcon /> Insert text</span>, onClick: () => startTextEdit(menu.page, menu.x, menu.y) }
                ]
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
