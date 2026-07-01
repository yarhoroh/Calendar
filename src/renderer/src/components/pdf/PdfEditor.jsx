import { useEffect, useRef, useState } from 'react'
import { ZoomInIcon, ZoomOutIcon, ComposeIcon } from '../icons'
import api from '../../lib/api'
import { createPdfEngine } from './pdfEngine'

// PDF editor v2 — object-tree model. Open → render pages → (edit mode) MuPDF gives an object tree
// per page (text/path/image, each with a byte-range address). Select frames, drag to move (worker
// shifts the object's own coordinates), edit text in the side panel, delete, and Save back to PDF.
const FRAME = { text: '#3b5bfd', path: '#e08a00', image: '#1b9e77' }

export default function PdfEditor({ source, path }) {
  const [pages, setPages] = useState([])
  const [pageCount, setPageCount] = useState(0)
  const [scale, setScale] = useState(1.5)
  const [status, setStatus] = useState('idle')
  const [editing, setEditing] = useState(false)
  const [objects, setObjects] = useState({}) // pageIndex → [obj]
  const [sel, setSel] = useState(null) // { page, id }
  const [draft, setDraft] = useState(null) // edited text object draft
  const [fontList, setFontList] = useState([])
  const [saving, setSaving] = useState(false)
  const [rev, setRev] = useState(0)
  const engineRef = useRef(null)
  const urlsRef = useRef([])
  const drag = useRef(null)
  const moveBusy = useRef(false)
  const moveLatest = useRef(null)

  const revoke = () => { for (const u of urlsRef.current) URL.revokeObjectURL(u); urlsRef.current = [] }

  useEffect(() => { engineRef.current = createPdfEngine(); return () => { engineRef.current?.dispose(); revoke() } }, [])
  useEffect(() => { Promise.resolve(api.fonts?.list?.()).then((l) => setFontList(Array.isArray(l) ? l : [])).catch(() => {}) }, [])

  // open
  useEffect(() => {
    if (source === undefined || !engineRef.current) return
    let alive = true
    setStatus('loading')
    Promise.resolve(engineRef.current.open(source))
      .then((info) => { if (alive) setPageCount(info?.pageCount || 0) })
      .catch((err) => { console.error('[pdf] open failed:', err); if (alive) setStatus('error') })
    return () => { alive = false }
  }, [source])

  // render all pages
  useEffect(() => {
    if (!pageCount || !engineRef.current) return
    let alive = true
    setStatus('loading')
    ;(async () => {
      const out = []
      for (let i = 0; i < pageCount; i++) {
        const r = await engineRef.current.renderPage(i, scale)
        if (!alive) return
        out.push({ pageIndex: i, width: r.width, height: r.height, url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })) })
      }
      if (!alive) { for (const p of out) URL.revokeObjectURL(p.url); return }
      revoke(); urlsRef.current = out.map((p) => p.url); setPages(out); setStatus('ready')
    })().catch(() => alive && setStatus('error'))
    return () => { alive = false }
  }, [pageCount, scale, rev])

  // object tree (edit mode)
  useEffect(() => {
    if (!editing || !pageCount || !engineRef.current) { setObjects({}); setSel(null); return }
    let alive = true
    ;(async () => {
      const out = {}
      for (let i = 0; i < pageCount; i++) { const r = await engineRef.current.getObjects(i); if (!alive) return; out[i] = r.objects || [] }
      if (alive) setObjects(out)
    })().catch((err) => console.error('[pdf] getObjects failed:', err))
    return () => { alive = false }
  }, [editing, pageCount, rev])

  const updateImage = (page, r) => {
    const url = URL.createObjectURL(new Blob([r.png], { type: 'image/png' }))
    urlsRef.current.push(url)
    setPages((prev) => prev.map((pg) => (pg.pageIndex === page ? { ...pg, url, width: r.width, height: r.height } : pg)))
  }
  const objOf = (page, id) => (objects[page] || []).find((o) => o.id === id)

  // ---- move (real-time, latest-wins) ----
  const onObjDown = (e, page, o) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    setSel({ page, id: o.id })
    setDraft(o.type === 'text' ? { text: o.text || '', size: o.size || 12, color: o.color || '#000000', fontName: 'Arial' } : null)
    const r = e.currentTarget.parentElement.getBoundingClientRect()
    drag.current = { page, o, sx: e.clientX, sy: e.clientY, r }
    engineRef.current?.moveStart(page)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const onMove = (e) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.sx) / scale
    const dy = (e.clientY - d.sy) / scale
    d.lastDx = dx; d.lastDy = dy
    moveLatest.current = { page: d.page, items: [{ addr: d.o.addr, dx, dy }] }
    if (moveBusy.current) return
    moveBusy.current = true
    ;(async () => {
      while (moveLatest.current) { const job = moveLatest.current; moveLatest.current = null; try { const r = await engineRef.current.moveApply(job.page, job.items, scale); updateImage(job.page, r) } catch (err) { console.error('[pdf] moveApply failed:', err) } }
      moveBusy.current = false
    })()
  }
  const onUp = async () => {
    const d = drag.current
    drag.current = null
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    if (!d) return
    if (d.lastDx || d.lastDy) {
      // update the object's frame position in place, then finalise + refresh the tree
      setObjects((prev) => ({ ...prev, [d.page]: (prev[d.page] || []).map((o) => (o.id === d.o.id ? { ...o, x: o.x + d.lastDx, y: o.y + d.lastDy } : o)) }))
    }
    while (moveBusy.current) await new Promise((r) => setTimeout(r, 8))
    try { await engineRef.current.moveEnd() } catch (_) {}
    if (d.lastDx || d.lastDy) { const r = await engineRef.current.getObjects(d.page); setObjects((prev) => ({ ...prev, [d.page]: r.objects || [] })) }
  }

  // ---- delete ----
  useEffect(() => {
    const onKey = async (e) => {
      const tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        const o = objOf(sel.page, sel.id); if (!o) return
        try { const r = await engineRef.current.deleteObject(sel.page, { x: o.x, y: o.y, width: o.width, height: o.height }, o.type, scale); updateImage(sel.page, r); setSel(null); const rr = await engineRef.current.getObjects(sel.page); setObjects((prev) => ({ ...prev, [sel.page]: rr.objects || [] })) } catch (err) { console.error('[pdf] delete failed:', err) }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); const r = await engineRef.current?.undo(); if (r?.undone) { setSel(null); setRev((v) => v + 1) } }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel, objects, scale]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- apply text edit ----
  const applyEdit = async () => {
    if (!sel || !draft) return
    const o = objOf(sel.page, sel.id); if (!o) return
    setSaving(true)
    try {
      const font = await api.fonts.file(draft.fontName, {})
      const fontKey = font?.family || draft.fontName
      const r = await engineRef.current.editText(sel.page, { addr: o.addr, text: draft.text, fontBytes: font?.bytes, fontKey, fontName: draft.fontName, size: draft.size, color: draft.color }, scale)
      updateImage(sel.page, r)
      const rr = await engineRef.current.getObjects(sel.page); setObjects((prev) => ({ ...prev, [sel.page]: rr.objects || [] }))
      setSel(null); setDraft(null)
    } catch (err) { console.error('[pdf] editText failed:', err) } finally { setSaving(false) }
  }

  // ---- save ----
  const handleSave = async () => {
    if (!engineRef.current || !path) return
    setSaving(true)
    try { const r = await engineRef.current.save(); const out = String(path).replace(/\.pdf$/i, '') + ' (edited).pdf'; await api.pdf.write(out, new Uint8Array(r.bytes)); api.pdf.reveal?.(out) }
    catch (err) { console.error('[pdf] save failed:', err) } finally { setSaving(false) }
  }

  const px = (v) => v * scale
  return (
    <div className="pdfed" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="pdfed__toolbar" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid #ddd' }}>
        <button onClick={() => setScale((s) => Math.max(0.3, s / 1.15))}><ZoomOutIcon /></button>
        <span>{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale((s) => Math.min(8, s * 1.15))}><ZoomInIcon /></button>
        <span style={{ width: 8 }} />
        <button onClick={() => setEditing((v) => !v)} style={{ fontWeight: editing ? 700 : 400 }}><ComposeIcon /> Edit</button>
        {editing && <button onClick={handleSave} disabled={saving || !path} style={{ background: '#3b5bfd', color: '#fff', padding: '4px 12px', borderRadius: 4 }}>{saving ? '…' : 'Save'}</button>}
        <span style={{ flex: 1 }} />
        <span style={{ color: '#888' }}>{status === 'loading' ? '…' : `${pageCount} p.`}</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, overflow: 'auto', background: '#525659', padding: 20 }}>
          {pages.map((p) => (
            <div key={p.pageIndex} style={{ position: 'relative', width: px(p.width), height: px(p.height), margin: '0 auto 16px', background: '#fff' }}>
              <img src={p.url} width={px(p.width)} height={px(p.height)} draggable={false} alt="" />
              {editing && (objects[p.pageIndex] || []).map((o) => (
                <div
                  key={o.id}
                  onMouseDown={(e) => onObjDown(e, p.pageIndex, o)}
                  title={o.type}
                  style={{ position: 'absolute', left: px(o.x), top: px(o.y), width: px(o.width), height: px(o.height), outline: `1px solid ${sel && sel.page === p.pageIndex && sel.id === o.id ? '#000' : FRAME[o.type] || '#888'}`, background: sel && sel.id === o.id ? 'rgba(59,91,253,0.08)' : 'transparent', cursor: 'move' }}
                />
              ))}
            </div>
          ))}
        </div>

        {editing && (
          <div style={{ flex: '0 0 240px', borderLeft: '1px solid #ddd', padding: 12, overflow: 'auto', fontSize: 13 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>FORMAT</div>
            {!draft && <div style={{ color: '#888' }}>Select a text object</div>}
            {draft && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <textarea value={draft.text} onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))} rows={3} style={{ width: '100%', boxSizing: 'border-box' }} />
                <select value={draft.fontName} onChange={(e) => setDraft((d) => ({ ...d, fontName: e.target.value }))}>
                  {[draft.fontName, ...fontList.map((f) => f.family)].filter((v, i, a) => a.indexOf(v) === i).map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="number" step="0.5" value={draft.size} onChange={(e) => setDraft((d) => ({ ...d, size: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                  <input type="color" value={draft.color} onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))} />
                </div>
                <button onClick={applyEdit} disabled={saving} style={{ background: '#3b5bfd', color: '#fff', padding: '6px', borderRadius: 4 }}>{saving ? '…' : 'Apply'}</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
