import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ZoomInIcon, ZoomOutIcon, ComposeIcon } from '../icons'
import { useI18n } from '../../i18n/I18nContext'
import api from '../../lib/api'
import { createPdfEngine } from './pdfEngine'
import StylePanel from './StylePanel'
import './PdfEditor.css'

// Draws frames for every page object MuPDF reports. Layered bottom→top: vectors (shapes/rules),
// images, text blocks (paragraph groups — context only), then each *run* (a span of one style)
// dashed and clickable. Clicking a run selects exactly that small piece, so the panel shows its
// real parameters, not an average of the whole block.
function PageOverlay({ model, scale, pageIndex, selected, onSelect, showBoxes }) {
  const box = (r) => ({ left: r.x * scale, top: r.y * scale, width: r.width * scale, height: r.height * scale })
  return (
    <>
      {showBoxes && model.vectors.map((v, i) => (
        <div key={'v' + i} className="pdfed__ov pdfed__ov--vec" style={box(v)} />
      ))}
      {showBoxes && model.images.map((m, i) => (
        <div key={'i' + i} className="pdfed__ov pdfed__ov--img" style={box(m)} />
      ))}
      {/* block frames = future Rich-Editor objects (resizable/movable container of the rich text) */}
      {showBoxes &&
        model.blocks.map((b, i) => (
          <div key={'b' + i} className="pdfed__ov pdfed__ov--block" style={box(b)} />
        ))}
      {/* runs stay clickable even with boxes hidden (is-bare just drops the visible outline) */}
      {model.blocks.flatMap((b, bi) =>
        b.lines.flatMap((ln, li) =>
          ln.runs.map((run, ri) => {
            const sel =
              selected?.page === pageIndex && selected?.b === bi && selected?.l === li && selected?.r === ri
            return (
              <div
                key={`r${bi}-${li}-${ri}`}
                className={'pdfed__ov pdfed__ov--run' + (sel ? ' is-selected' : '') + (showBoxes ? '' : ' is-bare')}
                style={box(run.bbox)}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect({ page: pageIndex, b: bi, l: li, r: ri })
                }}
              />
            )
          })
        )
      )}
    </>
  )
}

