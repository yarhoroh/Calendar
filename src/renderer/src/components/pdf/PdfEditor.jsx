import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ZoomInIcon, ZoomOutIcon, ComposeIcon } from '../icons'
import { useI18n } from '../../i18n/I18nContext'
import api from '../../lib/api'
import { createPdfEngine } from './pdfEngine'
import StylePanel from './StylePanel'
import SelectLayer from './SelectLayer'
import InlineTextEditor from './InlineTextEditor'
import './PdfEditor.css'

// The page model already carries the fixed objects (stable id + all stream fragments + styled
// content). Adapt them to the select layer's shape (key=id, z=paintZs = q..Q block indices, which the
// worker shifts via a cm-wrap) and pull run bboxes for the grey style-span hints.
const objectsOf = (m) =>
  (m.objects || []).map((o) => ({ key: o.id, type: o.type, x: o.x, y: o.y, width: o.width, height: o.height, z: o.paintZs }))
const runsOf = () => [] // text pieces are now objects themselves — no separate run hint layer

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
  const [applying, setApplying] = useState(false) // an editText round-trip is in flight
  const [inlineEdit, setInlineEdit] = useState(null) // { page, id } — object open in the inline editor
  const [embeddedFaces, setEmbeddedFaces] = useState(null) // real font name → loaded @font-face family
  const [rev, setRev] = useState(0) // bump to force re-render of pages + model after an edit/undo
  const engineRef = useRef(null)
  const urlsRef = useRef([])
  const viewportRef = useRef(null)
  const panRef = useRef(null)
  const zoomAnchorRef = useRef(null) // keeps the point under the cursor fixed across a zoom step
  const moveBusy = useRef(false) // a moveApply render is in flight
  const moveLatest = useRef(null) // newest pending move job (latest-wins)

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

  // load the PDF's embedded TrueType fonts as @font-face so the inline editor shows real glyphs (1:1)
  useEffect(() => {
    if (!editing || !pageCount || !engineRef.current) return
    let alive = true
    ;(async () => {
      try {
        const res = await engineRef.current.getFonts()
        const map = new Map()
        for (const f of res?.fonts || []) {
          const family = 'PDFEmbed_' + f.name.replace(/[^a-z0-9]/gi, '_')
          try {
            const face = new FontFace(family, f.bytes)
            await face.load()
            document.fonts.add(face)
            map.set(f.name, family)
          } catch (_) {
            // unsupported/broken embed — the editor falls back to the family name
          }
        }
        if (alive) setEmbeddedFaces(map)
      } catch (_) {
        /* no embedded fonts */
      }
    })()
    return () => {
      alive = false
    }
  }, [editing, pageCount])

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
  }, [pageCount, scale, rev])

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
  }, [editing, pageCount, rev])

  // Ctrl+Z — undo the last edit by restoring the previous working-copy snapshot, then re-render
  useEffect(() => {
    if (!editing) return
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        e.preventDefault()
        Promise.resolve(engineRef.current?.undo())
          .then((r) => {
            if (r?.undone) {
              setSelected(null)
              setRev((v) => v + 1)
            }
          })
          .catch((err) => console.error('[pdf] undo failed:', err))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing])

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

  const updatePageImage = (page, r) => {
    const url = URL.createObjectURL(new Blob([r.png], { type: 'image/png' }))
    urlsRef.current.push(url)
    setPages((prev) => prev.map((pg) => (pg.pageIndex === page ? { ...pg, url } : pg)))
  }

  // Delete: apply to the working copy, refresh image + model.
  const handleCommit = async (page, c) => {
    if (!engineRef.current || c.type !== 'delete') return
    try {
      const r = await engineRef.current.redact(page, c.rects, scale)
      updatePageImage(page, r)
      const m = await engineRef.current.getModel(page)
      setModel((prev) => ({ ...prev, [page]: m }))
      setSelected(null)
    } catch (err) {
      console.error('[pdf] delete failed:', err)
    }
  }

  // Real-time move: latest-wins — only the most recent drag position is rendered; skipped frames drop.
  const handleMoveApply = (page, items) => {
    console.log('[move] sending', items.length, 'items, distinct z:', new Set(items.map((i) => i.z)).size, 'z:', [...new Set(items.map((i) => i.z))])
    moveLatest.current = { page, items }
    if (moveBusy.current) return
    moveBusy.current = true
    ;(async () => {
      while (moveLatest.current) {
        const job = moveLatest.current
        moveLatest.current = null
        try {
          const r = await engineRef.current.moveApply(job.page, job.items, scale)
          updatePageImage(job.page, r)
        } catch (err) {
          console.error('[pdf] moveApply failed:', err)
        }
      }
      moveBusy.current = false
    })()
  }
  const handleMoveEnd = async (page, deltas) => {
    // update object positions IN PLACE FIRST (synchronously, batched with the layer's offset reset)
    // so the frame stays on the new spot — no re-segmentation, no return-then-jump flicker.
    setModel((prev) => {
      const m = prev[page]
      if (!m) return prev
      const shiftBox = (r, d) => ({ ...r, x: r.x + d.dx, y: r.y + d.dy })
      const objects = m.objects.map((o) => {
        const d = deltas[o.id]
        if (!d) return o
        const lines = o.lines?.map((l) => ({
          ...l,
          x: l.x + d.dx,
          y: l.y + d.dy,
          runs: l.runs.map((r) => ({ ...r, bbox: shiftBox(r.bbox, d) })),
        }))
        return { ...o, x: o.x + d.dx, y: o.y + d.dy, lines }
      })
      return { ...prev, [page]: { ...m, objects } }
    })
    // finalize the worker move afterwards (doesn't affect the UI)
    while (moveBusy.current) await new Promise((r) => setTimeout(r, 8))
    try {
      await engineRef.current.moveEnd()
    } catch (err) {
      console.error('[pdf] moveEnd failed:', err)
    }
  }

  // Apply a text edit: swap the selected object's content/font/size/colour in the working copy.
  const handleApplyEdit = async (page, obj, style, text) => {
    if (!engineRef.current || !obj) return
    const textZ = obj.fragmentZ?.[0]
    if (textZ == null) return
    const run = obj.lines?.[0]?.runs?.[0]
    setApplying(true)
    try {
      const font = await api.fonts.file(style.fontName, { bold: !!style.bold, italic: !!style.italic })
      if (!font?.bytes) throw new Error('no font file for ' + style.fontName)
      const fontKey = font.family + (font.bold ? '-b' : '') + (font.italic ? '-i' : '')
      const r = await engineRef.current.editText(
        page,
        { textZ, text, fontBytes: font.bytes, fontKey, size: style.size, origSize: run?.size || style.size, color: style.color },
        scale
      )
      updatePageImage(page, r)
      const m = await engineRef.current.getModel(page)
      setModel((prev) => ({ ...prev, [page]: m }))
      setSelected(null)
    } catch (err) {
      console.error('[pdf] editText failed:', err)
    } finally {
      setApplying(false)
    }
  }

  // Inline WYSIWYG editor: hide the block's glyphs, open the HTML editor in its place.
  const handleEditBegin = async (page, id) => {
    const obj = model[page]?.objects.find((o) => o.id === id)
    const textZs = obj?.fragmentZ
    if (!engineRef.current || !textZs?.length) return
    try {
      const r = await engineRef.current.editBegin(page, textZs, scale)
      updatePageImage(page, r)
      setSelected(null)
      setInlineEdit({ page, id })
    } catch (err) {
      console.error('[pdf] editBegin failed:', err)
    }
  }
  const handleEditCancel = async () => {
    const page = inlineEdit?.page
    setInlineEdit(null)
    if (page == null || !engineRef.current) return
    try {
      const r = await engineRef.current.editCancel(scale)
      updatePageImage(page, r)
    } catch (err) {
      console.error('[pdf] editCancel failed:', err)
    }
  }
  const handleEditCommit = async (page, id, runs) => {
    const obj = model[page]?.objects.find((o) => o.id === id)
    const textZs = obj?.fragmentZ
    if (!engineRef.current || !textZs?.length || !runs.length) return handleEditCancel()
    const origSize = obj?.lines?.[0]?.runs?.[0]?.size || runs[0].size
    setApplying(true)
    try {
      const fontCache = new Map()
      const seenKey = new Set()
      const packed = []
      for (const r of runs) {
        let font = fontCache.get(r.fontName + r.bold + r.italic)
        if (!font) {
          font = await api.fonts.file(r.fontName, { bold: !!r.bold, italic: !!r.italic })
          fontCache.set(r.fontName + r.bold + r.italic, font)
        }
        if (!font?.bytes) continue
        const fontKey = font.family + (font.bold ? '-b' : '') + (font.italic ? '-i' : '')
        const first = !seenKey.has(fontKey)
        seenKey.add(fontKey)
        packed.push({ text: r.text, fontKey, fontBytes: first ? font.bytes : undefined, size: r.size, origSize, color: r.color })
      }
      const rr = await engineRef.current.editCommit(page, textZs, packed, scale)
      updatePageImage(page, rr)
      const m = await engineRef.current.getModel(page)
      setModel((prev) => ({ ...prev, [page]: m }))
    } catch (err) {
      console.error('[pdf] editCommit failed:', err)
    } finally {
      setApplying(false)
      setInlineEdit(null)
    }
  }

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
                {editing && model[p.pageIndex] && !(inlineEdit && inlineEdit.page === p.pageIndex) && (
                  <SelectLayer
                    objects={objectsOf(model[p.pageIndex])}
                    runs={runsOf(model[p.pageIndex])}
                    scale={scale}
                    spaceHeld={spaceHeld}
                    showBoxes={showBoxes}
                    onSelection={(keys) => {
                      // one text object selected → show its style in the FORMAT panel
                      setSelected(keys.length === 1 && keys[0][0] === 't' ? { page: p.pageIndex, id: keys[0] } : null)
                    }}
                    onCommit={(c) => handleCommit(p.pageIndex, c)}
                    onMoveStart={() => engineRef.current?.moveStart(p.pageIndex)}
                    onMoveApply={(items) => handleMoveApply(p.pageIndex, items)}
                    onMoveEnd={(deltas) => handleMoveEnd(p.pageIndex, deltas)}
                    onEditObject={(key) => handleEditBegin(p.pageIndex, key)}
                  />
                )}
                {inlineEdit && inlineEdit.page === p.pageIndex && model[p.pageIndex] && (
                  <InlineTextEditor
                    obj={model[p.pageIndex].objects.find((o) => o.id === inlineEdit.id)}
                    scale={scale}
                    fontList={fontList}
                    embeddedFaces={embeddedFaces}
                    onCancel={handleEditCancel}
                    onCommit={(runs) => handleEditCommit(p.pageIndex, inlineEdit.id, runs)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {editing &&
          (() => {
            const obj = selected ? model[selected.page]?.objects.find((o) => o.id === selected.id) : null
            const objText = obj?.lines?.map((l) => l.runs.map((r) => r.text).join('')).join('\n') || ''
            return (
              <StylePanel
                page={selected ? model[selected.page] : null}
                block={obj}
                run={obj?.lines?.[0]?.runs?.[0]}
                text={objText}
                fontList={fontList}
                showBoxes={showBoxes}
                onShowBoxes={setShowBoxes}
                applying={applying}
                onApply={(style, text) => handleApplyEdit(selected.page, obj, style, text)}
              />
            )
          })()}
      </div>
    </div>
  )
}
