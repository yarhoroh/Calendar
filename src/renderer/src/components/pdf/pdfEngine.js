// Thin promise wrapper around the MuPDF viewer worker. One instance per open document/tab.
export function createPdfEngine() {
  const worker = new Worker(new URL('./pdfViewer.worker.js', import.meta.url), { type: 'module' })
  let seq = 0
  const pending = new Map()

  worker.onmessage = (e) => {
    const { id, result, error } = e.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (error) p.reject(new Error(error))
    else p.resolve(result)
  }

  const call = (type, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, type, params })
    })

  return {
    open: (data) => call('open', { data }), // data: ArrayBuffer | Uint8Array → { pageCount }
    renderPage: (pageIndex, scale) => call('renderPage', { pageIndex, scale }), // → { png, width, height }
    dispose: () => {
      pending.clear()
      worker.terminate()
    },
  }
}
