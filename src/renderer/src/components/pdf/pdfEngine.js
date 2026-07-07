// Thin promise wrapper around the MuPDF viewer worker. One instance per open document/tab.
export function createPdfEngine() {
  const worker = new Worker(new URL('./pdfViewer.worker.js', import.meta.url), { type: 'module' })
  let seq = 0
  let ready = false
  const queue = []
  const pending = new Map()

  worker.onmessage = (e) => {
    if (e.data && e.data.ready) { ready = true; for (const [m, tr] of queue) worker.postMessage(m, tr || []); queue.length = 0; return }
    if (e.data && e.data.log) { console.log('[pdf worker]', e.data.log); return }
    const { id, result, error } = e.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    error ? p.reject(new Error(error)) : p.resolve(result)
  }
  const failAll = (msg) => { console.error('[pdf engine]', msg); for (const p of pending.values()) p.reject(new Error(msg)); pending.clear() }
  worker.onerror = (e) => failAll('worker error: ' + (e.message || 'failed to load'))
  worker.onmessageerror = () => failAll('worker message error')

  // remembered bytes so a worker that dropped its doc (dev HMR) can be silently re-opened
  let lastOpen = null
  let reopening = null
  const raw = (type, params, tr = []) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); const msg = { id, type, params }; ready ? worker.postMessage(msg, tr) : queue.push([msg, tr]) })
  const call = async (type, params, tr = []) => {
    try { return await raw(type, params, tr) } catch (e) {
      if (type !== 'open' && lastOpen && /no document open/i.test(e?.message || '')) { if (!reopening) reopening = raw('open', { data: lastOpen }).finally(() => { reopening = null }); await reopening; return raw(type, params, tr) }
      throw e
    }
  }

  // ---- UNDO/REDO via CONTENT-STREAM snapshots. mupdf's own journal corrupts our raw edits, and a
  // whole-document snapshot is huge (embedded fonts / images = MBs per step). So each undo step keeps
  // only the pages' CONTENT STREAMS (the PDF operators — kilobytes), never the image/font objects.
  // Restoring the streams reverts the visual edit; objects an undone edit had added stay as harmless
  // orphans (GC'd on the final Save). Snapshots live ONLY in RAM — the saved file is unaffected.
  const MAX_STEPS = 60
  const MAX_BYTES = 40 * 1024 * 1024 // ceiling across the whole history (streams are tiny → generous)
  let history = [] // each entry = array of per-page content-stream strings
  let hi = -1
  const sizeOf = (streams) => streams.reduce((s, x) => s + (x ? x.length : 0), 0)
  const totalBytes = () => history.reduce((s, e) => s + sizeOf(e), 0)
  const undoInfo = () => ({ canUndo: hi > 0, canRedo: hi >= 0 && hi < history.length - 1 })
  const grabStreams = async () => (await raw('snapStreams', {})).streams
  const pushSnap = (streams) => {
    history = history.slice(0, hi + 1) // a fresh edit after undo drops the redo tail
    history.push(streams)
    while (history.length > MAX_STEPS || (history.length > 1 && totalBytes() > MAX_BYTES)) history.shift()
    hi = history.length - 1
  }
  const snap = async () => { try { pushSnap(await grabStreams()) } catch (e) { console.error('[pdf engine] snapshot failed:', e) } }
  const reopen = async (streams) => { await raw('restoreStreams', { streams }) }
  // a mutating call: run it, THEN snapshot the new page streams as one undo step
  const mut = async (type, params, tr = []) => { const r = await call(type, params, tr); await snap(); return r }

  return {
    open: async (data) => { lastOpen = data; const r = await call('open', { data }); history = [await grabStreams()]; hi = 0; return r },
    getModel: (pageIndex) => call('getModel', { pageIndex }), // → { width, height, fonts, colors, runs, images, vectors }
    renderImage: (pageIndex, scale) => call('renderImage', { pageIndex, scale }), // → { png, width, height } — raster visual
    renderObjects: (pageIndex, zs, bbox, scale) => call('renderObjects', { pageIndex, zs, bbox, scale }), // → transparent sprite of ONLY these objects
    deleteObjects: (pageIndex, items) => mut('deleteObjects', { pageIndex, items }), // items:[{type,bbox}] — remove from the stream
    moveObjects: (pageIndex, items) => mut('moveObjects', { pageIndex, items }), // items:[{type,bbox,dx,dy}] — shift coords in the stream
    copyObjects: (pageIndex, items, dx, dy) => mut('copyObjects', { pageIndex, items, dx, dy }), // duplicate units in the stream at an offset
    getFontsInfo: () => call('getFontsInfo', {}), // → { fonts:[{name, embedded, subset}] } — document font inventory
    insertText: (pageIndex, spec, fonts, fallback) => mut('insertText', { pageIndex, spec, fonts, fallback }, Object.values(fonts || {}).map((f) => f.bytes).filter(Boolean)), // write new rich text into the stream (fonts validated first)
    replaceText: (pageIndex, items, spec, fonts, fallback, textOnly = false) => mut('replaceText', { pageIndex, items, spec, fonts, fallback, textOnly }, Object.values(fonts || {}).map((f) => f.bytes).filter(Boolean)), // ATOMIC: validate fonts → delete → insert (textOnly: no redaction of unmatched)
    insertImage: (pageIndex, bytes, x, y, w, h) => mut('insertImage', { pageIndex, bytes, x, y, w, h }, [bytes]), // place a PNG/JPEG at x/y (pt, top-left)
    resizeObject: (pageIndex, item, nb, rotSpec) => mut('resizeObject', { pageIndex, item, nb, rotSpec }), // stretch an image/vector (rotSpec: scale along the object's own axes)
    rotateObjects: (pageIndex, items, angle, cx, cy) => mut('rotateObjects', { pageIndex, items, angle, cx, cy }), // rotate as a group around a pivot (device pt, deg clockwise)
    restackObjects: (pageIndex, items, mode) => mut('restackObjects', { pageIndex, items, mode }), // z-order: mode = front|back|forward|backward
    insertShape: (pageIndex, kind, geo, style) => mut('insertShape', { pageIndex, kind, geo, style }), // rect (radius) / line / ellipse
    recolorVector: (pageIndex, item, colors) => mut('recolorVector', { pageIndex, item, colors }), // { stroke?, fill? } hex or 'none'
    setVectorRadius: (pageIndex, item, radius) => mut('setVectorRadius', { pageIndex, item, radius }), // rebuild the path as a rounded rect
    setStrokeWidth: (pageIndex, item, w) => mut('setStrokeWidth', { pageIndex, item, w }), // stroke width, pt
    setOpacity: (pageIndex, item, ca, CA) => mut('setOpacity', { pageIndex, item, ca, CA }), // ca=fill, CA=stroke alpha 0..1
    setDash: (pageIndex, item, dash) => mut('setDash', { pageIndex, item, dash }), // solid|dashed|dotted|dashdot
    setLineGeo: (pageIndex, item, geo) => mut('setLineGeo', { pageIndex, item, geo }), // move a line/arrow endpoint {x1,y1,x2,y2}
    writeVariables: (json) => call('writeVariables', { json }), // template-variable defs (catalog metadata) — NOT part of undo (the panel owns their state)
    readVariables: () => call('readVariables', {}), // → { json } from the catalog (or null)
    undo: async () => { if (hi <= 0) return undoInfo(); hi--; await reopen(history[hi]); return undoInfo() }, // revert to the previous snapshot
    redo: async () => { if (hi < 0 || hi >= history.length - 1) return undoInfo(); hi++; await reopen(history[hi]); return undoInfo() },
    undoState: async () => undoInfo(), // local — no worker round-trip
    save: () => call('save', {}), // → { bytes } — the edited document serialised to PDF
    dispose: () => { pending.clear(); worker.terminate() },
  }
}
