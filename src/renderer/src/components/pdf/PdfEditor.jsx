import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ZoomInIcon, ZoomOutIcon, CopyIcon, PasteIcon, TrashIcon, PipetteIcon, ChevronLeftIcon, ChevronRightIcon } from '../icons'
import api from '../../lib/api'
import ContextMenu from '../ContextMenu'
import { useI18n } from '../../i18n/I18nContext'
import { createPdfEngine } from './pdfEngine'
import PdfPage from './PdfPage'
import './PdfEditor.css'

const SIZES = [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72, 80, 90]
const LH_OPTS = [1, 1.15, 1.25, 1.4, 1.5, 1.75, 2]

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

// selection-mode icons: single arrow — pick one element; double arrow — pick whole blocks
const CursorOneIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
    <path d="M6 3l12 9-6 1 3.5 7-2.8 1.3L9.4 14 6 18z" />
  </svg>
)
const CursorBlockIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
    <path d="M4 2l9 7-4.5 0.8 2.6 5.2-2.2 1L6.6 11 4 14z" />
    <path d="M12 9l9 7-4.5 0.8 2.6 5.2-2.2 1-2.3-5.2L12 21z" opacity="0.55" />
  </svg>
)

// a variable — braces {x}
const VariableIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 4c-2 0-3 1-3 3v2c0 1-1 2-2 2 1 0 2 1 2 2v2c0 2 1 3 3 3" />
    <path d="M16 4c2 0 3 1 3 3v2c0 1 1 2 2 2-1 0-2 1-2 2v2c0 2-1 3-3 3" />
  </svg>
)

const InfoIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
)

