import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ZoomInIcon, ZoomOutIcon, CopyIcon, PasteIcon, TrashIcon } from '../icons'
import api from '../../lib/api'
import ContextMenu from '../ContextMenu'
import { createPdfEngine } from './pdfEngine'
import PdfPage from './PdfPage'
import './PdfEditor.css'

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
        if (/times|roman|serif|georgia|garamond|book/i.test(name)) return 'Times New Roman'
        if (/courier|mono/i.test(name)) return 'Courier New'
        return 'Arial'
      }
      // a fully embedded font is self-sufficient; non-embedded or subset ones get a lookalike
      const fonts = (info.fonts || []).map((f) => ({ ...f, match: f.embedded && !f.subset ? null : similar(f.name) }))
      setDocFonts(fonts)
      setSysFonts(families)
      if (fonts.length) setFontSel((v) => v || fonts[0].name)
    })()
    return () => { alive = false }
  }, [pageCount])

  // every colour used in the document (text + art), merged across pages — the colour dropdown
  const docColors = [...new Set(model.flatMap((p) => p.colors || []))]

  // a single selected object shows ITS font/colour in the dropdowns
  useEffect(() => {
    if (!selected || selected.objs.length !== 1) return
    const pg = model.find((p) => p.pageIndex === selected.page)
    if (!pg) return
    const o = selected.objs[0]
    if (o.type === 'text' && pg.fonts?.[o.f]) setFontSel(pg.fonts[o.f].name)
    if (o.c !== undefined && pg.colors?.[o.c]) setColorSel(pg.colors[o.c])
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
      // physical keys (e.code), so the shortcuts work in any keyboard layout (RU gives e.key='с'/'м')
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') { if (selected) { e.preventDefault(); copySelected() } return }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') { if (clip) { e.preventDefault(); pasteClip() } return }
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
  }, [selected, clip, model, scale])

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
      // same diff trick as paste: snapshot signatures before, re-select whatever is NEW after —
      // the moved objects are exactly the ones whose signature changed (no geometric guessing)
      const before = new Set(allOf(model.find((p) => p.pageIndex === pageIndex) || { runs: [] }).map(sigOf))
      await engineRef.current.moveObjects(pageIndex, items)
      const m = await refreshPage(pageIndex)
      const moved = allOf(m).filter((o) => !before.has(sigOf(o)))
      console.log(`[pdf][move] d=(${dx.toFixed(1)},${dy.toFixed(1)}), moved (${moved.length} of ${items.length})`)
      onSelect(pageIndex, moved) // re-select through the ONE selection entry point — as if just selected by hand
    } catch (err) { console.error('[pdf] move failed:', err) }
  }

  // object signature that survives a re-parse: for text — stext metrics + the string itself (the
  // raster bbox tightening can shift y/h when a copy overlaps a neighbour, so those stay out of it)
  const sigOf = (o) => (o.type === 'text'
    ? `t|${o.bbox.x.toFixed(1)}|${o.bbox.w.toFixed(1)}|${o.size}|${o.text}`
    : `${o.type}|${o.bbox.x.toFixed(1)},${o.bbox.y.toFixed(1)},${o.bbox.w.toFixed(1)},${o.bbox.h.toFixed(1)}|${o.kind || ''}`)
  const allOf = (pg) => [...pg.runs, ...(pg.images || []), ...(pg.vectors || [])]

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
    const items = selected.objs.map((o) => ({ type: o.type, bbox: o.bbox }))
    if (!items.length) return
    onSelect(selected.page, null) // selection (and any pending nudge) is gone with the objects
    try {
      await engineRef.current.deleteObjects(selected.page, items)
      await refreshPage(selected.page)
    } catch (err) { console.error('[pdf] delete failed:', err) }
  }

  return (
    <div className="pdfed">
      <div className="pdfed__toolbar">
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.max(0.3, s / 1.15))} title="Zoom out"><ZoomOutIcon /></button>
        <span className="pdfed__zoom">{Math.round(scale * 100)}%</span>
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.min(10, s * 1.15))} title="Zoom in"><ZoomInIcon /></button>
        <span className="pdfed__sep" />
        <select className="pdfed__fontsel" value={fontSel} onChange={(e) => setFontSel(e.target.value)} title="Font">
          {docFonts.length > 0 && (
            <optgroup label="PDF">
              {docFonts.map((f) => (
                <option key={f.name} value={f.name}>{f.name + (f.match ? ` → ${f.match}` : '')}</option>
              ))}
            </optgroup>
          )}
          <optgroup label="System">
            {sysFonts.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </optgroup>
        </select>
        <div className="pdfed__colorwrap">
          <button
            className="pdfed__btn"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setColorOpen((v) => (v ? null : { x: r.left, y: r.bottom + 4 })) // fixed coords — the toolbar's overflow can't clip it
            }}
            title="Color"
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
                    onClick={() => { setColorSel(c); setColorOpen(null) }}
                  />
                ))}
              </div>
              {/* any colour beyond the document palette — the native picker */}
              <label className="pdfed__custom">
                Custom
                <input type="color" value={colorSel} onChange={(e) => setColorSel(e.target.value)} />
              </label>
            </div>
          )}
        </div>
        <span className="pdfed__sep" />
        <button className="pdfed__btn" onClick={copySelected} disabled={!selected} title="Copy (Ctrl+C)"><CopyIcon /></button>
        <button className="pdfed__btn" onClick={pasteClip} disabled={!clip} title="Paste (Ctrl+V)"><PasteIcon /></button>
        <button className="pdfed__btn" onClick={deleteSelected} disabled={!selected} title="Delete"><TrashIcon /></button>
        <button className="pdfed__btn pdfed__btn--txt pdfed__btn--save" onClick={handleSave} disabled={saving || !path} title="Save">{saving ? '…' : 'Save'}</button>
        <span className="pdfed__spacer" />
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
            {model.map((p) => (
              <PdfPage
                key={p.pageIndex}
                page={p}
                image={imgOf(p.pageIndex)}
                scale={scale}
                selected={selected}
                nudge={nudge && nudge.page === p.pageIndex ? nudge : null}
                onSelect={onSelect}
                onMove={moveSelected}
                onSprite={spriteFor}
                onMenu={setMenu}
              />
            ))}
          </div>
        </div>
      </div>

      {menu && (menu.kind === 'sel' || clip) && (
        <ContextMenu
          x={menu.sx}
          y={menu.sy}
          items={
            menu.kind === 'sel'
              ? [
                  { label: <span className="pdfed__mi"><CopyIcon /> Copy</span>, onClick: copySelected },
                  { label: <span className="pdfed__mi"><TrashIcon /> Delete</span>, onClick: deleteSelected }
                ]
              : [{ label: <span className="pdfed__mi"><PasteIcon /> Paste</span>, onClick: () => pasteClipAt(menu.x, menu.y) }]
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
