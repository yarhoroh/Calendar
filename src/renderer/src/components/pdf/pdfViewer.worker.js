// Minimal MuPDF worker for the PDF viewer: open a document and render pages to PNG. Pure
// request/response — the renderer talks to it through pdfEngine.js. We rebuild the editor on top
// of this from scratch, one feature at a time, instead of the previous vendored engine.
import * as mupdf from 'mupdf'

let doc = null

// MuPDF loads via top-level await, so this module only finishes evaluating (and onmessage is
// installed) once WASM is ready. Tell the engine — it queues commands until it sees this, instead
// of firing them into the void while we were still loading.
self.postMessage({ ready: true })

self.onmessage = (e) => {
  const { id, type, params } = e.data
  try {
    if (type === 'open') {
      doc = mupdf.Document.openDocument(new Uint8Array(params.data), 'application/pdf')
      // Is the logical structure actually stored in the file? Tagged PDFs carry a structure tree
      // (/StructTreeRoot) + marked content (/MarkInfo /Marked). Untagged PDFs carry none — blocks
      // can only be reconstructed geometrically. Report which, so we know what we're working with.
      let tagged = false
      let marked = false
      try {
        const trailer = doc.getTrailer()
        const structRoot = trailer.get('Root', 'StructTreeRoot')
        tagged = !!(structRoot && !structRoot.isNull())
        const m = trailer.get('Root', 'MarkInfo', 'Marked')
        marked = !!(m && !m.isNull() && m.asBoolean())
      } catch (_) {
        // not a trailer-bearing PDF / no struct info — leave both false
      }
      self.postMessage({ id, result: { pageCount: doc.countPages(), tagged, marked } })
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
    } else if (type === 'getObjects') {
      // PDF content carries no paragraph/table structure, so MuPDF reconstructs it. Its `segment`
      // pass does a recursive page cut (XY-cut) and produces a tree of regions whose *leaves* are
      // the real semantic blocks — a paragraph stays whole, table cells split apart — which is what
      // Acrobat shows. That tree is dropped by walk() in this build but preserved by asJSON(), so we
      // read it from JSON. Images/vectors come from a separate walk() pass (turning vectors on
      // corrupts the segmented JSON into a sparse array).
      if (!doc) throw new Error('no document open')
      const page = doc.loadPage(params.pageIndex)
      try {
        const bounds = page.getBounds()
        const pageArea = Math.max(1, (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]))

        // Pass A — segmented text blocks (leaves of the structure tree)
        const textBlocks = []
        const fromBox = (b) => ({ x: b.x, y: b.y, width: b.w, height: b.h })
        let segStext = null
        try {
          segStext = page.toStructuredText('preserve-whitespace,segment')
          let parsed = null
          try {
            parsed = JSON.parse(segStext.asJSON())
          } catch (_) {
            parsed = null // malformed (e.g. sparse array) — fall back below
          }
          const hasText = (ln) => ln && ln.bbox && ((ln.text || '').trim().length > 0)
          const collect = (nodes) => {
            if (!Array.isArray(nodes)) return
            for (const n of nodes) {
              if (!n) continue
              if (n.type === 'text' && n.bbox) {
                const r = fromBox(n.bbox)
                const lines = (n.lines || []).filter(hasText) // drop whitespace-only lines
                // skip empty blocks: no real characters inside, only whitespace/nothing
                if (r.width > 0.5 && r.height > 0.5 && lines.length > 0) {
                  r.lines = lines.map((ln) => fromBox(ln.bbox))
                  textBlocks.push(r)
                }
              }
              if (n.contents) collect(n.contents)
              if (n.blocks) collect(n.blocks)
            }
          }
          if (parsed) collect(parsed.blocks || [])
        } finally {
          segStext?.destroy()
        }

        // Fallback — if segmentation produced nothing, use plain block grouping so we still show frames
        if (textBlocks.length === 0) {
          let plain = null
          try {
            plain = page.toStructuredText('preserve-whitespace')
            const toRect = (b) => ({ x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] })
            let cur = null
            plain.walk({
              beginTextBlock(bbox) {
                cur = { ...toRect(bbox), lines: [], _text: '' }
              },
              beginLine(bbox) {
                if (cur) cur.lines.push(toRect(bbox))
              },
              onChar(c) {
                if (cur) cur._text += c
              },
              endTextBlock() {
                // skip empty blocks — no real characters, only whitespace/nothing
                if (cur && cur.width > 0.5 && cur.height > 0.5 && cur._text.trim().length > 0) {
                  delete cur._text
                  textBlocks.push(cur)
                }
                cur = null
              },
            })
          } finally {
            plain?.destroy()
          }
        }

        // Pass B — images + vectors
        const images = []
        const vectors = []
        let stext = null
        try {
          stext = page.toStructuredText('preserve-images,vectors')
          const toRect = (b) => ({ x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] })
          stext.walk({
            onImageBlock(bbox) {
              const r = toRect(bbox)
              if (r.width > 0.5 && r.height > 0.5) images.push(r)
            },
            onVector(bbox, flags) {
              const r = toRect(bbox)
              // Drop page-sized shapes: clip paths / background fills Acrobat doesn't treat as objects.
              if (r.width * r.height > 0.9 * pageArea) return
              r.stroked = !!flags.isStroked
              r.rectangle = !!flags.isRectangle
              vectors.push(r)
            },
          })
        } finally {
          stext?.destroy()
        }

        self.postMessage({ id, result: { textBlocks, images, vectors } })
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
