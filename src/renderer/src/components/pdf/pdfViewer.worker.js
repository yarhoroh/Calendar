// Minimal MuPDF worker for the PDF viewer: open a document and render pages to PNG. Pure
// request/response — the renderer talks to it through pdfEngine.js. We rebuild the editor on top
// of this from scratch, one feature at a time, instead of the previous vendored engine.
import * as mupdf from 'mupdf'
import {
  colorToHex,
  collectPalette,
  buildBlock,
  splitTableBlock,
  computeParagraphSpacing,
  documentLineSpacing,
  markUnderlines,
} from './pdfModel.js'

let doc = null

const stripSubset = (n) => (n || '').replace(/^[A-Z]{6}\+/, '')

// Parse a TrueType/OpenType `name` table to recover the real font names that BaseFont may hide
// behind a generic id (e.g. "CIDFont+F1"). Returns { family, full, post } or null.
function parseSfntName(buf) {
  try {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const numTables = dv.getUint16(4)
    let nameOff = -1
    for (let i = 0; i < numTables; i++) {
      const r = 12 + i * 16
      if (String.fromCharCode(buf[r], buf[r + 1], buf[r + 2], buf[r + 3]) === 'name') nameOff = dv.getUint32(r + 8)
    }
    if (nameOff < 0) return null
    const count = dv.getUint16(nameOff + 2)
    const strOff = nameOff + dv.getUint16(nameOff + 4)
    const res = {}
    for (let i = 0; i < count; i++) {
      const r = nameOff + 6 + i * 12
      const plat = dv.getUint16(r)
      const nameID = dv.getUint16(r + 6)
      const len = dv.getUint16(r + 8)
      const off = dv.getUint16(r + 10)
      let s = ''
      if (plat === 3 || plat === 0) {
        for (let j = 0; j + 1 < len; j += 2) s += String.fromCharCode((buf[strOff + off + j] << 8) | buf[strOff + off + j + 1])
      } else {
        for (let j = 0; j < len; j++) s += String.fromCharCode(buf[strOff + off + j])
      }
      if (nameID === 1 && !res.family) res.family = s
      else if (nameID === 4 && !res.full) res.full = s
      else if (nameID === 6 && !res.post) res.post = s
    }
    return res
  } catch (_) {
    return null
  }
}

