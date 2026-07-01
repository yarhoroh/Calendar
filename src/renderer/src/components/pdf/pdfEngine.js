// Thin promise wrapper around the v2 MuPDF worker. One instance per open document/tab.
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
    renderPage: (pageIndex, scale) => call('renderPage', { pageIndex, scale }),
    getObjects: (pageIndex) => call('getObjects', { pageIndex }), // → { objects:[{id,type,x,y,width,height,addr,text,size,color}], pageHeight }
    moveStart: (pageIndex) => call('moveStart', { pageIndex }),
    moveApply: (pageIndex, items, scale) => call('moveApply', { pageIndex, items, scale }), // items:[{addr,dx,dy}]
    moveEnd: () => call('moveEnd', {}),
    editText: (pageIndex, spec, scale) => call('editText', { pageIndex, scale, ...spec }, spec.fontBytes ? [spec.fontBytes] : []),
    deleteObject: (pageIndex, rect, kind, scale) => call('deleteObject', { pageIndex, rect, kind, scale }),
    getFonts: () => call('getFonts', {}),
    save: () => call('save', {}),
    undo: () => call('undo', {}),
    dispose: () => { pending.clear(); worker.terminate() },
  }
}
