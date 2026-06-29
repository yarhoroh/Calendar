/**
 * Public, framework-agnostic types for the PDF editor core.
 * Nothing here depends on MuPDF, React, or the DOM transport — these are the
 * stable contract that consumers (and the worker) agree on.
 */

/** Raw PDF bytes accepted by the editor. */
export type PdfSource = ArrayBuffer | Uint8Array;

/** Axis-aligned rectangle in PDF user-space points (origin top-left). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentInfo {
  pageCount: number;
  title: string;
}

export interface RenderOptions {
  /** Render scale; 1 == 72 dpi. Default 1.5. */
  scale?: number;
}

/** A rendered page as PNG bytes plus pixel dimensions. */
export interface RenderedPage {
  pageIndex: number;
  width: number;
  height: number;
  png: Uint8Array;
}

/** A run of text on a page with its bounding box (for click-to-edit). */
export interface TextSpan {
  text: string;
  bbox: Rect;
}

/** An interactive form field (AcroForm widget). */
export interface FormField {
  name: string;
  /** 'text' | 'checkbox' | 'radio' | 'choice' | 'signature' | 'button' | ... */
  type: string;
  value: string;
  pageIndex: number;
  rect: Rect;
}

/** One run of uniformly-styled text inside a line (for rich text: a line may mix fonts/sizes). */
export interface TextRun {
  text: string;
  bbox: Rect;
  fontSize: number;
  color: [number, number, number];
  bold: boolean;
  italic: boolean;
  serif: boolean;
  fontName: string;
}

/** A line of existing text on the page, with the style needed to re-render it. */
export interface TextLine {
  text: string;
  /** Bounding box of the glyphs, PDF points, top-left origin. */
  bbox: Rect;
  /** Glyph baseline Y, PDF points (top-left origin) — exact vertical anchor for the overlay. */
  baseline: number;
  /** Style runs across the line (≥1). Single-style lines have one run; the fields below mirror
   *  the dominant run for back-compat. */
  runs: TextRun[];
  fontSize: number;
  /** RGB 0..1. */
  color: [number, number, number];
  bold: boolean;
  italic: boolean;
  serif: boolean;
  /** PostScript font name of the line (for picking a matching family). */
  fontName: string;
}

/** A paragraph/block of existing text (possibly multi-line), with its style. */
export interface TextBlock {
  /** Lines joined with "\n". */
  text: string;
  bbox: Rect;
  fontSize: number;
  color: [number, number, number];
  bold: boolean;
  italic: boolean;
  serif: boolean;
  /** PostScript font name, e.g. "ABCDEF+Arial-BoldMT" (may be subset-prefixed). */
  fontName: string;
}

/** An image drawn on a page: its placement box plus PNG bytes, so a baked/embedded
 *  picture (e.g. a vector flattened on save) can be re-selected and moved again. */
export interface ImageBlock {
  bbox: Rect;
  png: ArrayBuffer;
}

/** Replace the text in one line: erase its bbox, stamp new text in same style. */
export interface ReplaceLineParams {
  pageIndex: number;
  bbox: Rect;
  text: string;
  fontSize: number;
  color: [number, number, number];
  bold: boolean;
  italic: boolean;
  serif: boolean;
}

/** Free-text content drawn on top of a page. */
export interface TextOverlay {
  pageIndex: number;
  /** Position + box of the text, in PDF points. */
  rect: Rect;
  text: string;
  /** Font size in points. Default 12. */
  fontSize?: number;
  /** RGB, each channel 0..1. Default black. */
  color?: [number, number, number];
  bold?: boolean;
  italic?: boolean;
  serif?: boolean;
}

/** One segment of a vector path, in PDF points (top-left origin). `pts` holds
 *  the coordinate pairs: M/L → [x,y]; C → [x1,y1,x2,y2,x3,y3]; Z → []. */
export interface VectorSeg {
  op: 'M' | 'L' | 'C' | 'Z';
  pts: number[];
}

/** A vector shape extracted from a page's content (a fill or a stroke). */
export interface VectorPath {
  segs: VectorSeg[];
  /** Axis-aligned bounds in PDF points. */
  bbox: Rect;
  /** Fill colour (RGB 0..1) if this is a filled path, else null. */
  fill: [number, number, number] | null;
  /** Stroke colour (RGB 0..1) if this is a stroked path, else null. */
  stroke: [number, number, number] | null;
  /** Stroke width in points (0 for fills). */
  strokeWidth: number;
  /** Even-odd vs. non-zero winding fill rule. */
  evenOdd: boolean;
  /** Constant alpha 0..1 the path was painted with. */
  alpha: number;
}

export type SaveMode = 'incremental' | 'rewrite';

/** A font program embedded in the PDF, so edited text can render with the real
 *  source font instead of a substitute. */
export interface EmbeddedFont {
  /** PDF BaseFont name (PostScript name, may carry a `ABCDEF+` subset prefix). */
  name: string;
  /** Font program kind: 'truetype' (FontFile2) and 'opentype' (FontFile3,
   *  Subtype OpenType) load in a browser as-is; 'cff' (bare Type1C/CIDFontType0C)
   *  must be wrapped into OTF first. */
  format: 'truetype' | 'opentype' | 'cff';
  /** The raw font-program bytes, as a transferable ArrayBuffer. */
  data: ArrayBuffer;
}
