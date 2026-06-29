/// <reference lib="webworker" />
/**
 * The one and only module that talks to MuPDF. It owns a single open document
 * and answers protocol requests. Everything CPU-heavy (parsing, rendering)
 * happens here, off the UI thread.
 */
import * as mupdf from 'mupdf';
import type {
  EmbeddedFont,
  FormField,
  ImageBlock,
  Rect as PublicRect,
  TextBlock,
  TextLine,
  TextSpan,
  VectorPath,
  VectorSeg,
} from '../types.js';
import type {
  RequestEnvelope,
  ResponseEnvelope,
  WorkerRequestMap,
  WorkerRequestType,
} from './protocol.js';

declare const self: DedicatedWorkerGlobalScope & typeof globalThis;

let doc: mupdf.PDFDocument | null = null;

function requireDoc(): mupdf.PDFDocument {
  if (!doc) throw new Error('No document is open');
  return doc;
}

/** Public {x,y,w,h} (top-left) -> MuPDF [x0,y0,x1,y1]. */
function toMupdfRect(r: PublicRect): mupdf.Rect {
  return [r.x, r.y, r.x + r.width, r.y + r.height];
}

/** MuPDF [x0,y0,x1,y1] -> public {x,y,width,height}. */
function fromMupdfRect(r: mupdf.Rect): PublicRect {
  return { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] };
}

/** Copy a WASM-heap-backed view into a standalone, transferable ArrayBuffer. */
function detach(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer as ArrayBuffer;
}

