// Minimal MuPDF worker for the PDF viewer: open a document and render pages to PNG. Pure
// request/response — the renderer talks to it through pdfEngine.js. We rebuild the editor on top
// of this from scratch, one feature at a time, instead of the previous vendored engine.
import * as mupdf from 'mupdf'

let doc = null

self.onmessage = (e) => {
  const { id, type, params } = e.data
  try {
    if (type === 'open') {
      doc = mupdf.Document.openDocument(new Uint8Array(params.data), 'application/pdf')
      self.postMessage({ id, result: { pageCount: doc.countPages() } })
    } else if (type === 'renderPage') {
      if (!doc) throw new Error('no document open')
      const page = doc.loadPage(params.pageIndex)
      try {
        const m = mupdf.Matrix.scale(params.scale, params.scale)
        const pix = page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false)
        const png = pix.asPNG()
        const w = pix.getWidth()
        const h = pix.getHeight()
        pix.destroy()
        // width/height in PDF points (pixels ÷ scale) so the view can size pages independent of zoom
        const buf = new Uint8Array(png).buffer
        self.postMessage({ id, result: { png: buf, width: w / params.scale, height: h / params.scale } }, [buf])
      } finally {
        page.destroy()
      }
    } else if (type === 'close') {
      doc?.destroy?.()
      doc = null
      self.postMessage({ id, result: null })
    } else {
      throw new Error('unknown request: ' + type)
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) })
  }
}