// PDF viewer — open a document and render its pages. Editing features get rebuilt on top of this
// one at a time. Ctrl+wheel zooms; pages re-render crisply at the new scale.
export default function PdfEditor({ source }) {
  const { t } = useI18n()
  const [pages, setPages] = useState([])
  const [pageCount, setPageCount] = useState(0)
  const [scale, setScale] = useState(1.5)
  const [status, setStatus] = useState('idle')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const [editing, setEditing] = useState(false)
  const [model, setModel] = useState({}) // pageIndex → { blocks, images, vectors, fonts, colors } (PDF points)
  const [selected, setSelected] = useState(null) // { page, block } — clicked block
  const [tagged, setTagged] = useState(null) // does the file store logical structure (tagged PDF)?
  const [fontList, setFontList] = useState([]) // installed + bundled families, for the font dropdown
  const [showBoxes, setShowBoxes] = useState(true) // toggle the overlay frames' visibility
  const engineRef = useRef(null)
  const urlsRef = useRef([])
  const viewportRef = useRef(null)
  const panRef = useRef(null)
  const zoomAnchorRef = useRef(null) // keeps the point under the cursor fixed across a zoom step

  const revoke = () => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u)
    urlsRef.current = []
  }

  // one engine (worker) per mounted tab
  useEffect(() => {
    engineRef.current = createPdfEngine()
    return () => {
      engineRef.current?.dispose()
      revoke()
    }
  }, [])

  // installed/bundled font families for the FORMAT font dropdown (once)
  useEffect(() => {
    Promise.resolve(api.fonts?.list?.())
      .then((l) => setFontList(Array.isArray(l) ? l : []))
      .catch(() => {})
  }, [])

  // open the document when bytes arrive
  useEffect(() => {
    if (source === undefined || !engineRef.current) return
    let alive = true
    setStatus('loading')
    console.log('[pdf] open: bytes =', source?.byteLength ?? source?.length ?? '?')
    Promise.resolve(engineRef.current.open(source))
      .then((info) => {
        console.log('[pdf] opened: pageCount =', info?.pageCount, 'tagged =', info?.tagged)
        if (alive) {
          setPageCount(info?.pageCount || 0)
          setTagged(info?.tagged ?? null)
        }
      })
      .catch((err) => {
        console.error('[pdf] open failed:', err)
        if (alive) setStatus('error')
      })
    return () => {
      alive = false
    }
  }, [source])

  // render all pages whenever the doc opens or the zoom changes
  useEffect(() => {
    if (!pageCount || !engineRef.current) return
    let alive = true
    setStatus('loading')
    ;(async () => {
      const out = []
      for (let i = 0; i < pageCount; i++) {
        const r = await engineRef.current.renderPage(i, scale)
        if (!alive) return
        const url = URL.createObjectURL(new Blob([r.png], { type: 'image/png' }))
        out.push({ pageIndex: i, width: r.width, height: r.height, url })
      }
      if (!alive) {
        for (const p of out) URL.revokeObjectURL(p.url)
        return
      }
      revoke()
      urlsRef.current = out.map((p) => p.url)
      setPages(out)
      setStatus('ready')
    })().catch(() => alive && setStatus('error'))
    return () => {
      alive = false
    }
  }, [pageCount, scale])

  // On entering edit mode, ask MuPDF for every page's rich-text model (blocks→lines→runs, images,
  // vectors, palette). Cleared on exit. Coords are PDF points, scaled at render time.
  useEffect(() => {
    if (!editing || !pageCount || !engineRef.current) {
      setModel({})
      setSelected(null)
      return
    }
    let alive = true
    ;(async () => {
      const out = {}
      for (let i = 0; i < pageCount; i++) {
        const r = await engineRef.current.getModel(i)
        if (!alive) return
        out[i] = r
      }
      if (alive) setModel(out)
    })().catch((err) => console.error('[pdf] getModel failed:', err))
    return () => {
      alive = false
    }
  }, [editing, pageCount])

  // Ctrl + wheel zoom (non-passive so we cancel the browser/page zoom). Anchors the zoom on the
  // point under the cursor: we record that content point now, then restore it after the re-layout.
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
        if (ns !== s) {
          zoomAnchorRef.current = { contentX: (el.scrollLeft + cx) / s, contentY: (el.scrollTop + cy) / s, cx, cy }
        }
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
    const down = (e) => {
      if (e.code !== 'Space' || isField(e.target)) return
      e.preventDefault()
      setSpaceHeld(true)
    }
    const up = (e) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
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
    const upp = () => {
      panRef.current = null
      setPanning(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', upp)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', upp)
  }

  const statusText =
    status === 'loading'
      ? t('pdfed.loading')
      : status === 'error'
        ? t('pdfed.error')
        : pageCount
          ? `${pageCount} ${t('pdfed.pages')}` + (editing && tagged !== null ? (tagged ? ' · tagged' : ' · untagged') : '')
          : ''

  return (
    <div className="pdfed">
      <div className="pdfed__toolbar">
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.max(0.3, s / 1.15))} title={t('pdfed.zoomOut')}>
          <ZoomOutIcon />
        </button>
        <span className="pdfed__zoom">{Math.round(scale * 100)}%</span>
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.min(10, s * 1.15))} title={t('pdfed.zoomIn')}>
          <ZoomInIcon />
        </button>
        <span className="pdfed__sep" />
        <button
          className={'pdfed__btn' + (editing ? ' is-active' : '')}
          onClick={() => setEditing((v) => !v)}
          title={t('pdfed.editText')}
        >
          <ComposeIcon />
        </button>
        <span className="pdfed__spacer" />
        <span className="pdfed__status">{statusText}</span>
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
              <div key={p.pageIndex} className="pdfed__page" style={{ width: p.width * scale, height: p.height * scale }}>
                <img
                  src={p.url}
                  width={p.width * scale}
                  height={p.height * scale}
                  className="pdfed__pageimg"
                  alt={`${t('pdfed.page')} ${p.pageIndex + 1}`}
                  draggable={false}
                />
                {editing && model[p.pageIndex] && (
                  <PageOverlay
                    model={model[p.pageIndex]}
                    scale={scale}
                    pageIndex={p.pageIndex}
                    selected={selected}
                    onSelect={setSelected}
                    showBoxes={showBoxes}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {editing && (
          <StylePanel
            page={selected ? model[selected.page] : null}
            block={selected ? model[selected.page]?.blocks[selected.b] : null}
            run={selected ? model[selected.page]?.blocks[selected.b]?.lines[selected.l]?.runs[selected.r] : null}
            fontList={fontList}
            showBoxes={showBoxes}
            onShowBoxes={setShowBoxes}
          />
        )}
      </div>
    </div>
  )
}