/** Bounding box (PDF points) of a set of glyph quads. */
function unionQuads(quads: number[][]): PublicRect {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const q of quads) {
    for (let i = 0; i < q.length; i += 2) {
      x0 = Math.min(x0, q[i]);
      x1 = Math.max(x1, q[i]);
      y0 = Math.min(y0, q[i + 1]);
      y1 = Math.max(y1, q[i + 1]);
    }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** MuPDF char color (gray/rgb/cmyk) -> RGB 0..1. */
function normColor(c: number[]): [number, number, number] {
  if (!c || c.length === 0) return [0, 0, 0];
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 3) return [c[0], c[1], c[2]];
  if (c.length === 4) {
    const [cy, m, y, k] = c;
    return [(1 - cy) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  }
  return [0, 0, 0];
}

/** Apply a 2x3 matrix [a,b,c,d,e,f] to a point. */
function applyMatrix(m: mupdf.Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Average absolute scale factor of a matrix (for stroke-width mapping). */
function matrixScale(m: mupdf.Matrix): number {
  return (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;
}

/** Walk a path into device-space segments (top-left points). */
function pathToSegs(path: mupdf.Path, ctm: mupdf.Matrix): VectorSeg[] {
  const segs: VectorSeg[] = [];
  path.walk({
    moveTo(x, y) {
      segs.push({ op: 'M', pts: applyMatrix(ctm, x, y) });
    },
    lineTo(x, y) {
      segs.push({ op: 'L', pts: applyMatrix(ctm, x, y) });
    },
    curveTo(x1, y1, x2, y2, x3, y3) {
      const a = applyMatrix(ctm, x1, y1);
      const b = applyMatrix(ctm, x2, y2);
      const c = applyMatrix(ctm, x3, y3);
      segs.push({ op: 'C', pts: [a[0], a[1], b[0], b[1], c[0], c[1]] });
    },
    closePath() {
      segs.push({ op: 'Z', pts: [] });
    },
  });
  return segs;
}

/** Axis-aligned bounds of path segments, padded by half the stroke width. */
function segsBounds(segs: VectorSeg[], strokeWidth: number): PublicRect {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of segs) {
    for (let i = 0; i < s.pts.length; i += 2) {
      x0 = Math.min(x0, s.pts[i]);
      x1 = Math.max(x1, s.pts[i]);
      y0 = Math.min(y0, s.pts[i + 1]);
      y1 = Math.max(y1, s.pts[i + 1]);
    }
  }
  if (!isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
  const p = strokeWidth / 2;
  return { x: x0 - p, y: y0 - p, width: x1 - x0 + strokeWidth, height: y1 - y0 + strokeWidth };
}

/** Pick the closest standard PDF appearance font for a style. */
function daFont(serif: boolean, bold: boolean, italic: boolean): string {
  if (serif) return bold && italic ? 'TiBI' : bold ? 'TiBo' : italic ? 'TiIt' : 'TiRo';
  return bold && italic ? 'HeBO' : bold ? 'HeBo' : italic ? 'HeOb' : 'Helv';
}

function median(nums: number[]): number {
  if (!nums.length) return 12;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Most frequent value in a list (by string key), for the dominant style. */
function mostCommon<T>(items: T[], key: (item: T) => string, fallback: T): T {
  if (!items.length) return fallback;
  const counts = new Map<string, { item: T; n: number }>();
  for (const item of items) {
    const k = key(item);
    const e = counts.get(k);
    if (e) e.n++;
    else counts.set(k, { item, n: 1 });
  }
  let best = items[0];
  let bn = 0;
  for (const { item, n } of counts.values()) {
    if (n > bn) {
      bn = n;
      best = item;
    }
  }
  return best;
}

/** Locate a widget by field name across all pages. */
function findWidget(name: string): mupdf.PDFWidget | null {
  const pdf = requireDoc();
  const count = pdf.countPages();
  for (let i = 0; i < count; i++) {
    const page = pdf.loadPage(i);
    try {
      for (const widget of page.getWidgets()) {
        if (widget.getName() === name) return widget;
      }
    } finally {
      page.destroy();
    }
  }
  return null;
}

const handlers: {
  [T in WorkerRequestType]: (
    params: WorkerRequestMap[T]['params'],
  ) => WorkerRequestMap[T]['result'] | Promise<WorkerRequestMap[T]['result']>;
} = {
  open: ({ data }) => {
    doc?.destroy();
    doc = null;
    const opened = mupdf.Document.openDocument(new Uint8Array(data), 'application/pdf');
    const pdf = opened.asPDF();
    if (!pdf) {
      opened.destroy();
      throw new Error('File is not a PDF document');
    }
    doc = pdf;
    return {
      pageCount: pdf.countPages(),
      title: pdf.getMetaData(mupdf.Document.META_INFO_TITLE) ?? '',
    };
  },

  getPageCount: () => requireDoc().countPages(),

  renderPage: ({ pageIndex, scale }) => {
    const page = requireDoc().loadPage(pageIndex);
    let pixmap: mupdf.Pixmap | null = null;
    try {
      pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
      const png = detach(pixmap.asPNG());
      return {
        pageIndex,
        width: pixmap.getWidth(),
        height: pixmap.getHeight(),
        png,
      };
    } finally {
      pixmap?.destroy();
      page.destroy();
    }
  },

  getPageText: ({ pageIndex }) => {
    const page = requireDoc().loadPage(pageIndex);
    let stext: mupdf.StructuredText | null = null;
    try {
      stext = page.toStructuredText('preserve-whitespace');
      const json = JSON.parse(stext.asJSON()) as StructuredTextJSON;
      const spans: TextSpan[] = [];
      for (const block of json.blocks ?? []) {
        if (block.type && block.type !== 'text') continue;
        for (const line of block.lines ?? []) {
          const bbox = line.bbox ?? block.bbox;
          if (!bbox || !line.text) continue;
          spans.push({
            text: line.text,
            bbox: { x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h },
          });
        }
      }
      return spans;
    } finally {
      stext?.destroy();
      page.destroy();
    }
  },

  getTextLayout: ({ pageIndex }) => {
    const page = requireDoc().loadPage(pageIndex);
    let stext: mupdf.StructuredText | null = null;
    try {
      stext = page.toStructuredText('preserve-whitespace');
      const lines: TextLine[] = [];
      type RunAcc = {
        chars: string[];
        quads: number[][];
        fontName: string;
        fontSize: number;
        bold: boolean;
        italic: boolean;
        serif: boolean;
        color: number[];
      };
      let cur: { runs: RunAcc[]; runKey: string; quads: number[][]; bases: number[] } | null = null;
      stext.walk({
        beginLine() {
          cur = { runs: [], runKey: '', quads: [], bases: [] };
        },
        onChar(c, origin, font, size, quad, color) {
          if (!cur) return;
          const name = font.getName();
          const bold = font.isBold() || /bold|black|heavy|semibold/i.test(name);
          const italic = font.isItalic() || /italic|oblique/i.test(name);
          // Start a new run whenever the style changes mid-line (font / size / colour / weight / slant).
          const key = `${name}|${Math.round(size * 10)}|${color.join(',')}|${bold ? 'b' : ''}|${italic ? 'i' : ''}`;
          let run = cur.runs[cur.runs.length - 1];
          if (!run || cur.runKey !== key) {
            run = { chars: [], quads: [], fontName: name, fontSize: size, bold, italic, serif: font.isSerif(), color };
            cur.runs.push(run);
            cur.runKey = key;
          }
          run.chars.push(c);
          run.quads.push(quad);
          cur.quads.push(quad);
          cur.bases.push(origin[1]); // glyph baseline Y (top-left page space) — exact vertical anchor
        },
        endLine() {
          if (cur && cur.runs.length) {
            const text = cur.runs.map((r) => r.chars.join('')).join('');
            if (text.trim()) {
              // Dominant run (most chars) supplies the line's single-style back-compat fields.
              const dom = cur.runs.reduce((a, b) => (b.chars.length > a.chars.length ? b : a));
              lines.push({
                text,
                bbox: unionQuads(cur.quads),
                baseline: median(cur.bases),
                fontSize: dom.fontSize,
                color: normColor(dom.color),
                bold: dom.bold,
                italic: dom.italic,
                serif: dom.serif,
                fontName: dom.fontName,
                runs: cur.runs.map((r) => ({
                  text: r.chars.join(''),
                  fontName: r.fontName,
                  fontSize: r.fontSize,
                  bold: r.bold,
                  italic: r.italic,
                  serif: r.serif,
                  color: normColor(r.color),
                  bbox: unionQuads(r.quads),
                })),
              });
            }
          }
          cur = null;
        },
      });
      return lines;
    } finally {
      stext?.destroy();
      page.destroy();
    }
  },

  getTextBlocks: ({ pageIndex }) => {
    const page = requireDoc().loadPage(pageIndex);
    let stext: mupdf.StructuredText | null = null;
    try {
      stext = page.toStructuredText('preserve-whitespace');
      const blocks: TextBlock[] = [];
      let block: {
        lines: string[];
        line: string[] | null;
        quads: number[][];
        sizes: number[];
        colors: number[][];
        names: string[];
        serif: number;
        bold: number;
        italic: number;
        count: number;
      } | null = null;
      stext.walk({
        beginTextBlock() {
          block = {
            lines: [],
            line: null,
            quads: [],
            sizes: [],
            colors: [],
            names: [],
            serif: 0,
            bold: 0,
            italic: 0,
            count: 0,
          };
        },
        beginLine() {
          if (block) block.line = [];
        },
        onChar(c, _origin, font, size, quad, color) {
          if (!block || !block.line) return;
          block.line.push(c);
          block.quads.push(quad);
          block.sizes.push(size);
          block.colors.push(color);
          block.names.push(font.getName());
          if (font.isSerif()) block.serif++;
          if (font.isBold()) block.bold++;
          if (font.isItalic()) block.italic++;
          block.count++;
        },
        endLine() {
          if (block && block.line) {
            block.lines.push(block.line.join(''));
            block.line = null;
          }
        },
        endTextBlock() {
          if (block && block.lines.length) {
            const text = block.lines.join('\n');
            if (text.trim()) {
              blocks.push({
                text,
                bbox: unionQuads(block.quads),
                fontSize: median(block.sizes),
                color: normColor(mostCommon(block.colors, (c) => c.join(','), [0, 0, 0])),
                bold: block.bold * 2 > block.count,
                italic: block.italic * 2 > block.count,
                serif: block.serif * 2 > block.count,
                fontName: mostCommon(block.names, (n) => n, ''),
              });
            }
          }
          block = null;
        },
      });
      return blocks;
    } finally {
      stext?.destroy();
      page.destroy();
    }
  },

  // Every image drawn on the page, with its placement box + PNG bytes. Used on open so a
  // baked/embedded picture (e.g. a vector flattened on save) becomes a selectable object again.
  getImages: ({ pageIndex }) => {
    const page = requireDoc().loadPage(pageIndex);
    const out: ImageBlock[] = [];
    let stext: mupdf.StructuredText | null = null;
    try {
      // 'preserve-images' is REQUIRED — without it structured text omits image blocks entirely and
      // onImageBlock never fires, so no picture (incl. a baked vector) is ever extracted.
      stext = page.toStructuredText('preserve-whitespace,preserve-images');
      stext.walk({
        onImageBlock(bbox, _matrix, image) {
          let pix: mupdf.Pixmap | null = null;
          let rgb: mupdf.Pixmap | null = null;
          try {
            pix = image.toPixmap();
            // Force RGB(A): a native CMYK / indexed / gray pixmap produces a PNG the browser won't
            // load as an <img> (the "broken image" icon), so always convert before encoding.
            rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
            const png = rgb.asPNG();
            out.push({ bbox: fromMupdfRect(bbox), png: detach(new Uint8Array(png)) });
          } catch {
            /* undecodable image — skip it rather than fail the whole extract */
          } finally {
            rgb?.destroy();
            pix?.destroy();
          }
        },
      });
    } finally {
      stext?.destroy();
      page.destroy();
    }
    return out;
  },

  getVectorPaths: ({ pageIndex }) => {
    const page = requireDoc().loadPage(pageIndex);
    const bounds = fromMupdfRect(page.getBounds());
    const pageArea = Math.max(1, bounds.width * bounds.height);
    const out: VectorPath[] = [];
    let device: mupdf.Device | null = null;
    try {
      const capture = (
        path: mupdf.Path,
        ctm: mupdf.Matrix,
        kind: 'fill' | 'stroke',
        color: number[],
        alpha: number,
        evenOdd: boolean,
        stroke: mupdf.StrokeState | null,
      ) => {
        if (out.length >= 4000) return;
        const segs = pathToSegs(path, ctm);
        if (!segs.length) return;
        const width = stroke ? stroke.getLineWidth() * matrixScale(ctm) : 0;
        const bbox = segsBounds(segs, width);
        // Skip only a TRUE full-page background fill, and sub-pixel noise. Loosened
        // so large panels (not quite full-page) and small marks still become
        // selectable zones — the count reflects the PDF's real shapes either way.
        if (kind === 'fill' && bbox.width * bbox.height > pageArea * 0.97) return;
        if (bbox.width < 0.2 && bbox.height < 0.2) return;
        out.push({
          segs,
          bbox,
          fill: kind === 'fill' ? normColor(color) : null,
          stroke: kind === 'stroke' ? normColor(color) : null,
          strokeWidth: width,
          evenOdd,
          alpha,
        });
      };
      device = new mupdf.Device({
        fillPath(path, evenOdd, ctm, _cs, color, alpha) {
          capture(path, ctm, 'fill', color, alpha, evenOdd, null);
        },
        strokePath(path, stroke, ctm, _cs, color, alpha) {
          capture(path, ctm, 'stroke', color, alpha, false, stroke);
        },
      });
      page.run(device, mupdf.Matrix.identity);
      device.close();
    } finally {
      device?.destroy();
      page.destroy();
    }
    return out;
  },

  replaceLine: ({ pageIndex, bbox, text, fontSize, color, bold, italic, serif }) => {
    const page = requireDoc().loadPage(pageIndex);
    try {
      const redact = page.createAnnotation('Redact');
      redact.setRect(toMupdfRect(bbox));
      page.applyRedactions(false);

      const annot = page.createAnnotation('FreeText');
      annot.setRect(toMupdfRect(bbox));
      annot.setContents(text);
      annot.setDefaultAppearance(daFont(serif, bold, italic), fontSize, color);
      annot.setBorderWidth(0);
      annot.update();
    } finally {
      page.destroy();
    }
    return null;
  },

  getFormFields: () => {
    const pdf = requireDoc();
    const fields: FormField[] = [];
    const count = pdf.countPages();
    for (let i = 0; i < count; i++) {
      const page = pdf.loadPage(i);
      try {
        for (const widget of page.getWidgets()) {
          fields.push({
            name: widget.getName(),
            type: widget.getFieldType(),
            value: widget.getValue(),
            pageIndex: i,
            rect: fromMupdfRect(widget.getRect()),
          });
        }
      } finally {
        page.destroy();
      }
    }
    return fields;
  },

  setFormField: ({ name, value }) => {
    const widget = findWidget(name);
    if (!widget) throw new Error(`Form field not found: ${name}`);
    if (widget.isText()) {
      widget.setTextValue(value);
    } else if (widget.isChoice()) {
      widget.setChoiceValue(value);
    } else if (widget.isCheckbox() || widget.isRadioButton()) {
      widget.toggle();
    } else {
      throw new Error(`Unsupported field type: ${widget.getFieldType()}`);
    }
    widget.update();
    return null;
  },

  addTextOverlay: ({ pageIndex, rect, text, fontSize, color, bold, italic, serif }) => {
    const page = requireDoc().loadPage(pageIndex);
    try {
      const annot = page.createAnnotation('FreeText');
      annot.setRect(toMupdfRect(rect));
      annot.setContents(text);
      annot.setDefaultAppearance(
        daFont(serif ?? false, bold ?? false, italic ?? false),
        fontSize ?? 12,
        color ?? [0, 0, 0],
      );
      annot.setBorderWidth(0); // clean text, no FreeText box outline
      annot.update();
    } finally {
      page.destroy();
    }
    return null;
  },

  insertImage: ({ pageIndex, rect, data }) => {
    const page = requireDoc().loadPage(pageIndex);
    try {
      const image = new mupdf.Image(new Uint8Array(data));
      const annot = page.createAnnotation('Stamp');
      annot.setRect(toMupdfRect(rect));
      annot.setStampImage(image);
      annot.update();
    } finally {
      page.destroy();
    }
    return null;
  },

  getDocumentFonts: () => {
    const pdf = requireDoc();
    const names = new Set<string>();
    const count = pdf.countPages();
    for (let i = 0; i < count; i++) {
      const page = pdf.loadPage(i);
      let stext: mupdf.StructuredText | null = null;
      try {
        stext = page.toStructuredText('preserve-whitespace');
        stext.walk({
          onChar(_c, _origin, font) {
            names.add(font.getName());
          },
        });
      } finally {
        stext?.destroy();
        page.destroy();
      }
    }
    return [...names];
  },

  // Pull the actual font programs embedded in the PDF, so edited text can render
  // with the real source font (one-to-one) instead of a CSS substitute. Walks
  // each page's font resources down to FontDescriptor → FontFile2/FontFile3 and
  // reads the decoded stream bytes.
  getEmbeddedFonts: () => {
    const pdf = requireDoc();
    const out: EmbeddedFont[] = [];
    const seen = new Set<string>(); // dedupe by BaseFont name

    // `.resolve()` on the shared null object throws (its _doc is null), and
    // `_get` returns that null object for any missing key — so never resolve a
    // null. This guard is why the whole walk used to throw and silently yield
    // nothing (every simple font hit a missing DescendantFonts).
    const deref = (o: mupdf.PDFObject) => (o.isNull() ? o : o.resolve());

    const collect = (fontDict: mupdf.PDFObject) => {
      if (!fontDict.isDictionary()) return;
      // Composite (Type0) fonts carry the descriptor on a descendant font.
      let descHolder = fontDict;
      const df = deref(fontDict.get('DescendantFonts'));
      if (df.isArray()) {
        const first = deref(df.get(0));
        if (first.isDictionary()) descHolder = first;
      }
      const desc = deref(descHolder.get('FontDescriptor'));
      if (!desc.isDictionary()) return;

      // Streams are indirect objects: `isStream()` and `readStream()` only work
      // on the reference itself — after `.resolve()` the stream-ness is lost and
      // readStream throws. So DON'T deref FontFile here (only deref the dict to
      // read its Subtype).
      let file = desc.get('FontFile2'); // TrueType
      let format: EmbeddedFont['format'] = 'truetype';
      if (!file.isStream()) {
        const f3 = desc.get('FontFile3'); // CFF or OpenType
        if (f3.isStream()) {
          const sub = deref(f3).get('Subtype');
          // OpenType is browser-loadable as-is; a bare CFF (Type1C /
          // CIDFontType0C) is flagged so the main thread can wrap it.
          format = sub.isName() && sub.asName() === 'OpenType' ? 'opentype' : 'cff';
          file = f3;
        }
      }
      if (!file.isStream()) return; // Type1 (FontFile) or not embedded
      const baseObj = fontDict.get('BaseFont');
      const name = baseObj.isName() ? baseObj.asName() : '';
      if (!name || seen.has(name)) return;
      seen.add(name);
      let buffer: mupdf.Buffer | null = null;
      try {
        buffer = file.readStream(); // decodes stream filters; may throw if corrupt
        out.push({ name, format, data: detach(buffer.asUint8Array()) });
      } catch {
        /* a font whose program can't be decoded just falls back to a substitute */
      } finally {
        buffer?.destroy();
      }
    };

    const count = pdf.countPages();
    for (let i = 0; i < count; i++) {
      const res = deref(pdf.findPage(i).getInheritable('Resources'));
      if (!res.isDictionary()) continue;
      const fonts = deref(res.get('Font'));
      if (!fonts.isDictionary()) continue;
      fonts.forEach((val: mupdf.PDFObject) => collect(deref(val)));
    }
    return out;
  },

  redactRect: ({ pageIndex, rect }) => {
    const page = requireDoc().loadPage(pageIndex);
    try {
      const annot = page.createAnnotation('Redact');
      annot.setRect(toMupdfRect(rect));
      page.applyRedactions(false);
    } finally {
      page.destroy();
    }
    return null;
  },

  redactLineArt: ({ pageIndex, rect }) => {
    const page = requireDoc().loadPage(pageIndex);
    try {
      const annot = page.createAnnotation('Redact');
      annot.setRect(toMupdfRect(rect));
      // Remove only vector line-art fully covered by the box; keep text & images
      // (so a frame around text erases without taking the text with it).
      page.applyRedactions(
        false,
        mupdf.PDFPage.REDACT_IMAGE_NONE,
        mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
        mupdf.PDFPage.REDACT_TEXT_NONE,
      );
    } finally {
      page.destroy();
    }
    return null;
  },

  redactLineArtBatch: ({ pageIndex, rects }) => {
    const page = requireDoc().loadPage(pageIndex);
    try {
      for (const rect of rects) {
        const annot = page.createAnnotation('Redact');
        annot.setRect(toMupdfRect(rect));
      }
      // One pass removes every covered vector path; text & images are preserved.
      page.applyRedactions(
        false,
        mupdf.PDFPage.REDACT_IMAGE_NONE,
        mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
        mupdf.PDFPage.REDACT_TEXT_NONE,
      );
    } finally {
      page.destroy();
    }
    return null;
  },

  redactText: ({ pageIndex, rect }) => {
    const page = requireDoc().loadPage(pageIndex);
    try {
      const annot = page.createAnnotation('Redact');
      annot.setRect(toMupdfRect(rect));
      // Remove ONLY the text glyphs covered by the box; keep images and vector
      // line-art (so lifting a line out of the page leaves the coloured/imaged
      // background behind it intact, instead of punching a white hole).
      page.applyRedactions(
        false,
        mupdf.PDFPage.REDACT_IMAGE_NONE,
        mupdf.PDFPage.REDACT_LINE_ART_NONE,
        mupdf.PDFPage.REDACT_TEXT_REMOVE,
      );
    } finally {
      page.destroy();
    }
    return null;
  },

  fillRect: ({ pageIndex, rect, color }) => {
    const page = requireDoc().loadPage(pageIndex);
    try {
      // A borderless filled Square annotation acts as a solid background block.
      const annot = page.createAnnotation('Square');
      annot.setRect(toMupdfRect(rect));
      annot.setInteriorColor(color);
      annot.setColor(color);
      annot.setBorderWidth(0);
      annot.update();
    } finally {
      page.destroy();
    }
    return null;
  },

  save: ({ mode }) => {
    const pdf = requireDoc();
    // Our edits are added as FreeText / Stamp annotations. Flatten ("bake") them into the page
    // content so that on reopen they re-extract as real page text/graphics and stay editable —
    // otherwise they live on as annotations that the extractor (getTextLayout/getVectorPaths)
    // ignores, and every saved change becomes un-selectable. (widgets kept interactive.)
    pdf.bake(true, false);
    const incremental = mode === 'incremental' && pdf.canBeSavedIncrementally();
    const options = incremental ? { incremental: true } : { compress: true };
    const buffer = pdf.saveToBuffer(options);
    try {
      return detach(buffer.asUint8Array());
    } finally {
      buffer.destroy();
    }
  },

  close: () => {
    doc?.destroy();
    doc = null;
    return null;
  },
};

/** Result fields that must be transferred (not copied) back to the main thread. */
function transferablesFor(type: WorkerRequestType, result: unknown): Transferable[] {
  if (type === 'renderPage') return [(result as { png: ArrayBuffer }).png];
  if (type === 'save') return [result as ArrayBuffer];
  if (type === 'getEmbeddedFonts') {
    return (result as EmbeddedFont[]).map((f) => f.data);
  }
  return [];
}

self.onmessage = async (event: MessageEvent<RequestEnvelope>) => {
  const { id, type, params } = event.data;
  try {
    const handler = handlers[type] as (p: unknown) => unknown | Promise<unknown>;
    const result = await handler(params);
    const response: ResponseEnvelope = { id, ok: true, result };
    self.postMessage(response, transferablesFor(type, result));
  } catch (err) {
    const response: ResponseEnvelope = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};

// Importing `mupdf` initializes the WASM module; signal the facade we're live.
self.postMessage({ type: '__ready__' });

// ---- shape of StructuredText.asJSON() output ----
interface StructuredTextJSON {
  blocks?: Array<{
    type?: string;
    bbox?: { x: number; y: number; w: number; h: number };
    lines?: Array<{
      text?: string;
      bbox?: { x: number; y: number; w: number; h: number };
    }>;
  }>;
}
