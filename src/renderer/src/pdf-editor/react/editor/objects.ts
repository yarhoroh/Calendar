/**
 * The editor's object model. A page carries a list of overlay objects (text
 * boxes and images) that the user can move, resize and restyle. They live in
 * React state for snappy interaction and are baked into the PDF on save.
 */
import type { Rect, VectorSeg } from '../../types.js';

export type ObjectId = string;

/** Rotation pivot in normalized box coords (0..1); {0.5,0.5} = centre. */
export interface Pivot {
  x: number;
  y: number;
}

export const CENTER_PIVOT: Pivot = { x: 0.5, y: 0.5 };

/** Horizontal alignment of a text box's lines. */
export type TextAlign = 'left' | 'center' | 'right' | 'justify';

/** Default line spacing (multiple of font size) for new/extracted text. */
export const DEFAULT_LINE_HEIGHT = 1.2;

export interface TextObject {
  id: ObjectId;
  kind: 'text';
  pageIndex: number;
  /** Box in PDF points, top-left origin. */
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** CSS font-family used to render on screen. */
  fontFamily: string;
  /** Original PDF font name (best effort, used when saving). */
  fontName: string;
  fontSize: number;
  color: [number, number, number];
  /** Field background; null = transparent. */
  background: [number, number, number] | null;
  /** Colour sampled behind the original glyphs, so erasing existing text on a
   *  coloured background restores that colour instead of punching white. */
  eraseColor: [number, number, number];
  bold: boolean;
  italic: boolean;
  /** Horizontal alignment of the lines within the box. */
  align: TextAlign;
  /** Line spacing as a multiple of the font size (1.2 ≈ normal). */
  lineHeight: number;
  /** Clockwise rotation in degrees, around `pivot`. */
  rotation: number;
  /** Rotation pivot in normalized box coords (0..1). */
  pivot: Pivot;
  /** 'existing' text must erase its original glyphs from the page on save. */
  source: 'existing' | 'new';
  originalBbox: Rect | null;
  /** Glyph baseline Y (PDF points, top-left) for an existing line — exact vertical anchor. */
  baseline?: number;
  /** Text as originally extracted — used to skip untouched lines on save. */
  originalText: string;
  /** A deleted existing line: keep it as a tombstone that erases the original
   *  (on screen and on save) instead of letting the page raster show it again. */
  deleted?: boolean;
  /** True once the original glyphs have been redacted out of the page live (so
   *  the raster no longer shows them and no white cover is needed). */
  lifted?: boolean;
  /** Set once the user changes a visual property (colour/font/size/bold/…) that
   *  doesn't alter geometry or content, so textEdited() can't otherwise see it.
   *  Makes the line lift off the page and render the editable overlay. */
  edited?: boolean;
}

export interface ImageObject {
  id: ObjectId;
  kind: 'image';
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clockwise rotation in degrees, around `pivot`. */
  rotation: number;
  /** Rotation pivot in normalized box coords (0..1). */
  pivot: Pivot;
  /** Object URL for on-screen rendering. */
  src: string;
  /** Raw image bytes for embedding into the PDF. */
  bytes: Uint8Array;
}

/** A vector rectangle/frame: a filled, optionally rounded box you can move,
 *  resize and rotate. Baked into the PDF as a fill (or an image when rounded
 *  or rotated). */
export interface ShapeObject {
  id: ObjectId;
  kind: 'rect';
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clockwise rotation in degrees, around `pivot`. */
  rotation: number;
  /** Rotation pivot in normalized box coords (0..1). */
  pivot: Pivot;
  /** Fill colour; null = transparent (invisible). */
  background: [number, number, number] | null;
  /** Corner radius in PDF points. */
  radius: number;
}

/** A vector shape lifted from the PDF (or newly drawn): any fill/stroke path,
 *  editable as one box. The geometry is kept in its original PDF coords and
 *  stretched into the live box, so move/resize is exact. */
export interface VectorObject {
  id: ObjectId;
  kind: 'vector';
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  pivot: Pivot;
  /** Original path segments in PDF points (top-left origin). */
  segs: VectorSeg[];
  /** Bounds the segments were captured at (maps to the live box). */
  origBbox: Rect;
  fill: [number, number, number] | null;
  stroke: [number, number, number] | null;
  /** Stroke width in points. */
  strokeWidth: number;
  evenOdd: boolean;
  /** Snapshots of the original style, to detect when it's been recoloured. */
  origFill: [number, number, number] | null;
  origStroke: [number, number, number] | null;
  origStrokeWidth: number;
  /** Colour sampled behind the original shape, to hide it once edited. */
  eraseColor: [number, number, number];
  /** True once the original line-art has been redacted out of the page (so the
   *  page raster no longer shows it and the text behind it is exposed). */
  lifted?: boolean;
  /** A deleted existing shape: erase its original instead of restoring it. */
  deleted?: boolean;
  /** 'existing' must erase its original line-art on save once edited. */
  source: 'existing' | 'new';
}

