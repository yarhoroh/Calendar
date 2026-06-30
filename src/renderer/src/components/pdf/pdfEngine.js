// Thin promise wrapper around the MuPDF viewer worker. One instance per open document/tab.
export function createPdfEngine() {
  const worker = new Worker(new URL('./pdfViewer.worker.js', import.meta.url), { type: 'module' })
  let seq = 0
  let ready = false
  const queue = [] // commands posted before the worker (WASM) finished loading
  const pending = new Map()

  worker.onmessage = (e) => {
    if (e.data && e.data.ready) {
      ready = true
      for (const m of queue) worker.postMessage(m)
      queue.length = 0
      return
    }
    if (e.data && e.data.log) {
      console.log('[pdf worker]', e.data.log)
      return
    }
    const { id, result, error } = e.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (error) p.reject(new Error(error))
    else p.resolve(result)
  }

  // surface a dead/failed worker instead of hanging on a forever-pending promise
  const failAll = (msg) => {
    console.error('[pdf engine]', msg)
    for (const p of pending.values()) p.reject(new Error(msg))
    pending.clear()
  }
  worker.onerror = (e) => failAll('worker error: ' + (e.message || 'failed to load') + (e.filename ? ` @ ${e.filename}:${e.lineno}` : ''))
  worker.onmessageerror = () => failAll('worker message error')

  const call = (type, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      const msg = { id, type, params }
      if (ready) worker.postMessage(msg)
      else queue.push(msg) // sent once the worker reports ready
    })

  return {
    open: (data) => call('open', { data }), // data: ArrayBuffer | Uint8Array → { pageCount }
    renderPage: (pageIndex, scale) => call('renderPage', { pageIndex, scale }), // → { png, width, height }
    // → { textBlocks: [{x,y,width,height, lines:[…]}], images: [rect], vectors: [{…rect, stroked, rectangle}] }
    getObjects: (pageIndex) => call('getObjects', { pageIndex }),
    dispose: () => {
      pending.clear()
      worker.terminate()
    },
  }
}
