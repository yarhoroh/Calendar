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
      for (const [m, transfer] of queue) worker.postMessage(m, transfer || [])
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

  const call = (type, params, transfer = []) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      const msg = { id, type, params }
      if (ready) worker.postMessage(msg, transfer)
      else queue.push([msg, transfer]) // sent once the worker reports ready
    })

  return {
    open: (data) => call('open', { data }), // data: ArrayBuffer | Uint8Array → { pageCount }
    renderPage: (pageIndex, scale) => call('renderPage', { pageIndex, scale }), // → { png, width, height }
    // → { blocks: [{x,y,width,height, lines:[{…, runs:[{text,bbox,fontName,size,color,bold,italic}]}]}],
    //     images: [rect], vectors: [{…rect, stroked, rectangle}], fonts: [{…}], colors: [hex] }
    getModel: (pageIndex) => call('getModel', { pageIndex }),
    redact: (pageIndex, rects, scale) => call('redact', { pageIndex, rects, scale }), // delete objects → { png, width, height }
    // real-time move: start (snapshot + baseline) → apply(full delta, latest-wins) → end
    moveStart: (pageIndex) => call('moveStart', { pageIndex }),
    moveApply: (pageIndex, items, scale) => call('moveApply', { pageIndex, items, scale }), // items: [{z,dx,dy}] full delta
    moveEnd: () => call('moveEnd', {}),
    // rewrite a text object's content/font/size/colour in place → { png, width, height }
    // spec: { paintZ, text, fontBytes, fontKey, size, origSize, color }
    editText: (pageIndex, spec, scale) => call('editText', { pageIndex, scale, ...spec }, spec.fontBytes ? [spec.fontBytes] : []),
    undo: () => call('undo', {}), // restore the previous working-copy snapshot → { undone, left }
    dispose: () => {
      pending.clear()
      worker.terminate()
    },
  }
}