export type EditorObject = TextObject | ImageObject | ShapeObject | VectorObject;

/** Build an SVG `d` string from a vector's segments, in coords relative to its
 *  original bbox top-left (pairs with a `0 0 origW origH` viewBox). */
export function vectorPathD(o: VectorObject): string {
  const ox = o.origBbox.x;
  const oy = o.origBbox.y;
  let d = '';
  for (const s of o.segs) {
    if (s.op === 'Z') {
      d += 'Z';
      continue;
    }
    const parts: string[] = [];
    for (let i = 0; i < s.pts.length; i += 2) {
      parts.push(`${(s.pts[i] - ox).toFixed(2)} ${(s.pts[i + 1] - oy).toFixed(2)}`);
    }
    d += s.op + parts.join(' ');
  }
  return d;
}

/** True once a vector has been moved/resized/rotated or recoloured. */
export function vectorEdited(o: VectorObject): boolean {
  const b = o.origBbox;
  const sameColor = (
    a: [number, number, number] | null,
    c: [number, number, number] | null,
  ): boolean => (a === null ? c === null : c !== null && a[0] === c[0] && a[1] === c[1] && a[2] === c[2]);
  return (
    o.x !== b.x ||
    o.y !== b.y ||
    o.w !== b.width ||
    o.h !== b.height ||
    o.rotation !== 0 ||
    !sameColor(o.fill, o.origFill) ||
    !sameColor(o.stroke, o.origStroke) ||
    o.strokeWidth !== o.origStrokeWidth
  );
}

/** True once an existing text line differs from its original geometry/content,
 *  so it must be erased from the page and re-baked on save (and lifted live
 *  while editing). New text always counts as edited. Kept in sync with the
 *  save path so a line is lifted exactly when save will re-bake it. */
export function textEdited(o: TextObject): boolean {
  if (o.source !== 'existing' || !o.originalBbox) return true;
  if (o.edited) return true;
  const b = o.originalBbox;
  return (
    o.rotation % 360 !== 0 ||
    o.background !== null ||
    o.text !== o.originalText ||
    o.x !== b.x ||
    o.y !== b.y ||
    o.w !== b.width ||
    o.h !== b.height
  );
}

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];

let counter = 0;
export function nextId(): ObjectId {
  counter += 1;
  return `obj_${counter}`;
}

/** Apply a resize handle drag (delta in points) to a box, keeping it sane. */
export function resizeBox(
  box: { x: number; y: number; w: number; h: number },
  handle: ResizeHandle,
  dx: number,
  dy: number,
  min = 8,
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = box;
  if (handle.includes('e')) w = Math.max(min, w + dx);
  if (handle.includes('s')) h = Math.max(min, h + dy);
  if (handle.includes('w')) {
    const nw = Math.max(min, w - dx);
    x += w - nw;
    w = nw;
  }
  if (handle.includes('n')) {
    const nh = Math.max(min, h - dy);
    y += h - nh;
    h = nh;
  }
  return { x, y, w, h };
}

export function cssColor(c: [number, number, number]): string {
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${to255(c[0])}, ${to255(c[1])}, ${to255(c[2])})`;
}

/** Font families offered in the picker. */
export const FONT_FAMILIES = [
  'Arial',
  'Times New Roman',
  'Courier New',
  'Georgia',
  'Verdana',
  'Tahoma',
];

/** Map a PDF PostScript font name to the closest offered CSS family. */
export function pickFamily(pdfFontName: string): string {
  const n = pdfFontName.toLowerCase();
  if (/courier|mono|consol/.test(n)) return 'Courier New';
  if (/georgia/.test(n)) return 'Georgia';
  if (/verdana/.test(n)) return 'Verdana';
  if (/tahoma/.test(n)) return 'Tahoma';
  if (/times|roman|serif|minion|garamond/.test(n)) return 'Times New Roman';
  return 'Arial';
}

export function familyIsSerif(family: string): boolean {
  return /times|georgia|serif/i.test(family);
}

/** Strip the 6-letter subset prefix (e.g. "ABCDEF+Arial") for display. */
export function cleanFontName(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '');
}

/** Infer bold/italic from a PDF font name (best effort). */
export function fontNameStyle(name: string): { bold: boolean; italic: boolean } {
  return {
    bold: /bold|black|heavy|semibold/i.test(name),
    italic: /italic|oblique/i.test(name),
  };
}
