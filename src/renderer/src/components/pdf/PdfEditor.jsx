import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDocumentEditor } from '../../pdf-editor/react'
import { ObjectLayer } from '../../pdf-editor/react/editor/ObjectLayer'
import { StylePanel, ShapePanel, VectorPanel } from '../../pdf-editor/react/editor/StylePanel'
import { SaveIcon, ComposeIcon, TextBoxIcon, ImageIcon, ShapeIcon, ZoomInIcon, ZoomOutIcon } from '../icons'
import ContextMenu from '../ContextMenu'
import { useI18n } from '../../i18n/I18nContext'
import './PdfEditor.css'

// Our themed shell around the vendored @pdf-editor/core brain (useDocumentEditor): the editing
// logic (selection, marquee, drag, live-lift, save) is the package's; the toolbar, panels,
// icons, keyboard shortcuts and styling are ours. A PDF is opened from `source` (bytes) and
// saved back through `onSave`.
export default function PdfEditor({ source, fileName, onSave, onSaveAs, onDirty }) {
  const { t } = useI18n()
  const ed = useDocumentEditor({})
  const scale = ed.scale
  const zoomBy = ed.zoomBy
  const status = ed.status

  // "dirty" = the user actually changed something (added / edited / lifted / deleted an object).
  // After a save the brain clears its objects into the raster, so this drops back to false.
  const dirty = ed.objects.some((o) => o.source === 'new' || o.edited || o.lifted || o.deleted)
  useEffect(() => {
    onDirty?.(dirty)
  }, [dirty, onDirty])

  const [tool, setTool] = useState('view')
  const [saveMenu, setSaveMenu] = useState(null) // { x, y } — the Save dropdown
  const [saveAs, setSaveAs] = useState(null) // { name } — the "save as new" name prompt
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const panRef = useRef(null)
  const imgInputRef = useRef(null)
  const pendingImage = useRef(null)
  const viewportRef = useRef(null)
  const zoomAnchorRef = useRef(null)

  // open the tab's bytes whenever they change
  useEffect(() => {
    if (source !== undefined) void ed.open(source)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  // overwrite the current file
  const saveCurrent = useCallback(async () => {
    const bytes = await ed.save('rewrite')
    if (bytes) await onSave?.(bytes)
  }, [ed, onSave])
  // save under a new name in the same folder, then open it
  const doSaveAs = useCallback(async () => {
    const name = (saveAs?.name || '').trim()
    if (!name) return
    const bytes = await ed.save('rewrite')
    setSaveAs(null)
    if (bytes) await onSaveAs?.(bytes, name)
  }, [ed, onSaveAs, saveAs])

  // Ctrl + wheel zooms to the cursor (capture-phase, non-passive so we cancel page-zoom)
  useEffect(() => {
    const onWheel = (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const el = viewportRef.current
      if (el) {
        const vr = el.getBoundingClientRect()
        zoomAnchorRef.current = {
          ox: Math.max(0, Math.min(vr.width, e.clientX - vr.left)),
          oy: Math.max(0, Math.min(vr.height, e.clientY - vr.top)),
          scrollLeft0: el.scrollLeft,
          scrollTop0: el.scrollTop,
          s0: scale
        }
      }
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12)
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [scale, zoomBy])

  useLayoutEffect(() => {
    const a = zoomAnchorRef.current
    const el = viewportRef.current
    if (!a || !el) return
    zoomAnchorRef.current = null
    const f = scale / a.s0
    el.scrollLeft = (a.scrollLeft0 + a.ox) * f - a.ox
    el.scrollTop = (a.scrollTop0 + a.oy) * f - a.oy
  }, [scale])

  // Hold Space to pan like a hand tool
  useEffect(() => {
    const isField = (n) => n instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)
    const down = (e) => {
      if (e.code !== 'Space' || isField(e.target)) return
      e.preventDefault()
      if (e.repeat) return
      const a = document.activeElement
      if (a instanceof HTMLElement && a !== document.body) a.blur()
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

  // Shortcuts: Ctrl+S save, Delete remove, Esc deselect, tool hotkeys, Ctrl+C/V
  useEffect(() => {
    const isField = (n) => n instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)
    const onKey = (e) => {
      if (isField(e.target) || ed.editingId) return // typing into a field / inline text edit
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveCurrent()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') return ed.selectedId && ed.copyObject(ed.selectedId)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return ed.paste()
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (ed.selectedId) {
          e.preventDefault()
          ed.deleteSelected()
        }
        return
      }
      if (e.key === 'Escape') {
        ed.select(null)
        setTool('view')
        return
      }
      // nudge the selected object with the arrow keys. Step is in ON-SCREEN pixels (÷scale → PDF
      // points), so one press = one screen pixel at any zoom — Shift = 10px, Alt = ½px (fine align).
      if (e.key.startsWith('Arrow') && ed.selectedId && ed.selectedObject) {
        e.preventDefault()
        const px = e.altKey ? 0.5 : e.shiftKey ? 10 : 1
        const step = px / scale
        const o = ed.selectedObject
        ed.updateObject(ed.selectedId, {
          x: o.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0),
          y: o.y + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)
        })
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'e') setTool((p) => (p === 'edit' ? 'view' : 'edit'))
      else if (e.key === 't') setTool((p) => (p === 'text' ? 'view' : 'text'))
      else if (e.key === 'r') setTool((p) => (p === 'shape' ? 'view' : 'shape'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ed, saveCurrent])

  const onPanMouseDown = useCallback(
    (e) => {
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
      const up = () => {
        panRef.current = null
        setPanning(false)
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [spaceHeld]
  )

  // ---- marquee (rubber-band) selection on empty page space ----
  const [marquee, setMarquee] = useState(null)
  const marqueeDrag = useRef(null)
  const suppressClick = useRef(false)

  const onPageMouseDown = useCallback(
    (event, pageIndex) => {
      if (tool !== 'edit' || event.button !== 0) return
      const rect = event.currentTarget.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const px = x / scale
      const py = y / scale
      const overText = (ed.lineRects[pageIndex] ?? []).some(
        (r) => px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height
      )
      if (overText) return
      marqueeDrag.current = { pageIndex, left: rect.left, top: rect.top, x0: x, y0: y, x1: x, y1: y }
      setMarquee({ pageIndex, x, y, w: 0, h: 0 })
    },
    [tool, scale, ed]
  )

  useEffect(() => {
    if (!marquee) return
    const move = (e) => {
      const d = marqueeDrag.current
      if (!d) return
      d.x1 = e.clientX - d.left
      d.y1 = e.clientY - d.top
      setMarquee({ pageIndex: d.pageIndex, x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) })
    }
    const up = () => {
      const d = marqueeDrag.current
      marqueeDrag.current = null
      setMarquee(null)
      if (!d) return
      const w = Math.abs(d.x1 - d.x0)
      const h = Math.abs(d.y1 - d.y0)
      if (w > 3 && h > 3) {
        suppressClick.current = true
        void ed.selectInBox(d.pageIndex, { x: Math.min(d.x0, d.x1) / scale, y: Math.min(d.y0, d.y1) / scale, width: w / scale, height: h / scale })
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [marquee !== null, scale, ed])

  const onPageClick = useCallback(
    (event, pageIndex) => {
      if (suppressClick.current) {
        suppressClick.current = false
        return
      }
      const rect = event.currentTarget.getBoundingClientRect()
      const pageX = (event.clientX - rect.left) / scale
      const pageY = (event.clientY - rect.top) / scale
      if (tool === 'edit') {
        if (event.ctrlKey) {
          if (event.detail >= 2) ed.addTextAt(pageIndex, pageX, pageY)
        } else {
          void ed.selectAt(pageIndex, pageX, pageY, event.detail >= 2)
        }
      } else if (tool === 'text') {
        ed.addTextAt(pageIndex, pageX, pageY)
        setTool('view')
      } else if (tool === 'shape') {
        ed.addShapeAt(pageIndex, pageX, pageY)
        setTool('view')
      } else if (tool === 'image' && pendingImage.current) {
        void ed.addImage(pageIndex, pendingImage.current, pageX, pageY)
        pendingImage.current = null
        setTool('view')
      } else {
        ed.select(null)
      }
    },
    [tool, scale, ed]
  )

  const toggleTool = (next) => {
    ed.select(null)
    setTool((p) => (p === next ? 'view' : next))
  }

  const hint =
    status === 'loading'
      ? t('pdfed.loading')
      : status === 'error'
        ? `${t('pdfed.error')}: ${ed.error}`
        : tool === 'edit'
          ? t('pdfed.hintEdit')
          : tool === 'text'
            ? t('pdfed.hintText')
            : tool === 'shape'
              ? t('pdfed.hintShape')
              : ed.info
                ? `${ed.info.pageCount} ${t('pdfed.pages')}`
                : t('pdfed.hintIdle')

  const toolBtn = (name, icon, label) => (
    <button
      type="button"
      className={'pdfed__btn' + (tool === name ? ' is-active' : '')}
      onClick={() => toggleTool(name)}
      disabled={status !== 'ready'}
      title={label}
    >
      {icon}
    </button>
  )

  return (
    <div className="pdfed">
      <div className="pdfed__toolbar">
        <button
          type="button"
          className="pdfed__btn"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setSaveMenu({ x: r.left, y: r.bottom + 2 })
          }}
          disabled={status !== 'ready'}
          title={t('pdfed.save')}
        >
          <SaveIcon />
        </button>
        <span className="pdfed__sep" />
        {toolBtn('edit', <ComposeIcon />, t('pdfed.editText'))}
        {toolBtn('text', <TextBoxIcon />, t('pdfed.addText'))}
        <button
          type="button"
          className="pdfed__btn"
          onClick={() => {
            ed.select(null)
            imgInputRef.current?.click()
          }}
          disabled={status !== 'ready'}
          title={t('pdfed.image')}
        >
          <ImageIcon />
        </button>
        {toolBtn('shape', <ShapeIcon />, t('pdfed.shape'))}
        <span className="pdfed__sep" />
        <button type="button" className="pdfed__btn" onClick={() => zoomBy(1 / 1.15)} disabled={status !== 'ready'} title={t('pdfed.zoomOut')}>
          <ZoomOutIcon />
        </button>
        <span className="pdfed__zoom">{Math.round(scale * 100)}%</span>
        <button type="button" className="pdfed__btn" onClick={() => zoomBy(1.15)} disabled={status !== 'ready'} title={t('pdfed.zoomIn')}>
          <ZoomInIcon />
        </button>
        <span className="pdfed__spacer" />
        <span className="pdfed__status">{hint}</span>
        <input
          ref={imgInputRef}
          type="file"
          accept="image/png,image/jpeg"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) {
              pendingImage.current = file
              setTool('image')
            }
            e.target.value = ''
          }}
        />
      </div>

      {/* always-present panel row so selecting an object never jitters the header height */}
      <div className="pdfed__subbar">
        {ed.selected ? (
          <StylePanel
            object={ed.selected}
            fonts={ed.fonts}
            documentFonts={ed.documentFonts}
            documentSizes={ed.documentSizes}
            documentColors={ed.documentColors}
            onChange={ed.updateSelected}
            onDelete={ed.deleteSelected}
          />
        ) : ed.selectedObject?.kind === 'rect' ? (
          <ShapePanel object={ed.selectedObject} onChange={(patch) => ed.updateObject(ed.selectedObject.id, patch)} onDelete={ed.deleteSelected} />
        ) : ed.selectedObject?.kind === 'vector' ? (
          <VectorPanel object={ed.selectedObject} onChange={(patch) => ed.updateObject(ed.selectedObject.id, patch)} onDelete={ed.deleteSelected} />
        ) : (
          <span className="pdfed__hint">{hint}</span>
        )}
      </div>

      <div
        className="pdfed__viewport"
        style={{ cursor: spaceHeld ? (panning ? 'grabbing' : 'grab') : undefined }}
        ref={viewportRef}
        onMouseDown={onPanMouseDown}
      >
        <div className="pdfed__pages">
          {ed.pages.length === 0 ? (
            <div className="pdfed__placeholder">{status === 'loading' ? t('pdfed.loading') : ''}</div>
          ) : (
            ed.pages.map((page) => {
              const k = scale / page.renderedScale
              const dispW = page.width * k
              const dispH = page.height * k
              return (
                <div
                  key={page.pageIndex}
                  className="pdfed__page"
                  style={{ width: dispW, height: dispH, cursor: tool === 'view' ? 'default' : 'crosshair', pointerEvents: spaceHeld ? 'none' : undefined }}
                  onMouseDown={(e) => onPageMouseDown(e, page.pageIndex)}
                  onClick={(e) => onPageClick(e, page.pageIndex)}
                >
                  <img src={page.url} width={dispW} height={dispH} className="pdfed__pageimg" alt={`${t('pdfed.page')} ${page.pageIndex + 1}`} draggable={false} />
                  <ObjectLayer
                    scale={scale}
                    objects={ed.objects.filter((o) => o.pageIndex === page.pageIndex)}
                    selectedId={ed.selectedId}
                    editingId={ed.editingId}
                    onSelect={ed.select}
                    onStartEdit={ed.startEdit}
                    onChange={ed.updateObject}
                    onTextInput={ed.textInput}
                    onCommit={ed.commitEdit}
                    onExitEdit={ed.exitEdit}
                    onDelete={ed.deleteObject}
                    onBringForward={ed.bringForward}
                    onSendBackward={ed.sendBackward}
                    onCrop={ed.cropObject}
                    onCopy={ed.copyObject}
                    onPaste={ed.paste}
                    guideLines={ed.lineRects[page.pageIndex] ?? []}
                    vectorOutlines={ed.vectorRects[page.pageIndex] ?? []}
                    showOutlines={tool === 'edit'}
                    groupIds={ed.groupIds}
                    onGroupMove={ed.moveGroup}
                    onGroupMoveEnd={ed.endGroupMove}
                    pageUrl={page.url}
                  />
                  {marquee && marquee.pageIndex === page.pageIndex && (
                    <div className="pdfed__marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      {saveMenu && (
        <ContextMenu
          x={saveMenu.x}
          y={saveMenu.y}
          items={[
            { label: t('pdfed.saveCurrent'), onClick: saveCurrent },
            { label: t('pdfed.saveAsNew'), onClick: () => setSaveAs({ name: fileName || 'document.pdf' }) }
          ]}
          onClose={() => setSaveMenu(null)}
        />
      )}

      {saveAs && (
        <div className="pdfed__saveas">
          <span className="pdfed__saveas-label">{t('pdfed.saveAsNew')}</span>
          <input
            className="pdfed__saveas-input"
            autoFocus
            value={saveAs.name}
            placeholder={t('pdfed.fileName')}
            onChange={(e) => setSaveAs({ name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doSaveAs()
              if (e.key === 'Escape') setSaveAs(null)
            }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button className="pdfed__saveas-ok" onClick={doSaveAs}>{t('pdfed.create')}</button>
          <button className="pdfed__saveas-cancel" title={t('mail.close')} onClick={() => setSaveAs(null)}>✕</button>
        </div>
      )}
    </div>
  )
}
