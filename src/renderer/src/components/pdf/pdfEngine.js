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

  return {
    open: (data) => { lastOpen = data; return call('open', { data }) },
    getModel: (pageIndex) => call('getModel', { pageIndex }), // → { width, height, fonts, colors, runs, images, vectors }
    renderImage: (pageIndex, scale) => call('renderImage', { pageIndex, scale }), // → { png, width, height } — raster visual
    renderObjects: (pageIndex, zs, bbox, scale) => call('renderObjects', { pageIndex, zs, bbox, scale }), // → transparent sprite of ONLY these objects
    deleteObjects: (pageIndex, items) => call('deleteObjects', { pageIndex, items }), // items:[{type,bbox}] — remove from the stream
    moveObjects: (pageIndex, items) => call('moveObjects', { pageIndex, items }), // items:[{type,bbox,dx,dy}] — shift coords in the stream
    copyObjects: (pageIndex, items, dx, dy) => call('copyObjects', { pageIndex, items, dx, dy }), // duplicate units in the stream at an offset
    getFontsInfo: () => call('getFontsInfo', {}), // → { fonts:[{name, embedded, subset}] } — document font inventory
    save: () => call('save', {}), // → { bytes } — the edited document serialised to PDF
    dispose: () => { pending.clear(); worker.terminate() },
  }
}