// align icons (standard: an edge line + two bars snapped to it)
const AlignLeftIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 3v18" />
    <rect x="7" y="6" width="13" height="4" fill="currentColor" stroke="none" />
    <rect x="7" y="14" width="8" height="4" fill="currentColor" stroke="none" />
  </svg>
)
// distribute rows — three bars at equal vertical spacing
const DistributeRowsIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <rect x="4" y="4" width="16" height="3" fill="currentColor" stroke="none" />
    <rect x="4" y="10.5" width="16" height="3" fill="currentColor" stroke="none" />
    <rect x="4" y="17" width="16" height="3" fill="currentColor" stroke="none" />
  </svg>
)
const AlignTopIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M3 4h18" />
    <rect x="6" y="7" width="4" height="13" fill="currentColor" stroke="none" />
    <rect x="14" y="7" width="4" height="8" fill="currentColor" stroke="none" />
  </svg>
)

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
  const { t } = useI18n()
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
  const [showAll, setShowAll] = useState(() => localStorage.getItem('pdfedShowAll') === '1') // faint grey frames around EVERY (non-empty) element; persists across restarts
  const [liveGeo, setLiveGeo] = useState(null) // geometry readout while dragging/resizing (from PdfPage)
  const [showInfo, setShowInfo] = useState(false) // the quick-guide overlay
  // ---- variables (PDF templating): named groups of identical text; editing the value updates every occurrence ----
  const [variables, setVariables] = useState([]) // [{ id, name, value, occurrences:[{page,x,baseline,bbox,family,bold,italic,size,color,ls,enabled}] }]
  const variablesRef = useRef(variables); variablesRef.current = variables
  const [varDraft, setVarDraft] = useState(null) // create popup: { value, name, page, objs }
  const [expandedVars, setExpandedVars] = useState(() => new Set()) // ids whose occurrence list is open (hidden by default)
  const toggleVarExpand = (id) => setExpandedVars((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const [varsCollapsed, setVarsCollapsed] = useState(() => localStorage.getItem('pdfedVarsCol') === '1')
  const [varsWidth, setVarsWidth] = useState(() => Math.min(Math.max(Number(localStorage.getItem('pdfedVarsW')) || 280, 180), 520))
  const varsWidthRef = useRef(varsWidth); varsWidthRef.current = varsWidth
  const varsRestoredRef = useRef(false) // guard: don't persist until we've loaded the stored vars
  const varsSaveRef = useRef(null) // debounce timer for persisting variables
  const [selMode, setSelMode] = useState('block') // 'single' — pick one element; 'block' — whole text blocks
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
    console.log('[pdf][open]', path || '(no path)') // full path in every session log — bug reports point at the exact file
    Promise.resolve(engineRef.current.open(source))
      .then((info) => { if (alive) setPageCount(info?.pageCount || 0) })
      .catch((err) => { console.error('[pdf] open failed:', err, '—', path); if (alive) setStatus('error') })
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
  // style controls (font, size, B/I, LS, colour) are live whenever ANY text is selected — a change
  // applies to EVERY selected text object; locked only for non-text (images/vectors) or empty
  const styleLocked = !textEdit && !selected?.objs.some((o) => o.type === 'text')
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
    console.log(`[pdf][select] ${path?.split(/[\\/]/).pop() || '?'} page ${pageIndex}, ${objs?.length || 0} objs:\n` + (objs || []).map(dbg).join('\n'))
    setSelected(objs && objs.length ? { page: pageIndex, objs } : null)
  }
  const imgOf = (i) => imgs.find((im) => im.pageIndex === i)

  // transparent sprite of ONLY the given objects (for the drag ghost) — nothing around them leaks in
  const spriteFor = async (pageIndex, objs) => {
    // a merged fill+stroke shape (filled arrow) spans TWO device ops — include its fill z too
    const zs = objs.flatMap((o) => (o.zf !== undefined ? [o.z, o.zf] : [o.z])).filter((z) => z >= 0)
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
  // ONE client-side selection shift for every op (move/align/distribute): bbox, anchors, the
  // oriented ink box of rotated objects AND line endpoints all travel together — partial copies of
  // this kept drifting apart (the frame snapped back to stale coordinates)
  const shiftObj = (o, dx, dy) => ({
    ...o,
    bbox: { ...o.bbox, x: o.bbox.x + dx, y: o.bbox.y + dy },
    x: o.x + dx,
    y: o.y + dy,
    ox: o.ox !== undefined ? o.ox + dx : undefined,
    oy: o.oy !== undefined ? o.oy + dy : undefined,
    line: o.line ? { ...o.line, x1: o.line.x1 + dx, y1: o.line.y1 + dy, x2: o.line.x2 + dx, y2: o.line.y2 + dy } : undefined
  })

  // does this text run share its baseline with another run of the SAME block? (then a plain stream
  // move would drag the whole line — "June" would pull "TES developing" along)
  const sharesLine = (pageIndex, o) => {
    const pg = model.find((p) => p.pageIndex === pageIndex)
    if (!pg || o.type !== 'text') return false
    const blk = (o.id || '').split('.')[0]
    return pg.runs.some((r) => r.id !== o.id && Math.abs(r.y - o.y) < 3 && (r.id || '').split('.')[0] === blk)
  }

  // detach ONE text object off its shared line and drop it at the new spot: blank only its own show
  // (by x/baseline anchor — neighbours untouched) and re-insert the same text with its OWN embedded
  // font at x+dx / baseline+dy. Uses the proven replaceText path (no fragile Td surgery).
  const detachMoveText = async (pageIndex, o, dx, dy) => {
    const pg = model.find((p) => p.pageIndex === pageIndex)
    if (!pg) return false
    const cur = pg.fonts?.[o.f] || {}
    const family = cur.name || 'Arial', bold = !!cur.bold, italic = !!cur.italic
    const k = `${family}|${bold ? 'b' : ''}${italic ? 'i' : ''}`
    const fonts = {}
    const src = await fontSourceFor(family, bold, italic) // the run's own font — exact, no reflow
    if (src) fonts[k] = src
    const gaps = Math.max(1, (o.text || '').length - 1)
    await engineRef.current.replaceText(
      pageIndex,
      [{ type: 'text', bbox: o.bbox, x: o.x, y: o.y }], // blank ONLY this run's show
      { lines: [[{ text: o.text, size: o.size, color: pg.colors?.[o.c] || '#000000', fontKey: k, x: o.x + dx, baseline: o.y + dy, ls: undefined, fitW: o.bbox.w }]] },
      fonts,
      await getFallback(),
      true // textOnly: blank the show, don't redact
    )
    return true
  }

  const moveSelected = async (pageIndex, objs, dx, dy) => {
    if (!objs?.length || busyRef.current) return
    // a single text object sitting on a shared line → detach it instead of moving the whole line
    if (objs.length === 1 && objs[0].type === 'text' && sharesLine(pageIndex, objs[0])) {
      busyRef.current = true
      try {
        const o = objs[0]
        await detachMoveText(pageIndex, o, dx, dy)
        const m = await refreshPage(pageIndex)
        // select ONLY the re-inserted piece at its new spot — NOT a signature diff: blanking this
        // run nudges the raster width of its old line-mates, which a diff would wrongly grab too
        const tx = o.x + dx, ty = o.y + dy
        const moved = allOf(m).filter((r) => r.type === 'text' && (r.text || '').trim() === (o.text || '').trim())
          .sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty))[0]
        console.log(`[pdf][move] detached "${o.text}" d=(${dx.toFixed(1)},${dy.toFixed(1)})`)
        onSelect(pageIndex, moved ? [moved] : [])
      } catch (err) { console.error('[pdf] detach-move failed:', err) } finally { busyRef.current = false }
      return
    }
    const items = objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y, dx, dy })) // x/y = exact text anchor
    try {
      await engineRef.current.moveObjects(pageIndex, items)
      await refreshPage(pageIndex)
      // keep the SAME selection, just shifted — no re-computing from the fresh model (which could
      // return inflated/merged boxes when the objects land next to other content). The selection
      // lives until the user clicks something else.
      const shifted = objs.map((o) => shiftObj(o, dx, dy))
      console.log(`[pdf][move] d=(${dx.toFixed(1)},${dy.toFixed(1)}), ${shifted.length} object(s) shifted`)
      onSelect(pageIndex, shifted)
    } catch (err) { console.error('[pdf] move failed:', err) }
  }

  // rotate the whole selection (one or many objects) around a pivot; the worker wraps each unit in
  // a conjugated rotation cm — the objects turn as a group. Re-select via before/after diff.
  const rotateSelected = async (pageIndex, objs, angle, cx, cy) => {
    if (busyRef.current || !objs?.length) return
    busyRef.current = true
    try {
      const pg = model.find((p) => p.pageIndex === pageIndex)
      const before = new Set(allOf(pg).map(sigOf))
      await engineRef.current.rotateObjects(pageIndex, objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })), angle, cx, cy)
      const m = await refreshPage(pageIndex)
      const changed = allOf(m).filter((o) => !before.has(sigOf(o)))
      console.log(`[pdf][rotate] ${objs.length} obj(s) by ${angle.toFixed(1)}° around (${cx.toFixed(0)},${cy.toFixed(0)})`)
      onSelect(pageIndex, changed.length ? changed : [])
    } catch (err) { console.error('[pdf] rotate failed:', err) } finally { busyRef.current = false }
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
  // strip subset/PostScript/style decorations → a plain family the system loader can resolve
  // (weight/slant are requested separately via {bold, italic}); "Arial-BoldMT" → "Arial",
  // "TimesNewRomanPS-BoldMT" → "Times New Roman"
  const baseFamily = (n) => {
    let s = String(n).replace(/^[A-Z]{6}\+/, '') // subset tag ABCDEF+
    s = s.replace(/[-,\s]*(Bold|Italic|Oblique|Black|Heavy|Light|Medium|Semibold|Demi|Regular|Roman)+(MT|PS|PSMT)*$/i, '')
    s = s.replace(/(PSMT|PS|MT)$/i, '') // trailing PostScript markers
    s = s.replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → words (TimesNewRoman → Times New Roman)
    return s.trim() || String(n)
  }
  const fontSourceFor = async (family, bold, italic, forNewText = false) => {
    const df = docFonts.find((f) => f.name === family)
    // own bytes only for TrueType document fonts (Type1/CFF mis-encode through our CID insert),
    // unstyled, and — for NEW text — only full (non-subset) faces
    if (df && df.tt && !bold && !italic && !(forNewText && (df.subset || !df.embedded))) return { pdf: family }
    // resolve to a system-loadable family: the doc font's lookalike, else the decoration-stripped name
    family = df ? (df.match || baseFamily(df.name)) : baseFamily(family)
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
          // CHANGING the font (pipette / dropdown) → use the full loadable face, not the doc's
          // subset: the picked font's subset may not cover THIS run's glyphs (→ "cannot encode").
          // Pure colour/size restyle keeps the run's own subset (it always covers its own text).
          const src = await fontSourceFor(family, bold, italic, !!patch.family)
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

  // ---- variables: persistence (Phase 2) ----
  // restore once, when the model first loads: prefer the DB mirror (by path), fall back to the
  // definitions baked into the PDF catalog (so a file with variables restores even without our DB)
  useEffect(() => {
    if (varsRestoredRef.current || !model.length || !engineRef.current) return
    varsRestoredRef.current = true
    ;(async () => {
      try {
        let json = path ? await api.pdf?.varsGet?.(path) : null
        if (!json) { const r = await engineRef.current.readVariables(); json = r?.json || null }
        const list = json ? JSON.parse(json) : null
        if (Array.isArray(list) && list.length) {
          // find the runs currently sitting at an occurrence's anchors (styles/chainBox may be
          // stale — e.g. saved before chainBox existed — so rebuild from the live model)
          const liveRuns = (occ) => {
            const pg = model.find((p) => p.pageIndex === occ.page)
            if (!pg) return null
            const runs = (occ.parts || [{ x: occ.x, baseline: occ.baseline }])
              .map((p) => pg.runs.find((r) => Math.abs(r.x - p.x) < 1.5 && Math.abs(r.y - p.baseline) < 1.5))
              .filter(Boolean)
            return runs.length ? runs : null
          }
          setVariables(list.map((v) => {
            const occurrences = v.occurrences.map((occ) => {
              const runs = liveRuns(occ)
              if (!runs) return occ
              // refresh only chainBox (positions may lack it if saved before the fix) — KEEP the
              // stored style: reading it from live runs would inherit a previously-corrupted font
              const x0 = Math.min(...runs.map((r) => r.bbox.x)), x1 = Math.max(...runs.map((r) => r.bbox.x + r.bbox.w))
              const y0 = Math.min(...runs.map((r) => r.bbox.y)), y1 = Math.max(...runs.map((r) => r.bbox.y + r.bbox.h))
              return { ...occ, chainBox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
            })
            // the input reflects what's ACTUALLY in the PDF now, not the last-saved value
            const runs0 = liveRuns(v.occurrences[0])
            const value = runs0 ? joinRuns(runs0).replace(/\s+/g, ' ').trim() : v.value
            return { ...v, occurrences, value }
          }))
          console.log(`[pdf][vars] restored ${list.length} variable(s)`)
        }
      } catch (e) { console.warn('[pdf][vars] restore failed:', e?.message) }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])
  // persist on change (debounced): mirror to the DB (by path) AND embed in the in-memory PDF
  // catalog so the next Save bakes them into the file
  useEffect(() => {
    if (!varsRestoredRef.current) return
    clearTimeout(varsSaveRef.current)
    varsSaveRef.current = setTimeout(() => {
      const json = variables.length ? JSON.stringify(variables) : ''
      try { engineRef.current?.writeVariables(json) } catch {}
      if (path) api.pdf?.varsSet?.(path, json, variables.length)
    }, 500)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variables])

  // ---- variables ----
  const vnorm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
  // for matching: strip EVERY space so "2 000,00 €" and "2000,00€" are the same number
  const vmatch = (s) => (s || '').replace(/\s+/g, '').toLowerCase()
  // reconstruct the text of a chain of runs, inserting a space only where there's a real gap
  const joinRuns = (runs) => {
    const s = [...runs].sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))
    let out = ''
    for (let i = 0; i < s.length; i++) {
      if (i > 0) {
        const p = s[i - 1], c = s[i]
        if (Math.abs(c.y - p.y) > 3) out += '\n'
        else if (c.x - (p.x + p.bbox.w) > (c.size || 10) * 0.25) out += ' '
      }
      out += s[i].text || ''
    }
    return out
  }
  // one occurrence = a CHAIN of adjacent runs whose combined text is the value. styles by VALUE (not
  // palette index — those shift); parts[] holds every piece's anchor (all blanked on change), the
  // FIRST piece is where the single new value is inserted → the chain collapses to one clean text.
  const occFromRuns = (page, runs) => {
    const s = [...runs].sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))
    const first = s[0]
    const pg = model.find((p) => p.pageIndex === page)
    const f = pg?.fonts?.[first.f] || {}
    // union box of the whole chain — blanking uses its x-range so EVERY piece's show is caught,
    // even advance-chained ones whose shows all share the same Td px (per-piece anchors miss them)
    const x0 = Math.min(...s.map((r) => r.bbox.x)), x1 = Math.max(...s.map((r) => r.bbox.x + r.bbox.w))
    const y0 = Math.min(...s.map((r) => r.bbox.y)), y1 = Math.max(...s.map((r) => r.bbox.y + r.bbox.h))
    return {
      page, x: first.x, baseline: first.y, bbox: first.bbox,
      chainBox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      family: f.name || 'Arial', bold: !!f.bold, italic: !!f.italic, size: first.size,
      color: pg?.colors?.[first.c] || '#000000', ls: first.ls || 0,
      parts: s.map((r) => ({ x: r.x, baseline: r.y })),
      enabled: true
    }
  }
  const occParts = (o) => o.parts || [{ x: o.x, baseline: o.baseline }]
  // find every chain of adjacent same-line runs whose combined text equals the value (also single
  // runs) — so "2 000 EUR" split across 3 pieces and an unsplit "2000 EUR" both match
  const findChains = (target) => {
    const T = vmatch(target)
    if (!T) return []
    const out = []
    for (const pg of model) {
      const lines = new Map()
      for (const r of pg.runs) { const key = Math.round(r.y / 2); (lines.get(key) || lines.set(key, []).get(key)).push(r) }
      for (const line of lines.values()) {
        line.sort((a, b) => a.x - b.x)
        let i = 0
        while (i < line.length) {
          let acc = '', matched = false
          for (let j = i; j < line.length && j < i + 14; j++) {
            acc += line[j].text || '' // spaces are stripped by vmatch, so gaps don't matter
            const na = vmatch(acc)
            if (na === T) { out.push({ page: pg.pageIndex, runs: line.slice(i, j + 1) }); i = j + 1; matched = true; break }
            if (!T.startsWith(na)) break
          }
          if (!matched) i++
        }
      }
    }
    return out
  }
  // right-click "Create variable": open the popup with the selected chain's text as value/name
  const startCreateVariable = () => {
    if (!selected) return
    const texts = selected.objs.filter((o) => o.type === 'text')
    if (!texts.length) return
    const value = joinRuns(texts).replace(/\s+/g, ' ').trim()
    setVarDraft({ value, name: value, existing: '', page: selected.page, objs: texts })
  }
  // popup buttons: "add this" = the selected chain only; "find identical" = every matching chain
  const finishCreate = (findAll) => {
    const d = varDraft
    if (!d) return
    const occurrences = findAll
      ? findChains(d.value).map((c) => occFromRuns(c.page, c.runs))
      : [occFromRuns(d.page, d.objs)]
    if (!occurrences.length) { setVarDraft(null); return }
    const name = (d.existing || d.name || '').trim() || d.value.trim() || 'var'
    setVariables((vs) => {
      // typed/picked an EXISTING name → merge the new places into that variable (dedup by anchor)
      const existing = vs.find((v) => v.name.toLowerCase() === name.toLowerCase())
      if (existing) {
        const key = (o) => `${o.page}|${Math.round(o.x)}|${Math.round(o.baseline)}`
        const have = new Set(existing.occurrences.map(key))
        const merged = [...existing.occurrences, ...occurrences.filter((o) => !have.has(key(o)))]
        return vs.map((v) => (v === existing ? { ...v, occurrences: merged } : v))
      }
      const id = crypto.randomUUID?.() || 'v' + Math.random().toString(36).slice(2)
      return [...vs, { id, name, value: d.value, occurrences }]
    })
    setVarDraft(null)
    setVarsCollapsed(false)
  }
  // apply a new value to every ENABLED occurrence — blank the whole chain (chainBox x-range catches
  // every piece), insert the value as clean line(s) in the occurrence's own font at the first anchor
  const applyVariable = async (occurrences, value) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const byPage = {}
      for (const o of occurrences) { if (o.enabled === false) continue; (byPage[o.page] = byPage[o.page] || []).push(o) }
      for (const pageIndex of Object.keys(byPage).map(Number)) {
        const occs = byPage[pageIndex]
        const fonts = {}
        const items = []
        const specLines = []
        for (const o of occs) {
          items.push({ type: 'text', bbox: o.chainBox || o.bbox, x: o.x, y: o.baseline })
          const k = `${o.family}|${o.bold ? 'b' : ''}${o.italic ? 'i' : ''}`
          // reuse the run's OWN embedded font (exact, keeps weight) — fall back only if it can't
          // encode; forcing the full system face here made everything render bold
          if (!fonts[k]) { const src = await fontSourceFor(o.family, o.bold, o.italic); if (src) fonts[k] = src }
          const lh = (o.size || 10) * 1.25
          String(value).split('\n').forEach((line, li) => {
            if (line === '') return
            specLines.push([{ text: line, size: o.size, color: o.color, fontKey: k, x: o.x, baseline: o.baseline + li * lh, ls: o.ls || 0 }])
          })
        }
        await engineRef.current.replaceText(pageIndex, items, { lines: specLines }, fonts, await getFallback(), true) // textOnly: don't redact already-blanked pieces
        await refreshPage(pageIndex)
      }
    } catch (e) { console.error('[pdf][variable] apply failed:', e) } finally { busyRef.current = false }
  }
  const changeVarValue = (id, val) => {
    setVariables((vs) => vs.map((v) => (v.id === id ? { ...v, value: val } : v)))
    const v = variablesRef.current.find((x) => x.id === id)
    if (v) deferMutation(() => applyVariable(v.occurrences, val))
  }
  const toggleOcc = (id, i) =>
    setVariables((vs) => vs.map((v) => (v.id !== id ? v : { ...v, occurrences: v.occurrences.map((o, k) => (k === i ? { ...o, enabled: o.enabled === false } : o)) })))
  const removeVariable = (id) => { setVariables((vs) => vs.filter((v) => v.id !== id)); setExpandedVars((s) => { const n = new Set(s); n.delete(id); return n }) }
  // does an occurrence (any piece of its chain) sit at a selected text object's anchor?
  const occMatches = (o, page, objs) => o.page === page && occParts(o).some((p) => objs.some((t) => t.type === 'text' && Math.abs(t.x - p.x) < 1.5 && Math.abs(t.y - p.baseline) < 1.5))
  // right-click "Remove from variable": drop the selected place(s) from every variable holding them
  // (a variable left with no places is removed entirely — so the last one takes the variable with it)
  const removeSelectionFromVars = () => {
    if (!selected) return
    const { page, objs } = selected
    setVariables((vs) => vs
      .map((v) => ({ ...v, occurrences: v.occurrences.filter((o) => !occMatches(o, page, objs)) }))
      .filter((v) => v.occurrences.length))
  }
  // click an occurrence → select every run currently at its chain's anchors (text may have changed)
  const highlightOcc = (o) => {
    const pg = model.find((p) => p.pageIndex === o.page)
    if (!pg) return
    const runs = []
    for (const p of occParts(o)) {
      const r = pg.runs.find((rr) => Math.abs(rr.x - p.x) < 1.5 && Math.abs(rr.y - p.baseline) < 1.5)
      if (r) runs.push(r)
    }
    if (runs.length) onSelect(o.page, runs)
  }
  const startVarsResize = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = varsWidthRef.current
    const onMove = (ev) => setVarsWidth(Math.min(Math.max(startW - (ev.clientX - startX), 180), 520)) // grows leftward
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); localStorage.setItem('pdfedVarsW', String(varsWidthRef.current)) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const toggleVarsCollapsed = () => setVarsCollapsed((c) => { localStorage.setItem('pdfedVarsCol', c ? '0' : '1'); return !c })

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
    const ls = o.ls || 0 // letter spacing (Tc) of the picked object — must travel with the style
    setFontSel(f.name); setFontSize(o.size); setColorSel(color); setBoldSel(!!f.bold); setItalicSel(!!f.italic); setLetterS(ls)
    console.log('[pdf][pipette]', f.name, o.size, color, f.bold ? 'bold' : '', f.italic ? 'italic' : '', 'ls=' + ls)
    if (textEdit) {
      rteRef.current?.exec('applyStyle', { family: cssFontFor(f.name), sizePx: o.size, color, bold: !!f.bold, italic: !!f.italic })
    } else if (selected) {
      restyleSelected({ family: f.name, size: o.size, color, bold: !!f.bold, italic: !!f.italic, ls })
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

  // align 2+ selected objects: everything to the leftmost edge / the topmost edge
  const alignSelected = async (edge) => {
    if (!selected || selected.objs.length < 2 || busyRef.current) return
    busyRef.current = true
    try {
      const objs = selected.objs
      const minX = Math.min(...objs.map((o) => o.bbox.x))
      const minY = Math.min(...objs.map((o) => o.bbox.y))
      // align-left works PER LINE: every piece of a line shifts by the SAME delta (that of the
      // line's leftmost piece) so advance-chained continuations ("Horokho"+"v") follow their leader
      // instead of each being dragged to minX independently
      const lineOf = new Map()
      let li = 0, prevY = null
      for (const o of [...objs].sort((a, b) => a.bbox.y - b.bbox.y)) {
        if (prevY !== null && o.bbox.y - prevY > 6) li++
        lineOf.set(o, li); prevY = o.bbox.y
      }
      const lineLeft = new Map()
      for (const o of objs) { const k = lineOf.get(o); lineLeft.set(k, Math.min(lineLeft.has(k) ? lineLeft.get(k) : Infinity, o.bbox.x)) }
      const dOf = (o) => ({ dx: edge === 'left' ? minX - lineLeft.get(lineOf.get(o)) : 0, dy: edge === 'top' ? minY - o.bbox.y : 0 })
      const items = objs
        .map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y, ...dOf(o) }))
        .filter((it) => Math.abs(it.dx) > 0.01 || Math.abs(it.dy) > 0.01)
      if (items.length) {
        await engineRef.current.moveObjects(selected.page, items)
        await refreshPage(selected.page)
        const shifted = objs.map((o) => { const { dx, dy } = dOf(o); return shiftObj(o, dx, dy) })
        onSelect(selected.page, shifted)
      }
    } catch (err) { console.error('[pdf] align failed:', err) } finally { busyRef.current = false }
  }

  // distribute the selected objects into rows at an EQUAL vertical step — the step is the gap
  // between the first two (by current top): row i lands at firstTop + i * step (x untouched)
  const distributeRows = async () => {
    if (!selected || selected.objs.length < 3 || busyRef.current) return
    busyRef.current = true
    try {
      const objs = [...selected.objs].sort((a, b) => a.bbox.y - b.bbox.y)
      const step = objs[1].bbox.y - objs[0].bbox.y // the gap between the first and second
      const targetY = (i) => objs[0].bbox.y + i * step
      const dyOf = new Map(objs.map((o, i) => [o, targetY(i) - o.bbox.y]))
      const items = objs
        .map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y, dx: 0, dy: dyOf.get(o) }))
        .filter((it) => Math.abs(it.dy) > 0.01)
      if (items.length) {
        await engineRef.current.moveObjects(selected.page, items)
        await refreshPage(selected.page)
        const shifted = selected.objs.map((o) => shiftObj(o, 0, dyOf.get(o) || 0))
        onSelect(selected.page, shifted)
      }
    } catch (err) { console.error('[pdf] distribute failed:', err) } finally { busyRef.current = false }
  }

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

  // resize of a ROTATED object: the worker scales along the object's own axes around the fixed
  // anchor corner; re-select via before/after diff (the quad box changes shape)
  const resizeRotSelected = async (pageIndex, obj, spec) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const pg = model.find((p) => p.pageIndex === pageIndex)
      const before = new Set(allOf(pg).map(sigOf))
      await engineRef.current.resizeObject(pageIndex, { type: obj.type, bbox: obj.bbox }, null, spec)
      const m = await refreshPage(pageIndex)
      const changed = allOf(m).filter((o) => !before.has(sigOf(o)))
      onSelect(pageIndex, changed.length ? changed : [])
    } catch (err) { console.error('[pdf] rotated resize failed:', err) } finally { busyRef.current = false }
  }

  // ---- insert text: rich-editor content → styled runs → written into the PDF stream ----
  const startTextEdit = (pageIndex, x, y) => {
    setInsertMode(false)
    onSelect(pageIndex, null)
    setTextEdit({ page: pageIndex, x, y })
  }

  // ---- EDIT existing text: double-click opens the SAME rich editor pre-filled with the block's
  // text in its original fonts/sizes/colours; commit atomically replaces the stream text (the
  // originals are blanked by their own anchors — Escape cancels without touching anything) ----
  const startEditSelected = (pageIndex, objs) => {
    if (busyRef.current || textEdit) return
    const texts = (objs || []).filter((o) => o.type === 'text' && !o.rot) // rotated text editing: later
    if (!texts.length) return
    const pg = model.find((p) => p.pageIndex === pageIndex)
    if (!pg) return
    const sorted = [...texts].sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))
    const master = sorted[0]
    const mf = pg.fonts?.[master.f] || {}
    // the toolbar mirrors the edited block's master style
    setFontSel(mf.name || 'Arial'); setFontSize(master.size || 12); setColorSel(pg.colors?.[master.c] || '#000000')
    setBoldSel(!!mf.bold); setItalicSel(!!mf.italic)
    // visual lines by baseline; line-height from the first two
    const lines = []
    for (const o of sorted) { const last = lines[lines.length - 1]; if (last && Math.abs(last[0].y - o.y) < 3) last.push(o); else lines.push([o]) }
    if (lines.length > 1) setLineH(+(((lines[1][0].y - lines[0][0].y) / (master.size || 10))).toFixed(2))
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const html = lines.map((l) => '<p>' + l.map((o, i) => {
      const f = pg.fonts?.[o.f] || {}
      const color = pg.colors?.[o.c] || '#000000'
      let t = esc(o.text || '')
      // keep a visible gap between separate pieces of one visual line
      if (i > 0) { const prev = l[i - 1]; if (o.bbox.x - (prev.bbox.x + prev.bbox.w) > (o.size || 10) * 0.2) t = ' ' + t }
      if (f.bold) t = `<strong>${t}</strong>`
      if (f.italic) t = `<em>${t}</em>`
      return `<span style="font-family: ${cssFontFor(f.name || 'Arial')}; font-size: ${(o.size || 12) * scale}px; color: ${color}">${t}</span>`
    }).join('') + '</p>').join('')
    const minX = Math.min(...sorted.map((o) => o.bbox.x))
    onSelect(pageIndex, null)
    setInsertMode(false)
    setTextEdit({
      page: pageIndex, x: minX, y: master.y - 0.8 * (master.size || 12), // rough spot; the editor self-aligns to the baseline
      initialHTML: html, anchorLeft: minX, anchorBaseline: master.y,
      replaceItems: texts.map((o) => ({ type: 'text', bbox: o.bbox, x: o.x, y: o.y }))
    })
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
      // lines and arrows are FREE-ANGLE: drawn exactly from the press point to the release point
      // (the old axis snap forced every line to 0° or 90°)
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
        // INSERT: brand-new text → full system faces only (a subset can't be trusted for arbitrary
        // chars). EDIT: keep the DOCUMENT'S OWN font (NimbusSans stays NimbusSans — same glyphs,
        // same heights); the worker still validates encodability and falls back per-run if a newly
        // typed character isn't in the subset.
        const src = await fontSourceFor(s.fontName, s.bold, s.italic, !te.replaceItems)
        if (src) fonts[k] = src
        else console.warn('[pdf][insert-text] NO FONT for', k)
      }
      console.log('[pdf][insert-text] fonts:', Object.keys(fonts).map((k) => `${k}${fonts[k].pdf ? ' (pdf)' : ' (file)'}`).join(', ') || 'NONE')
      // every run carries its EXACT page coordinates measured from the editor's real DOM rects
      const spec = { lines: lines.map((l) => l.map((s) => ({ text: s.text, size: s.size, color: s.color, fontKey: keyOf(s), x: s.x, baseline: s.baseline, ls: s.ls }))) }
      const before = new Set(allOf(model.find((p) => p.pageIndex === te.page) || { runs: [] }).map(sigOf))
      // EDIT mode: atomically blank the original runs (their own anchors) and insert the edited text
      if (te.replaceItems) await engineRef.current.replaceText(te.page, te.replaceItems, spec, fonts, await getFallback(), true)
      else await engineRef.current.insertText(te.page, spec, fonts, await getFallback())
      setTextEdit(null) // close ONLY after a successful insert — a font failure keeps the editor (and the text) alive
      const m = await refreshPage(te.page)
      const added = allOf(m).filter((o) => !before.has(sigOf(o)))
      // the insertion is ONE text block now — select it WHOLE (every bN.lK line), same as a
      // block-mode click would
      const blocks = new Set(added.filter((o) => o.type === 'text').map((o) => String(o.id).split('.')[0]))
      const grouped = allOf(m).filter((o) => (o.type === 'text' && blocks.has(String(o.id).split('.')[0])) || added.includes(o))
      console.log(`[pdf][insert-text] page ${te.page}, ${lines.length} line(s) → ${added.length} new, ${grouped.length} in block(s)`)
      onSelect(te.page, grouped.length ? grouped : added) // the inserted block comes out selected whole
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

  // copy the TEXT of every selected text object to the OS clipboard (reading order: top-to-bottom,
  // then left-to-right; a new line when the baseline drops, a space within a line)
  const copyTextSelected = () => {
    if (!selected) return
    const texts = selected.objs.filter((o) => o.type === 'text')
    if (!texts.length) return
    const sorted = [...texts].sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))
    let out = ''
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0) out += Math.abs(sorted[i].y - sorted[i - 1].y) > 3 ? '\n' : ' '
      out += sorted[i].text || ''
    }
    api.writeClipboard?.(out) // native Electron clipboard (navigator.clipboard is blocked in Electron)
  }

  // double-click on the selection → physically remove the selected objects from the PDF stream.
  // (The file on disk is untouched; reopening the tab restores everything.)
  const deleteSelected = async () => {
    if (!selected) return
    const items = selected.objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })) // anchors → surgical text delete
    if (!items.length) return
    const page = selected.page
    const deletedTexts = selected.objs.filter((o) => o.type === 'text').map((o) => ({ x: o.x, y: o.y }))
    onSelect(selected.page, null) // selection (and any pending nudge) is gone with the objects
    try {
      await engineRef.current.deleteObjects(page, items)
      await refreshPage(page)
      // a deleted text object drops out of every variable that referenced it (empty variables go too)
      if (deletedTexts.length) {
        setVariables((vs) => vs
          .map((v) => ({
            ...v,
            occurrences: v.occurrences.filter((o) => !(o.page === page && occParts(o).some((p) => deletedTexts.some((d) => Math.abs(d.x - p.x) < 1.5 && Math.abs(d.y - p.baseline) < 1.5))))
          }))
          .filter((v) => v.occurrences.length))
      }
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
  // is the current selection already part of some variable? (drives the "Remove from variable" item)
  const selInVar = !!selected && variables.some((v) => v.occurrences.some((o) => occMatches(o, selected.page, selected.objs)))
  // read-only geometry readout at the end of the panel; live during drag/resize/endpoint-drag.
  // Whole numbers — the readout is orientation, not a measuring tool.
  const r1 = (n) => Math.round(n)
  const geoText = () => {
    if (liveGeo?.line) {
      const L = liveGeo.line
      return `X ${r1(Math.min(L.x1, L.x2))} · Y ${r1(Math.min(L.y1, L.y2))} · L ${r1(Math.hypot(L.x2 - L.x1, L.y2 - L.y1))}`
    }
    if (liveGeo) return `X ${r1(liveGeo.x)} · Y ${r1(liveGeo.y)} · W ${r1(liveGeo.w)} · H ${r1(liveGeo.h)}`
    if (!selected?.objs.length) return ''
    const ndx = nudge?.page === selected.page ? nudge.dx : 0
    const ndy = nudge?.page === selected.page ? nudge.dy : 0
    if (selObj1?.line) {
      const L = selObj1.line
      return `X ${r1(Math.min(L.x1, L.x2) + ndx)} · Y ${r1(Math.min(L.y1, L.y2) + ndy)} · L ${r1(Math.hypot(L.x2 - L.x1, L.y2 - L.y1))}`
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const o of selected.objs) { x0 = Math.min(x0, o.bbox.x); y0 = Math.min(y0, o.bbox.y); x1 = Math.max(x1, o.bbox.x + o.bbox.w); y1 = Math.max(y1, o.bbox.y + o.bbox.h) }
    // a single rotated object: show its screen angle (∠, clockwise-positive) and its OWN w×h
    const rot = selected.objs.length === 1 ? selected.objs[0].rot || 0 : 0
    if (rot) {
      const o = selected.objs[0]
      const w = o.obw > 0 ? o.obw : x1 - x0, h = o.obh > 0 ? o.obh : y1 - y0
      return `X ${r1((o.ox ?? x0) + ndx)} · Y ${r1((o.oy ?? y0) + ndy)} · W ${r1(w)} · H ${r1(h)} · ∠ ${(-rot).toFixed(1)}°`
    }
    return `X ${r1(x0 + ndx)} · Y ${r1(y0 + ndy)} · W ${r1(x1 - x0)} · H ${r1(y1 - y0)}`
  }

  return (
    <div className="pdfed">
      <div className="pdfed__toolbar">
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.max(0.3, s / 1.15))} title="Zoom out"><ZoomOutIcon /></button>
        <span className="pdfed__zoom">{Math.round(scale * 100)}%</span>
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.min(10, s * 1.15))} title="Zoom in"><ZoomInIcon /></button>
        <span className="pdfed__sep" />
        {/* selection mode: exactly one of the two is always on */}
        <button className={'pdfed__btn' + (selMode === 'single' ? ' is-active' : '')} onClick={() => setSelMode('single')} title="Select single elements (lines)"><CursorOneIcon /></button>
        <button className={'pdfed__btn' + (selMode === 'block' ? ' is-active' : '')} onClick={() => setSelMode('block')} title="Select whole text blocks"><CursorBlockIcon /></button>
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
        <button className="pdfed__btn" onClick={() => setShowInfo(true)} title={t('pdfed.info')}><InfoIcon /></button>
        <span className="pdfed__spacer" />
        <label className="pdfed__check" title="Outline every element on the page (faint grey), so you can see where everything is">
          <input type="checkbox" checked={showAll} onChange={(e) => { setShowAll(e.target.checked); localStorage.setItem('pdfedShowAll', e.target.checked ? '1' : '0') }} />
          All
        </label>
        <span className="pdfed__status">{status === 'loading' ? '…' : `${pageCount} p.`}</span>
      </div>

      {/* second row — contextual: text style controls, shape parameters, or the object's panel */}
      <div className="pdfed__stylebar">
        {!insertMode?.shape && selected?.objs.length > 1 && (
          /* 2+ objects → align tools: everything to the leftmost / the topmost of the selection */
          <>
            <button className="pdfed__btn" onClick={() => alignSelected('left')} title="Align left edges (to the leftmost object)"><AlignLeftIcon /></button>
            <button className="pdfed__btn" onClick={() => alignSelected('top')} title="Align top edges (to the topmost object)"><AlignTopIcon /></button>
            <button className="pdfed__btn" disabled={(selected?.objs.length || 0) < 3} onClick={distributeRows} title="Distribute into rows at equal spacing (the gap between the first two)"><DistributeRowsIcon /></button>
            <span className="pdfed__sep" />
          </>
        )}
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
        <label className="pdfed__mini" title="Letter spacing: − / + nudge the selected text's spacing from its CURRENT value (there is no single stored value in PDF — this adjusts relative to what's there)">
          LS
          <span className="pdfed__ls">
            <button className="pdfed__lsbtn" disabled={styleLocked && !selected?.objs.some((o) => o.type === 'text')} onMouseDown={(e) => e.preventDefault()} onClick={() => pickLS(+(letterS - 0.1).toFixed(2))} title="Tighter (−0.1)">−</button>
            <span className="pdfed__lsval">{letterS ? (letterS > 0 ? '+' : '') + +letterS.toFixed(2) : '0'}</span>
            <button className="pdfed__lsbtn" disabled={styleLocked && !selected?.objs.some((o) => o.type === 'text')} onMouseDown={(e) => e.preventDefault()} onClick={() => pickLS(+(letterS + 0.1).toFixed(2))} title="Wider (+0.1)">+</button>
          </span>
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
        {selected?.objs.length > 0 && (
          <>
            <span className="pdfed__spacer" />
            <span className="pdfed__sbinfo">{geoText()}</span>
          </>
        )}
          </>
        )}
        {!insertMode?.shape && (selKind === 'image' || selKind === 'vector') && selObj1 && (
          /* object panel — position is editable now; resize, fill/stroke colours and corner
             radius land here next */
          <>
            <span className="pdfed__sblabel">{selKind === 'image' ? 'Image' : 'Vector'}</span>
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
                    onPick={(c) => recolorSelected(selObj1.line?.head === 'filled' ? { stroke: c, fill: c } : { stroke: c })}
                    title="Stroke colour (incl. Transparent)"
                  />
                </label>
                {!selObj1.line && ( /* fill makes no sense for a line/arrow (a filled head follows Stroke) */
                  <label className="pdfed__mini" title="Fill colour">
                    Fill
                    <ColorDrop
                      value={selObj1.kind === 'fill' ? selPg?.colors?.[selObj1.c] || '#000000' : selObj1.fc !== undefined ? selPg?.colors?.[selObj1.fc] || '#ffffff' : '#ffffff'}
                      colors={docColors}
                      onPick={(c) => recolorSelected({ fill: c })}
                      title="Fill colour (incl. Transparent)"
                    />
                  </label>
                )}
                <label className="pdfed__mini" title="Stroke width, pt — any vector">
                  W
                  <ComboNum value={selObj1.strokeW ?? 1} onPick={(v) => deferMutation(() => strokeWidthSelected(Math.max(0.2, v || 1)))} opts={[0.5, 1, 1.5, 2, 3, 4, 6]} step={0.5} min={0.2} max={40} width={60} />
                </label>
                {!selObj1.line && ( /* corner radius makes no sense for a line/arrow */
                  <label className="pdfed__mini" title="Corner radius, pt — rebuilds the path as a rounded rectangle over the same bounds">
                    R
                    <ComboNum value={selObj1.radius ?? 0} onPick={(v) => deferMutation(() => radiusSelected(Math.max(0, v || 0)))} opts={[0, 2, 4, 6, 8, 12, 16, 24]} step={1} min={0} max={200} width={60} />
                  </label>
                )}
                <select className="pdfed__fontsel pdfed__dashsel" value={selObj1.dash || 'solid'} onChange={(e) => dashSelected(e.target.value)} title="Line type">
                  <option value="solid">— Solid</option>
                  <option value="dashed">– – Dashed</option>
                  <option value="dotted">· · Dotted</option>
                  <option value="dashdot">–·– Dash-dot</option>
                </select>
              </>
            )}
            {/* read-only geometry at the very end — the frame/handles are the editing tools */}
            <span className="pdfed__spacer" />
            <span className="pdfed__sbinfo">{geoText()}</span>
          </>
        )}
        {!insertMode?.shape && selKind === 'mixed' && <span className="pdfed__sbinfo">{selected.objs.length} objects selected</span>}
        {!insertMode?.shape && selKind === 'none' && <span className="pdfed__sbinfo">Select an element on the page — its properties appear here</span>}
      </div>

      {showInfo && (
        <div className="pdfed__infowrap" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowInfo(false) }}>
          <div className="pdfed__infobox">
            <div className="pdfed__infohead">
              <b>{t('pdfed.helpTitle')}</b>
              <button className="pdfed__btn" onClick={() => setShowInfo(false)} title="Close">✕</button>
            </div>
            <div className="pdfed__infobody">
              {t('pdfed.help').split('\n').map((line, i) => {
                const dash = line.indexOf('—')
                return (
                  <p key={i}>
                    {dash > 0 ? <><b>{line.slice(0, dash)}</b>{line.slice(dash)}</> : line}
                  </p>
                )
              })}
            </div>
          </div>
        </div>
      )}

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
                selMode={selMode}
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
                onRotate={rotateSelected}
                onResize={resizeSelected}
                onResizeRot={resizeRotSelected}
                onLineGeo={lineGeoSelected}
                onLiveGeo={setLiveGeo}
                onSprite={spriteFor}
                onMenu={setMenu}
                onInsertAt={startInsertAt}
                onEditText={startEditSelected}
                onPipettePick={pipettePick}
                onTextCommit={commitText}
                onTextCancel={() => setTextEdit(null)}
              />
            ))}
          </div>
        </div>

        {/* right panel: the document's variables (template fields) — collapsible + resizable */}
        {varsCollapsed ? (
          <button className="pdfed__vars-open" title="Variables" onClick={toggleVarsCollapsed}>
            <ChevronLeftIcon />
          </button>
        ) : (
          <aside className="pdfed__vars" style={{ width: varsWidth }}>
            <div className="pdfed__vars-resize" onMouseDown={startVarsResize} title="Drag to resize" />
            <div className="pdfed__vars-head">
              <b><VariableIcon /> Variables</b>
              <button className="pdfed__collapse" title="Collapse" onClick={toggleVarsCollapsed}><ChevronRightIcon /></button>
            </div>
            <div className="pdfed__vars-body">
              {variables.length === 0 ? (
                <div className="pdfed__vars-empty">Select text on the page, right-click → <b>Create variable</b>. Editing a variable's value updates every linked place in the document.</div>
              ) : (
                variables.map((v) => {
                  const open = expandedVars.has(v.id)
                  return (
                    <div key={v.id} className="pdfed__var">
                      <div className="pdfed__var-row">
                        <button className="pdfed__var-toggle" onClick={() => toggleVarExpand(v.id)} title={open ? 'Hide places' : 'Show places'}>
                          <span className="pdfed__var-exp">{open ? '▾' : '▸'}</span>
                          <span className="pdfed__var-name" title={v.name}>{v.name}</span>
                        </button>
                        <span className="pdfed__var-count" title="linked places">{v.occurrences.filter((o) => o.enabled !== false).length}</span>
                        <button className="pdfed__btn pdfed__var-del" title="Remove variable" onClick={() => removeVariable(v.id)}>✕</button>
                      </div>
                      <input className="pdfed__var-value" value={v.value} onChange={(e) => changeVarValue(v.id, e.target.value)} placeholder="value…" />
                      {open && (
                        <div className="pdfed__var-occs">
                          {v.occurrences.map((o, i) => (
                            <label key={i} className="pdfed__occ">
                              <input type="checkbox" checked={o.enabled !== false} onChange={() => toggleOcc(v.id, i)} />
                              <button className="pdfed__occ-go" onClick={() => highlightOcc(o)} title="Show on page">p.{o.page + 1} · {Math.round(o.x)},{Math.round(o.baseline)}</button>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </aside>
        )}
      </div>

      {varDraft && (
        <div className="pdfed__infowrap" onMouseDown={(e) => { if (e.target === e.currentTarget) setVarDraft(null) }}>
          <div className="pdfed__varpop">
            <div className="pdfed__infohead"><b>Create variable</b><button className="pdfed__btn" onClick={() => setVarDraft(null)}>✕</button></div>
            {variables.length > 0 && (
              <label className="pdfed__varpop-lbl">Add to an existing variable
                <select className="pdfed__var-value" value={varDraft.existing || ''} onChange={(e) => setVarDraft({ ...varDraft, existing: e.target.value })}>
                  <option value="">— new variable —</option>
                  {variables.map((v) => <option key={v.id} value={v.name}>{v.name} ({v.occurrences.length})</option>)}
                </select>
              </label>
            )}
            <label className="pdfed__varpop-lbl">Name (for a new variable)
              <input className="pdfed__var-value" autoFocus disabled={!!varDraft.existing}
                value={varDraft.existing || varDraft.name}
                onChange={(e) => setVarDraft({ ...varDraft, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') finishCreate(false); if (e.key === 'Escape') setVarDraft(null) }} />
            </label>
            <div className="pdfed__varpop-btns">
              <button className="pdfed__btn pdfed__btn--txt" onClick={() => finishCreate(false)}>Add this</button>
              <button className="pdfed__btn pdfed__btn--txt pdfed__btn--save" onClick={() => finishCreate(true)}>Find identical &amp; add</button>
            </div>
          </div>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.sx}
          y={menu.sy}
          items={
            menu.kind === 'sel'
              ? [
                  { label: <span className="pdfed__mi"><CopyIcon /> Copy</span>, onClick: copySelected },
                  ...(selected?.objs.some((o) => o.type === 'text') ? [{ label: <span className="pdfed__mi"><CopyIcon /> Copy text</span>, onClick: copyTextSelected }] : []),
                  ...(selected?.objs.some((o) => o.type === 'text') ? [{ label: <span className="pdfed__mi"><VariableIcon /> Create variable</span>, onClick: startCreateVariable }] : []),
                  ...(selInVar ? [{ label: <span className="pdfed__mi"><VariableIcon /> Remove from variable</span>, onClick: removeSelectionFromVars }] : []),
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