// Read every font resource from the PDF dictionary: real BaseFont name (subset tag stripped),
// whether the font file is embedded (FontFile/FontFile2/FontFile3), subtype, descriptor flags and
// metrics. This is the foundation for font substitution — knowing what's actually in the file.
function extractFontResources(document) {
  const out = []
  const seen = new Set()
  let count = 0
  try {
    count = document.countObjects()
  } catch (_) {
    return out
  }
  for (let i = 1; i < count; i++) {
    let obj = null
    try {
      obj = document.newIndirect(i).resolve()
    } catch (_) {
      continue
    }
    if (!obj || !obj.isDictionary || !obj.isDictionary()) continue
    let typ = null
    try {
      typ = obj.get('Type')
    } catch (_) {
      continue
    }
    if (!typ || typ.isNull() || typ.asName() !== 'Font') continue
    const bf = obj.get('BaseFont')
    if (bf.isNull()) continue
    const baseFont = bf.asName()
    if (seen.has(baseFont)) continue
    seen.add(baseFont)
    const subtype = obj.get('Subtype').isNull() ? '' : obj.get('Subtype').asName()
    // descriptor: directly, or via DescendantFonts[0] for Type0
    let descr = obj.get('FontDescriptor')
    if (descr.isNull()) {
      const df = obj.get('DescendantFonts')
      if (df.isArray() && df.length > 0) descr = df.get(0).resolve().get('FontDescriptor')
    }
    let embedded = false
    let flags = 0
    let realName = null
    const m = {}
    if (descr && !descr.isNull()) {
      embedded =
        !descr.get('FontFile').isNull() || !descr.get('FontFile2').isNull() || !descr.get('FontFile3').isNull()
      if (!descr.get('Flags').isNull()) flags = descr.get('Flags').asNumber()
      const num = (k) => {
        const v = descr.get(k)
        return v && !v.isNull() ? v.asNumber() : null
      }
      m.ascent = num('Ascent')
      m.descent = num('Descent')
      m.capHeight = num('CapHeight')
      m.xHeight = num('XHeight')
      m.italicAngle = num('ItalicAngle')
      m.stemV = num('StemV')
      // recover the real name from the embedded TrueType file when BaseFont is generic
      const ff2 = descr.get('FontFile2')
      if (!ff2.isNull()) {
        try {
          const nm = parseSfntName(ff2.readStream().asUint8Array())
          if (nm) realName = nm.full || nm.family || nm.post
        } catch (_) {
          // unreadable font file — keep BaseFont
        }
      }
    }
    out.push({
      name: realName || stripSubset(baseFont),
      baseFont,
      subtype,
      subset: /^[A-Z]{6}\+/.test(baseFont),
      embedded,
      flags,
      serif: !!(flags & 2), // bit 2 = Serif
      mono: !!(flags & 1), // bit 1 = FixedPitch
      italic: !!(flags & 64) || (m.italicAngle != null && m.italicAngle !== 0), // bit 7 = Italic
      bold: !!(flags & 262144), // bit 19 = ForceBold
      ...m,
    })
  }
  return out
}

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
    } else if (type === 'getModel') {
      // Rich-text model of the page. Style (font/color/bold/italic) and structure come from MuPDF's
      // structured text, but the FONT SIZE comes from a Device pass: MuPDF's stext size mixes in each
      // font's FontMatrix and is inconsistent, whereas the glyph's text-render-matrix × ctm gives the
      // true size Acrobat shows. Blocks use plain `preserve-whitespace` grouping (whole paragraphs).
      if (!doc) throw new Error('no document open')
      const page = doc.loadPage(params.pageIndex)
      try {
        const bounds = page.getBounds()
        const pageArea = Math.max(1, (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]))
        const toRect = (b) => ({ x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] })
        const quadBounds = (q) => {
          const xs = [q[0], q[2], q[4], q[6]]
          const ys = [q[1], q[3], q[5], q[7]]
          return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
        }

        // Pass 0 — Device pass. Device callbacks fire in CONTENT-STREAM ORDER (= true paint order /
        // z), which stext discards. We capture per glyph: exact size + horizontal scale (from the
        // render matrix × ctm) AND a paint index z. Vectors/images also get a z + bbox so we can sort
        // every object by stacking order later (needed to keep overlaps right when editing).
        const metricsMap = new Map()
        const vecZ = []
        const imgZ = []
        let seq = 0
        const concat = (A, B) => [
          A[0] * B[0] + A[1] * B[2],
          A[0] * B[1] + A[1] * B[3],
          A[2] * B[0] + A[3] * B[2],
          A[2] * B[1] + A[3] * B[3],
          A[4] * B[0] + A[5] * B[2] + B[4],
          A[4] * B[1] + A[5] * B[3] + B[5],
        ]
        const pathZ = (path, stroke, ctm) => {
          try {
            const b = path.getBounds(stroke, ctm)
            vecZ.push({ cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, z: ++seq })
          } catch (_) {
            seq++
          }
        }
        let dev = null
        try {
          dev = new mupdf.Device({
            fillText(text, ctm) {
              const z = ++seq
              text.walk({
                showGlyph(font, trm) {
                  const m = concat(trm, ctm)
                  const vert = Math.hypot(m[2], m[3])
                  const horiz = Math.hypot(m[0], m[1])
                  metricsMap.set(Math.round(m[4]) + ',' + Math.round(m[5]), { size: vert, hScale: vert > 0 ? horiz / vert : 1, z })
                },
              })
            },
            fillPath(path, evenOdd, ctm) {
              pathZ(path, null, ctm)
            },
            strokePath(path, stroke, ctm) {
              pathZ(path, stroke, ctm)
            },
            fillImage(image, ctm) {
              // image fills a unit square transformed by ctm
              imgZ.push({ cx: ctm[4] + ctm[0] / 2, cy: ctm[5] + ctm[3] / 2, z: ++seq })
            },
            fillShade() {
              seq++
            },
          })
          page.run(dev, mupdf.Matrix.identity)
        } catch (_) {
          // Device unavailable — sizes fall back to stext, z stays undefined
        } finally {
          dev?.close?.()
        }
        const exactAt = (ox, oy) => metricsMap.get(Math.round(ox) + ',' + Math.round(oy))
        // nearest paint-order z for a rect, by centre distance
        const nearestZ = (list, r) => {
          const cx = r.x + r.width / 2
          const cy = r.y + r.height / 2
          let best = null
          let bd = Infinity
          for (const e of list) {
            const d = (e.cx - cx) ** 2 + (e.cy - cy) ** 2
            if (d < bd) {
              bd = d
              best = e
            }
          }
          return best ? best.z : undefined
        }

        // Pass A — text blocks → lines → chars (style + exact size + baseline)
        const blocks = []
        let docLineSpacing = null
        let stextT = null
        try {
          stextT = page.toStructuredText('preserve-whitespace')
          const rawBlocks = []
          let curB = null
          let curL = null
          stextT.walk({
            beginTextBlock(bbox) {
              curB = { ...toRect(bbox), lines: [] }
              rawBlocks.push(curB)
            },
            beginLine(bbox) {
              curL = { ...toRect(bbox), chars: [] }
              if (curB) curB.lines.push(curL)
            },
            onChar(c, origin, font, size, quad, color) {
              if (!curL) return
              const b = quadBounds(quad)
              const ex = exactAt(origin[0], origin[1])
              curL.chars.push({
                c,
                fontName: font.getName(),
                size: ex ? ex.size : size,
                hScale: ex ? ex.hScale : 1,
                bold: font.isBold(),
                italic: font.isItalic(),
                serif: font.isSerif(),
                mono: font.isMono(),
                color: colorToHex(color),
                z: ex ? ex.z : undefined,
                ox: origin[0],
                oy: origin[1],
                x0: b.x0,
                y0: b.y0,
                x1: b.x1,
                y1: b.y1,
              })
            },
            endLine() {
              curL = null
            },
            endTextBlock() {
              curB = null
            },
          })
          for (const rb of rawBlocks) {
            const blk = buildBlock(rb)
            if (blk) blocks.push(...splitTableBlock(blk)) // table rows → one object per cell
          }
          docLineSpacing = documentLineSpacing(blocks)
          computeParagraphSpacing(blocks, docLineSpacing)
        } finally {
          stextT?.destroy()
        }

        // Pass B — images + vectors (frames + underline detection)
        const images = []
        const vectors = []
        let stextV = null
        try {
          stextV = page.toStructuredText('preserve-images,vectors')
          stextV.walk({
            onImageBlock(bbox) {
              const r = toRect(bbox)
              if (r.width > 0.5 && r.height > 0.5) {
                r.z = nearestZ(imgZ, r)
                images.push(r)
              }
            },
            onVector(bbox, flags) {
              const r = toRect(bbox)
              if (r.width * r.height > 0.9 * pageArea) return
              r.stroked = !!flags.isStroked
              r.rectangle = !!flags.isRectangle
              r.z = nearestZ(vecZ, r)
              vectors.push(r)
            },
          })
        } finally {
          stextV?.destroy()
        }
        markUnderlines(blocks, vectors)

        const fontResources = extractFontResources(doc)
        // relabel runs from generic stext ids (CIDFont+F2) to real names (Arial) via BaseFont
        const nameMap = new Map()
        for (const fr of fontResources) if (fr.baseFont) nameMap.set(fr.baseFont, fr.name)
        if (nameMap.size) {
          for (const b of blocks) for (const ln of b.lines) for (const r of ln.runs) {
            const real = nameMap.get(r.fontName)
            if (real) r.fontName = real
          }
        }
        const palette = collectPalette(blocks)
        self.postMessage({
          id,
          result: {
            blocks,
            images,
            vectors,
            fonts: fontResources.length ? fontResources : palette.fonts,
            colors: palette.colors,
            docLineSpacing,
          },
        })
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
