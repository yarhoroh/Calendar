/**
 * useDocumentEditor — the editor's brain. Owns the PdfEditor engine, the
 * rendered pages, and the live overlay objects (text + images). Handles
 * click-to-edit of existing text, adding text/images, and baking every object
 * into the PDF on save.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PdfEditor } from '../../core/PdfEditor.js';
import type { DocumentInfo, PdfSource, Rect, SaveMode, TextLine, VectorPath } from '../../types.js';
import { fitTextBox, measureTextWidth } from './measureText.js';
import { rasterizeRotated } from './rasterize.js';
import { clearColorSampleCache, sampleBackgroundColor } from './sampleColor.js';
import { clearEmbeddedFonts, familyForPdfFont, registerEmbeddedFont } from './fonts.js';
import {
  CENTER_PIVOT,
  cleanFontName,
  DEFAULT_LINE_HEIGHT,
  familyIsSerif,
  nextId,
  pickFamily,
  textEdited,
  vectorEdited,
  type EditorObject,
  type ImageObject,
  type ObjectId,
  type ShapeObject,
  type TextObject,
  type VectorObject,
} from './objects.js';

export type EditorStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RenderedPageView {
  pageIndex: number;
  width: number;
  height: number;
  /** Zoom the raster was rendered at, so the view can stretch it until the
   *  crisp re-render lands and keep the overlay aligned. */
  renderedScale: number;
  url: string;
}

export interface UseDocumentEditorOptions {
  scale?: number;
}

export interface DocumentEditor {
  status: EditorStatus;
  error: string | null;
  info: DocumentInfo | null;
  scale: number;
  pages: RenderedPageView[];
  objects: EditorObject[];
  fonts: string[];
  documentFonts: string[];
  documentSizes: number[];
  documentColors: [number, number, number][];
  lineRects: Rect[][];
  /** Bounding boxes of every vector shape, per page (for edit-mode outlines). */
  vectorRects: Rect[][];
  selectedId: ObjectId | null;
  editingId: ObjectId | null;
  selected: TextObject | null;
  /** The selected object of any kind (text, image or shape). */
  selectedObject: EditorObject | null;
  open: (source: PdfSource | File) => Promise<void>;
  save: (mode?: SaveMode) => Promise<Uint8Array | null>;
  editExistingAt: (
    pageIndex: number,
    pageX: number,
    pageY: number,
    edit?: boolean,
  ) => Promise<boolean>;
  selectVectorAt: (pageIndex: number, pageX: number, pageY: number) => Promise<boolean>;
  /** Select whatever is under the point — text line or vector shape — picking
   *  the most specific (smallest-area) one, by geometry alone. */
  selectAt: (pageIndex: number, pageX: number, pageY: number, edit?: boolean) => Promise<void>;
  /** Ids currently in the marquee group selection. */
  groupIds: ObjectId[];
  /** Materialise & group-select every element whose box falls in `box`. */
  selectInBox: (pageIndex: number, box: Rect) => Promise<void>;
  /** Move several elements at once (group drag); positions are absolute. */
  moveGroup: (updates: { id: ObjectId; x: number; y: number }[]) => void;
  /** Finish a group drag: lift the existing members off the page. */
  endGroupMove: (ids: ObjectId[]) => void;
  /** Materialise all existing text/vectors as editable objects (Acrobat-style). */
  enterEditMode: () => Promise<void>;
  addTextAt: (pageIndex: number, pageX: number, pageY: number) => void;
  addShapeAt: (pageIndex: number, pageX: number, pageY: number) => void;
  addImage: (pageIndex: number, file: File, x?: number, y?: number) => Promise<void>;
  select: (id: ObjectId | null) => void;
  startEdit: (id: ObjectId) => void;
  commitEdit: () => void;
  exitEdit: () => void;
  textInput: (id: ObjectId, text: string) => void;
  updateObject: (id: ObjectId, patch: Partial<EditorObject>) => void;
  updateSelected: (patch: Partial<TextObject>) => void;
  deleteSelected: () => void;
  deleteObject: (id: ObjectId) => void;
  bringForward: (id: ObjectId) => void;
  sendBackward: (id: ObjectId) => void;
  cropObject: (id: ObjectId) => void;
  copyObject: (id: ObjectId) => void;
  paste: () => void;
  zoomBy: (factor: number) => void;
}

const FALLBACK_FONTS = ['Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana', 'Tahoma'];

export function useDocumentEditor(options: UseDocumentEditorOptions = {}): DocumentEditor {
  const [scale, setScale] = useState(options.scale ?? 1.5);
  const editorRef = useRef<PdfEditor | null>(null);
  const urlsRef = useRef<string[]>([]);
  // Per-page text layout cache and a line→object claim map, so a quick
  // double-click reliably reuses one object instead of spawning duplicates.
  const layoutRef = useRef<Map<number, TextLine[]>>(new Map());
  const claimedRef = useRef<Map<string, ObjectId>>(new Map());
  // Per-page vector shapes (lifted from the PDF) and a claim map, mirroring the
  // text caches so clicking a frame reuses one object instead of duplicating.
  const vectorRef = useRef<Map<number, VectorPath[]>>(new Map());
  const claimedVecRef = useRef<Map<string, ObjectId>>(new Map());
  // Vectors whose original line-art has been redacted out of the page already.
  const liftedRef = useRef<Set<ObjectId>>(new Set());
  const objectsRef = useRef<EditorObject[]>([]);
  const infoRef = useRef<DocumentInfo | null>(null);
  const pagesRef = useRef<RenderedPageView[]>([]);
  const clipboardRef = useRef<EditorObject | null>(null);
  const scaleInitRef = useRef(true);

  const [status, setStatus] = useState<EditorStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<DocumentInfo | null>(null);
  const [pages, setPages] = useState<RenderedPageView[]>([]);
  const [objects, setObjects] = useState<EditorObject[]>([]);
  const [fonts] = useState<string[]>(FALLBACK_FONTS);
  const [documentFonts, setDocumentFonts] = useState<string[]>([]);
  // Per-page PDF text-line boxes, used as snap/alignment targets while dragging.
  const [lineRects, setLineRects] = useState<Rect[][]>([]);
  const [vectorRects, setVectorRects] = useState<Rect[][]>([]);
  // Font sizes and text colours actually used in the PDF (for the style pickers).
  const [documentSizes, setDocumentSizes] = useState<number[]>([]);
  const [documentColors, setDocumentColors] = useState<[number, number, number][]>([]);
  const [selectedId, setSelectedId] = useState<ObjectId | null>(null);
  // Ids selected together by a rubber-band marquee, for moving them as a group.
  const [groupIds, setGroupIds] = useState<ObjectId[]>([]);
  const [editingId, setEditingId] = useState<ObjectId | null>(null);

  objectsRef.current = objects; // always-current snapshots for event handlers
  infoRef.current = info;
  pagesRef.current = pages;

  const revokeUrls = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  const ensureEditor = useCallback(async (): Promise<PdfEditor> => {
    if (!editorRef.current) editorRef.current = await PdfEditor.create();
    return editorRef.current;
  }, []);

  const renderAll = useCallback(
    async (editor: PdfEditor, pageCount: number): Promise<RenderedPageView[]> => {
      const out: RenderedPageView[] = [];
      for (let i = 0; i < pageCount; i++) {
        const page = await editor.renderPage(i, { scale });
        const url = URL.createObjectURL(new Blob([page.png as BlobPart], { type: 'image/png' }));
        urlsRef.current.push(url);
        out.push({
          pageIndex: i,
          width: page.width,
          height: page.height,
          renderedScale: scale,
          url,
        });
      }
      return out;
    },
    [scale],
  );

  const open = useCallback(
    async (source: PdfSource | File): Promise<void> => {
      setStatus('loading');
      setError(null);
      try {
        const editor = await ensureEditor();
        const documentInfo = await editor.open(source);
        revokeUrls();
        layoutRef.current.clear();
        claimedRef.current.clear();
        vectorRef.current.clear();
        claimedVecRef.current.clear();
        liftedRef.current.clear();
        clearColorSampleCache();
        clearEmbeddedFonts();
        setObjects([]);
        setSelectedId(null);
        setEditingId(null);
        const rendered = await renderAll(editor, documentInfo.pageCount);
        setInfo(documentInfo);
        setPages(rendered);
        // Pre-extract the fonts actually used in the PDF, deduped by display name.
        const raw = await editor.getDocumentFonts();
        const byName = new Map<string, string>();
        for (const name of raw) {
          const key = cleanFontName(name);
          if (!byName.has(key)) byName.set(key, name);
        }
        setDocumentFonts([...byName.values()].sort((a, b) => cleanFontName(a).localeCompare(cleanFontName(b))));
        // Pull the actual embedded font programs and register them as FontFaces,
        // so a lifted line renders with the document's own font (one-to-one),
        // not a CSS substitute. Best-effort: unusable programs simply fall back.
        try {
          const embedded = await editor.getEmbeddedFonts();
          await Promise.all(embedded.map((f) => registerEmbeddedFont(f)));
        } catch {
          /* keep going with substitute fonts */
        }
        // Pre-read every page's text layout for alignment guides (and to make
        // click-to-edit instant). Cached in layoutRef for reuse.
        const allLines: Rect[][] = [];
        const allVecs: Rect[][] = [];
        const sizeSet = new Set<number>();
        const colorMap = new Map<string, [number, number, number]>();
        for (let i = 0; i < documentInfo.pageCount; i++) {
          const lines = await editor.getTextLayout(i);
          layoutRef.current.set(i, lines);
          allLines[i] = lines.map((l) => l.bbox);
          for (const l of lines) {
            sizeSet.add(Math.round(l.fontSize));
            const key = l.color.map((v) => Math.round(v * 255)).join(',');
            if (!colorMap.has(key)) colorMap.set(key, l.color);
          }
          // Lift the page's vector shapes (frames, lines) for click-to-edit.
          const vecs = await editor.getVectorPaths(i);
          vectorRef.current.set(i, vecs);
          allVecs[i] = vecs.map((v) => v.bbox);
        }
        setLineRects(allLines);
        setVectorRects(allVecs);
        setDocumentSizes([...sizeSet].sort((a, b) => a - b));
        setDocumentColors([...colorMap.values()]);
        setStatus('ready');
      } catch (err) {
        revokeUrls();
        setPages([]);
        setInfo(null);
        setDocumentFonts([]);
        setLineRects([]);
        setVectorRects([]);
        setDocumentSizes([]);
        setDocumentColors([]);
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    },
    [ensureEditor, renderAll, revokeUrls],
  );

  const save = useCallback(
    async (mode: SaveMode = 'rewrite'): Promise<Uint8Array | null> => {
      const editor = editorRef.current;
      if (!editor) return null;
      // Bake every overlay object into the PDF, in array order (later = on top).
      for (const obj of objects) {
        const rect: Rect = { x: obj.x, y: obj.y, width: obj.w, height: obj.h };
        const rotated = obj.rotation % 360 !== 0;
        // A deleted existing element: erase its original from the page; no re-bake.
        if (obj.kind === 'text' && obj.deleted) {
          if (obj.source === 'existing' && obj.originalBbox && !obj.lifted) {
            const b = obj.originalBbox;
            const topPad = obj.fontSize * 0.15;
            const botTrim = obj.fontSize * 0.08;
            const bExp: Rect = {
              x: b.x - 1,
              y: b.y - topPad,
              width: b.width + 2,
              height: b.height + topPad - botTrim,
            };
            // Remove only the glyphs, leaving any coloured/imaged background.
            await editor.redactText(obj.pageIndex, bExp);
          }
          continue;
        }
        if (obj.kind === 'vector' && obj.deleted) {
          if (obj.source === 'existing' && !obj.lifted) {
            const ob = obj.origBbox;
            await editor.redactLineArt(obj.pageIndex, {
              x: ob.x - 1,
              y: ob.y - 1,
              width: ob.width + 2,
              height: ob.height + 2,
            });
          }
          continue;
        }
        // Shapes: a transparent fill draws nothing; otherwise stamp a rounded /
        // rotated box as an image, or paint a plain fill when it's a crisp rect.
        if (obj.kind === 'rect') {
          if (obj.background) {
            if (rotated || obj.radius > 0.01) {
              const baked = await rasterizeRotated(obj);
              await editor.insertImage(obj.pageIndex, baked.rect, baked.bytes);
            } else {
              await editor.fillRect(obj.pageIndex, rect, obj.background);
            }
          }
          continue;
        }
        // Vector shape: leave it untouched unless edited; once edited, erase the
        // original line-art (keeping text/images) and stamp the new appearance.
        if (obj.kind === 'vector') {
          if (obj.source === 'existing' && !vectorEdited(obj)) continue;
          // Erase the original unless it was already lifted off the page live.
          if (obj.source === 'existing' && !obj.lifted) {
            const ob = obj.origBbox;
            await editor.redactLineArt(obj.pageIndex, {
              x: ob.x - 1,
              y: ob.y - 1,
              width: ob.width + 2,
              height: ob.height + 2,
            });
          }
          const baked = await rasterizeRotated(obj);
          await editor.insertImage(obj.pageIndex, baked.rect, baked.bytes);
          continue;
        }
        // Existing text: erase the original glyphs once the line is touched.
        if (obj.kind === 'text' && obj.source === 'existing' && obj.originalBbox) {
          // An untouched, never-lifted line keeps its crisp original. Once lifted
          // live, the original is already gone, so it must always be re-baked
          // (even if the user happened to drag it back to its start position).
          if (!obj.lifted && !textEdited(obj)) continue;
          // Erase the original glyphs unless they were already redacted live.
          if (!obj.lifted) {
            const b = obj.originalBbox;
            // Tight erase: expand a little on top (ascenders), pull the bottom up
            // so we don't bite the next line's empty descender space.
            const topPad = obj.fontSize * 0.15;
            const botTrim = obj.fontSize * 0.08;
            const bExp: Rect = {
              x: b.x - 1,
              y: b.y - topPad,
              width: b.width + 2,
              height: b.height + topPad - botTrim,
            };
            // Remove only the glyphs, leaving any coloured/imaged background.
            await editor.redactText(obj.pageIndex, bExp);
          }
        }
        if (obj.kind === 'text' && !obj.text.trim()) continue;
        if (rotated) {
          // Flatten rotated objects to an image stamp.
          const baked = await rasterizeRotated(obj);
          await editor.insertImage(obj.pageIndex, baked.rect, baked.bytes);
        } else if (obj.kind === 'image') {
          await editor.insertImage(obj.pageIndex, rect, obj.bytes);
        } else {
          if (obj.background) await editor.fillRect(obj.pageIndex, rect, obj.background);
          // Bake line by line so the chosen alignment and line spacing persist
          // (a single FreeText would force its own spacing and ignore alignment).
          const lines = obj.text.split('\n');
          const lineH = obj.fontSize * obj.lineHeight;
          const boxH = obj.fontSize * 1.25;
          for (let i = 0; i < lines.length; i++) {
            const ln = lines[i];
            if (!ln.trim()) continue;
            const lw = measureTextWidth(ln, obj.fontSize, obj.fontFamily, obj.bold, obj.italic);
            let lx = obj.x;
            if (obj.align === 'center') lx = obj.x + (obj.w - lw) / 2;
            else if (obj.align === 'right') lx = obj.x + (obj.w - lw);
            // 'justify' bakes from the left (no inter-word stretch in the bake).
            const lineRect: Rect = {
              x: lx,
              y: obj.y + i * lineH,
              width: Math.max(lw + obj.fontSize * 0.2, 1),
              height: boxH,
            };
            await editor.addTextOverlay({
              pageIndex: obj.pageIndex,
              rect: lineRect,
              text: ln,
              fontSize: obj.fontSize,
              color: obj.color,
              bold: obj.bold,
              italic: obj.italic,
              serif: familyIsSerif(obj.fontFamily),
            });
          }
        }
      }
      const bytes = await editor.save(mode);
      // Objects are now part of the page raster: repaint and clear them.
      if (info) {
        revokeUrls();
        const rendered = await renderAll(editor, info.pageCount);
        setPages(rendered);
        // Re-lift vector shapes — originals may have been erased/replaced.
        vectorRef.current.clear();
        for (let i = 0; i < info.pageCount; i++) {
          vectorRef.current.set(i, await editor.getVectorPaths(i));
        }
      }
      // Page raster changed; drop the line cache/claims so re-edits re-read it.
      layoutRef.current.clear();
      claimedRef.current.clear();
      claimedVecRef.current.clear();
      liftedRef.current.clear();
      clearColorSampleCache();
      setObjects([]);
      setSelectedId(null);
      setEditingId(null);
      return bytes;
    },
    [objects, info, renderAll, revokeUrls],
  );

  const editExistingAt = useCallback(
    async (pageIndex: number, pageX: number, pageY: number, edit = false): Promise<boolean> => {
      const editor = editorRef.current;
      if (!editor) return false;
      // Per-line hit testing — each line (e.g. a table cell) is its own object.
      let lines = layoutRef.current.get(pageIndex);
      if (!lines) {
        lines = await editor.getTextLayout(pageIndex);
        layoutRef.current.set(pageIndex, lines);
      }
      const line = lines.find(
        (l) =>
          pageX >= l.bbox.x &&
          pageX <= l.bbox.x + l.bbox.width &&
          pageY >= l.bbox.y &&
          pageY <= l.bbox.y + l.bbox.height,
      );
      if (!line) return false; // no text here — caller may try a vector shape
      // Reuse the object already created for this line (e.g. on a double-click)
      // so a single line never spawns duplicate overlays.
      const key = `${pageIndex}:${Math.round(line.bbox.x)}:${Math.round(line.bbox.y)}`;
      const claimedId = claimedRef.current.get(key);
      if (claimedId && objectsRef.current.some((o) => o.id === claimedId)) {
        setSelectedId(claimedId);
        setEditingId(edit ? claimedId : null);
        return true;
      }
      // Sample the colour behind the original glyphs so erasing this line on a
      // coloured background restores that colour instead of a white box.
      let eraseColor: [number, number, number] = [1, 1, 1];
      const page = pagesRef.current.find((p) => p.pageIndex === pageIndex);
      if (page) {
        const k = page.renderedScale;
        eraseColor = await sampleBackgroundColor(
          page.url,
          line.bbox.x * k,
          line.bbox.y * k,
          line.bbox.width * k,
          line.bbox.height * k,
        );
      }
      const id = nextId();
      claimedRef.current.set(key, id);
      const obj: TextObject = {
        id,
        kind: 'text',
        pageIndex,
        x: line.bbox.x,
        y: line.bbox.y,
        w: line.bbox.width,
        h: line.bbox.height,
        text: line.text,
        // Prefer the document's own embedded font so editing is one-to-one;
        // fall back to the closest CSS family when it isn't usable in a browser.
        fontFamily: familyForPdfFont(line.fontName) ?? pickFamily(line.fontName),
        fontName: line.fontName,
        fontSize: line.fontSize,
        color: line.color,
        background: null,
        eraseColor,
        bold: line.bold,
        italic: line.italic,
        align: 'left',
        lineHeight: DEFAULT_LINE_HEIGHT,
        rotation: 0,
        pivot: { ...CENTER_PIVOT },
        source: 'existing',
        originalBbox: line.bbox,
        baseline: line.baseline,
        originalText: line.text,
      };
      setObjects((prev) => [...prev, obj]);
      setSelectedId(id);
      setEditingId(edit ? id : null); // single click selects, double click edits
      return true;
    },
    [],
  );

  // Click an existing vector shape (frame/line): materialise it as an editable
  // object. Returns true if a shape was hit. Mirrors editExistingAt for text.
  const selectVectorAt = useCallback(
    async (pageIndex: number, pageX: number, pageY: number): Promise<boolean> => {
      const vecs = vectorRef.current.get(pageIndex);
      if (!vecs || !vecs.length) return false;
      // The smallest bbox under the cursor is the most specific shape.
      let best: VectorPath | null = null;
      let bestArea = Infinity;
      for (let i = 0; i < vecs.length; i++) {
        const b = vecs[i].bbox;
        if (pageX >= b.x && pageX <= b.x + b.width && pageY >= b.y && pageY <= b.y + b.height) {
          const area = Math.max(b.width, 1) * Math.max(b.height, 1);
          if (area < bestArea) {
            bestArea = area;
            best = vecs[i];
          }
        }
      }
      if (!best) return false;
      // Key the claim by geometry, NOT by array index: lifting a moved shape
      // rebuilds the vector list (re-indexing it), so an index key would later
      // resolve a different shape to a stale claim — selecting the wrong frame.
      const b = best.bbox;
      const key = `${pageIndex}:${Math.round(b.x)}:${Math.round(b.y)}:${Math.round(b.width)}:${Math.round(b.height)}`;
      const claimedId = claimedVecRef.current.get(key);
      if (claimedId && objectsRef.current.some((o) => o.id === claimedId)) {
        setSelectedId(claimedId);
        setEditingId(null);
        return true;
      }
      // Sample what's behind the shape so we can hide the original once it moves.
      let eraseColor: [number, number, number] = [1, 1, 1];
      const page = pagesRef.current.find((p) => p.pageIndex === pageIndex);
      if (page) {
        const k = page.renderedScale;
        eraseColor = await sampleBackgroundColor(
          page.url,
          best.bbox.x * k,
          best.bbox.y * k,
          best.bbox.width * k,
          best.bbox.height * k,
        );
      }
      const id = nextId();
      claimedVecRef.current.set(key, id);
      const obj: VectorObject = {
        id,
        kind: 'vector',
        pageIndex,
        x: best.bbox.x,
        y: best.bbox.y,
        w: best.bbox.width,
        h: best.bbox.height,
        rotation: 0,
        pivot: { ...CENTER_PIVOT },
        segs: best.segs,
        origBbox: { ...best.bbox },
        fill: best.fill,
        stroke: best.stroke,
        strokeWidth: best.strokeWidth,
        evenOdd: best.evenOdd,
        origFill: best.fill,
        origStroke: best.stroke,
        origStrokeWidth: best.strokeWidth,
        eraseColor,
        source: 'existing',
      };
      setObjects((prev) => [...prev, obj]);
      setSelectedId(id);
      setEditingId(null);
      return true;
    },
    [],
  );

  // Click resolution by geometry alone: find the text line and the vector shape
  // whose bbox contains the point, and select the smaller-area (more specific)
  // one. A vector is located purely by its own x/y/w/h, so the whole of it that
  // isn't covered by a tighter text line is grabbable — no text-driven routing.
  const selectAt = useCallback(
    async (pageIndex: number, x: number, y: number, edit = false): Promise<void> => {
      const smallestAreaAt = (boxes: Rect[]): number | null => {
        let best: number | null = null;
        for (const b of boxes) {
          if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
            const a = Math.max(b.width, 1) * Math.max(b.height, 1);
            if (best === null || a < best) best = a;
          }
        }
        return best;
      };
      const textArea = smallestAreaAt((layoutRef.current.get(pageIndex) ?? []).map((l) => l.bbox));
      const vecArea = smallestAreaAt((vectorRef.current.get(pageIndex) ?? []).map((v) => v.bbox));
      const textFirst = textArea !== null && (vecArea === null || textArea <= vecArea);
      // Try the winner, then the other as a fallback, else clear the selection.
      if (textFirst) {
        if (await editExistingAt(pageIndex, x, y, edit)) return;
        if (vecArea !== null && (await selectVectorAt(pageIndex, x, y))) return;
      } else {
        if (vecArea !== null && (await selectVectorAt(pageIndex, x, y))) return;
        if (textArea !== null && (await editExistingAt(pageIndex, x, y, edit))) return;
      }
      setSelectedId(null);
      setEditingId(null);
      setGroupIds([]); // a click on empty space also drops any lingering marquee group
    },
    [editExistingAt, selectVectorAt],
  );

  // A single (point) selection always clears any marquee group.
  useEffect(() => {
    if (selectedId) setGroupIds([]);
  }, [selectedId]);

  // Rubber-band selection: materialise every text line and vector whose box
  // intersects `box`, plus any already-materialised object there, and group them.
  const selectInBox = useCallback(async (pageIndex: number, box: Rect): Promise<void> => {
    const hit = (b: Rect) =>
      b.x < box.x + box.width &&
      b.x + b.width > box.x &&
      b.y < box.y + box.height &&
      b.y + b.height > box.y;
    const page = pagesRef.current.find((p) => p.pageIndex === pageIndex);
    const k = page?.renderedScale ?? 1;
    const sample = async (b: Rect): Promise<[number, number, number]> =>
      page ? sampleBackgroundColor(page.url, b.x * k, b.y * k, b.width * k, b.height * k) : [1, 1, 1];
    const ids: ObjectId[] = [];
    const fresh: EditorObject[] = [];
    // Already-materialised objects inside the box.
    for (const o of objectsRef.current) {
      if (o.pageIndex !== pageIndex) continue;
      if ((o.kind === 'text' || o.kind === 'vector') && o.deleted) continue;
      if (hit({ x: o.x, y: o.y, width: o.w, height: o.h })) ids.push(o.id);
    }
    // Text lines.
    for (const line of layoutRef.current.get(pageIndex) ?? []) {
      if (!hit(line.bbox)) continue;
      const key = `${pageIndex}:${Math.round(line.bbox.x)}:${Math.round(line.bbox.y)}`;
      const claimed = claimedRef.current.get(key);
      if (claimed && objectsRef.current.some((o) => o.id === claimed)) {
        if (!ids.includes(claimed)) ids.push(claimed);
        continue;
      }
      const id = nextId();
      claimedRef.current.set(key, id);
      fresh.push({
        id,
        kind: 'text',
        pageIndex,
        x: line.bbox.x,
        y: line.bbox.y,
        w: line.bbox.width,
        h: line.bbox.height,
        text: line.text,
        fontFamily: familyForPdfFont(line.fontName) ?? pickFamily(line.fontName),
        fontName: line.fontName,
        fontSize: line.fontSize,
        color: line.color,
        background: null,
        eraseColor: await sample(line.bbox),
        bold: line.bold,
        italic: line.italic,
        align: 'left',
        lineHeight: DEFAULT_LINE_HEIGHT,
        rotation: 0,
        pivot: { ...CENTER_PIVOT },
        source: 'existing',
        originalBbox: line.bbox,
        baseline: line.baseline,
        originalText: line.text,
      });
      ids.push(id);
    }
    // Vector shapes.
    for (const v of vectorRef.current.get(pageIndex) ?? []) {
      if (!hit(v.bbox)) continue;
      const key = `${pageIndex}:${Math.round(v.bbox.x)}:${Math.round(v.bbox.y)}:${Math.round(v.bbox.width)}:${Math.round(v.bbox.height)}`;
      const claimed = claimedVecRef.current.get(key);
      if (claimed && objectsRef.current.some((o) => o.id === claimed)) {
        if (!ids.includes(claimed)) ids.push(claimed);
        continue;
      }
      const id = nextId();
      claimedVecRef.current.set(key, id);
      fresh.push({
        id,
        kind: 'vector',
        pageIndex,
        x: v.bbox.x,
        y: v.bbox.y,
        w: v.bbox.width,
        h: v.bbox.height,
        rotation: 0,
        pivot: { ...CENTER_PIVOT },
        segs: v.segs,
        origBbox: { ...v.bbox },
        fill: v.fill,
        stroke: v.stroke,
        strokeWidth: v.strokeWidth,
        evenOdd: v.evenOdd,
        origFill: v.fill,
        origStroke: v.stroke,
        origStrokeWidth: v.strokeWidth,
        eraseColor: await sample(v.bbox),
        source: 'existing',
      });
      ids.push(id);
    }
    if (fresh.length) setObjects((prev) => [...prev, ...fresh]);
    setSelectedId(null);
    setEditingId(null);
    setGroupIds(ids);
  }, []);

  // Group drag: move every member to its new absolute position in one update
  // (no lift mid-drag — that happens once on release).
  const moveGroup = useCallback((updates: { id: ObjectId; x: number; y: number }[]) => {
    const map = new Map(updates.map((u) => [u.id, u]));
    setObjects((prev) =>
      prev.map((o) => {
        const u = map.get(o.id);
        return u ? ({ ...o, x: u.x, y: u.y } as EditorObject) : o;
      }),
    );
  }, []);

  // Entering edit mode: materialise EVERY existing text line and vector shape as
  // an object up front (like Acrobat), at its original position, so it's all
  // immediately selectable. Originals stay in the page raster; the redaction
  // that "lifts" a shape out happens lazily, only when it's actually changed.
  const enterEditMode = useCallback(async () => {
    const di = infoRef.current;
    if (!di) return;
    claimedRef.current.clear();
    claimedVecRef.current.clear();
    // Keep anything the user added; rebuild the existing text/vector objects.
    const kept = objectsRef.current.filter(
      (o) => !(o.kind === 'text' && o.source === 'existing') && !(o.kind === 'vector'),
    );
    const existing: EditorObject[] = [];
    for (let pi = 0; pi < di.pageCount; pi++) {
      // Vectors largest-first so the smallest sits on top and is easiest to grab.
      const vecs = (vectorRef.current.get(pi) ?? [])
        .map((v, i) => ({ v, i }))
        .sort(
          (a, b) =>
            b.v.bbox.width * b.v.bbox.height - a.v.bbox.width * a.v.bbox.height,
        );
      for (const { v, i } of vecs) {
        const id = nextId();
        claimedVecRef.current.set(`${pi}:${i}`, id);
        existing.push({
          id,
          kind: 'vector',
          pageIndex: pi,
          x: v.bbox.x,
          y: v.bbox.y,
          w: v.bbox.width,
          h: v.bbox.height,
          rotation: 0,
          pivot: { ...CENTER_PIVOT },
          segs: v.segs,
          origBbox: { ...v.bbox },
          fill: v.fill,
          stroke: v.stroke,
          strokeWidth: v.strokeWidth,
          evenOdd: v.evenOdd,
          origFill: v.fill,
          origStroke: v.stroke,
          origStrokeWidth: v.strokeWidth,
          eraseColor: [1, 1, 1],
          source: 'existing',
        });
      }
      const lines = layoutRef.current.get(pi) ?? [];
      const page = pagesRef.current.find((p) => p.pageIndex === pi);
      for (const line of lines) {
        const id = nextId();
        claimedRef.current.set(
          `${pi}:${Math.round(line.bbox.x)}:${Math.round(line.bbox.y)}`,
          id,
        );
        let eraseColor: [number, number, number] = [1, 1, 1];
        if (page) {
          const k = page.renderedScale;
          eraseColor = await sampleBackgroundColor(
            page.url,
            line.bbox.x * k,
            line.bbox.y * k,
            line.bbox.width * k,
            line.bbox.height * k,
          );
        }
        existing.push({
          id,
          kind: 'text',
          pageIndex: pi,
          x: line.bbox.x,
          y: line.bbox.y,
          w: line.bbox.width,
          h: line.bbox.height,
          text: line.text,
          fontFamily: pickFamily(line.fontName),
          fontName: line.fontName,
          fontSize: line.fontSize,
          color: line.color,
          background: null,
          eraseColor,
          bold: line.bold,
          italic: line.italic,
          align: 'left',
          lineHeight: DEFAULT_LINE_HEIGHT,
          rotation: 0,
          pivot: { ...CENTER_PIVOT },
          source: 'existing',
          originalBbox: line.bbox,
          baseline: line.baseline,
          originalText: line.text,
        });
      }
    }
    setObjects([...existing, ...kept]);
    setSelectedId(null);
    setEditingId(null);
  }, []);

  const addTextAt = useCallback((pageIndex: number, pageX: number, pageY: number) => {
    const id = nextId();
    const obj: TextObject = {
      id,
      kind: 'text',
      pageIndex,
      x: pageX,
      y: pageY,
      w: 160,
      h: 24,
      text: '',
      fontFamily: 'Arial',
      fontName: '',
      fontSize: 16,
      color: [0, 0, 0],
      background: null,
      eraseColor: [1, 1, 1],
      bold: false,
      italic: false,
      align: 'left',
      lineHeight: DEFAULT_LINE_HEIGHT,
      rotation: 0,
      pivot: { ...CENTER_PIVOT },
      source: 'new',
      originalBbox: null,
      originalText: '',
    };
    setObjects((prev) => [...prev, obj]);
    setSelectedId(id);
    setEditingId(id);
  }, []);

  const addShapeAt = useCallback((pageIndex: number, pageX: number, pageY: number) => {
    const id = nextId();
    const obj: ShapeObject = {
      id,
      kind: 'rect',
      pageIndex,
      x: pageX,
      y: pageY,
      w: 140,
      h: 90,
      rotation: 0,
      pivot: { ...CENTER_PIVOT },
      background: [0.85, 0.85, 0.85],
      radius: 8,
    };
    setObjects((prev) => [...prev, obj]);
    setSelectedId(id);
    setEditingId(null);
  }, []);

  const addImage = useCallback(
    async (pageIndex: number, file: File, x = 40, y = 40): Promise<void> => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const url = URL.createObjectURL(file);
      urlsRef.current.push(url);
      const id = nextId();
      const obj: ImageObject = {
        id,
        kind: 'image',
        pageIndex,
        x,
        y,
        w: 200,
        h: 150,
        rotation: 0,
        pivot: { ...CENTER_PIVOT },
        src: url,
        bytes,
      };
    setObjects((prev) => [...prev, obj]);
    setSelectedId(id);
  }, []);

  // Lift an existing line of text out of the page: redact only its glyphs (which
  // keeps any background fill/image behind it), re-render the page, then mark it
  // lifted. After this the page raster no longer shows the original, so we drop
  // the white cover and the real background — not a white box — shows through.
  const liftText = useCallback(
    async (o: TextObject) => {
      const editor = editorRef.current;
      if (!editor || !o.originalBbox) return;
      const b = o.originalBbox;
      const topPad = o.fontSize * 0.15;
      const botTrim = o.fontSize * 0.08;
      await editor.redactText(o.pageIndex, {
        x: b.x - 1,
        y: b.y - topPad,
        width: b.width + 2,
        height: b.height + topPad - botTrim,
      });
      const rp = await editor.renderPage(o.pageIndex, { scale });
      const url = URL.createObjectURL(new Blob([rp.png as BlobPart], { type: 'image/png' }));
      urlsRef.current.push(url);
      setPages((prev) =>
        prev.map((p) =>
          p.pageIndex === o.pageIndex
            ? { pageIndex: p.pageIndex, width: rp.width, height: rp.height, renderedScale: scale, url }
            : p,
        ),
      );
      clearColorSampleCache();
      setObjects((prev) =>
        prev.map((x) => (x.id === o.id ? ({ ...x, lifted: true } as EditorObject) : x)),
      );
    },
    [scale],
  );

  // First time an existing line is actually changed, lift it off the page.
  const maybeLiftText = useCallback(
    (merged: TextObject) => {
      if (merged.source !== 'existing' || liftedRef.current.has(merged.id)) return;
      if (textEdited(merged)) {
        liftedRef.current.add(merged.id);
        void liftText(merged);
      }
    },
    [liftText],
  );

  const select = useCallback((id: ObjectId | null) => {
    setSelectedId(id);
    setEditingId(null);
  }, []);

  const startEdit = useCallback((id: ObjectId) => {
    // Fit the box to the text up front so the caret and full line are visible
    // with no scrolling, even if the substitute font is a little wider.
    setObjects((prev) =>
      prev.map((o) => {
        if (o.id !== id || o.kind !== 'text') return o;
        const fit = fitTextBox(o.text, o.fontSize, o.fontFamily, o.bold, o.italic);
        // Only widen; keep a single line's original height so it doesn't drop.
        const multiline = o.text.includes('\n');
        return { ...o, w: Math.max(o.w, fit.w), h: multiline ? Math.max(o.h, fit.h) : o.h };
      }),
    );
    setSelectedId(id);
    setEditingId(id);
  }, []);

  const commitEdit = useCallback(() => setEditingId(null), []);

  // Ctrl+Enter / Esc: leave edit mode and drop the selection frame entirely.
  const exitEdit = useCallback(() => {
    setEditingId(null);
    setSelectedId(null);
  }, []);

  // Zoom by a multiplicative factor, clamped to a sane range.
  const zoomBy = useCallback((factor: number) => {
    setScale((s) => Math.min(5, Math.max(0.3, s * factor)));
  }, []);

  const textInput = useCallback(
    (id: ObjectId, text: string) => {
      setObjects((prev) =>
        prev.map((o) => {
          if (o.id !== id || o.kind !== 'text') return o;
          // Grow the box to fit the text (a touch larger) so it never scrolls.
          const fit = fitTextBox(text, o.fontSize, o.fontFamily, o.bold, o.italic);
          // Keep a single line's height so it doesn't drop; grow only for newlines.
          const multiline = text.includes('\n');
          return { ...o, text, w: Math.max(o.w, fit.w), h: multiline ? Math.max(o.h, fit.h) : o.h };
        }),
      );
      // Typing changes an existing line — lift it off the page on the first edit.
      const o = objectsRef.current.find((x) => x.id === id);
      if (o && o.kind === 'text') maybeLiftText({ ...o, text } as TextObject);
    },
    [maybeLiftText],
  );

  // Lift an existing vector out of the page: redact its original line-art (which
  // keeps any text/images that were on top of it), re-render the page, then mark
  // it lifted. After this the page raster no longer shows the original, so the
  // editable overlay is the only copy and the text behind it is exposed.
  const liftVector = useCallback(
    async (o: VectorObject) => {
      const editor = editorRef.current;
      if (!editor) return;
      const ob = o.origBbox;
      await editor.redactLineArt(o.pageIndex, {
        x: ob.x - 1,
        y: ob.y - 1,
        width: ob.width + 2,
        height: ob.height + 2,
      });
      const rp = await editor.renderPage(o.pageIndex, { scale });
      const url = URL.createObjectURL(new Blob([rp.png as BlobPart], { type: 'image/png' }));
      urlsRef.current.push(url);
      setPages((prev) =>
        prev.map((p) =>
          p.pageIndex === o.pageIndex
            ? { pageIndex: p.pageIndex, width: rp.width, height: rp.height, renderedScale: scale, url }
            : p,
        ),
      );
      // The original is gone from the page; refresh the lift cache for re-clicks.
      vectorRef.current.set(o.pageIndex, await editor.getVectorPaths(o.pageIndex));
      clearColorSampleCache();
      setObjects((prev) =>
        prev.map((x) => (x.id === o.id ? ({ ...x, lifted: true } as EditorObject) : x)),
      );
    },
    [scale],
  );

  // End of a group drag: lift the existing vector members off the page (text uses
  // its eraser cover, but a moved vector would otherwise double with its original).
  const endGroupMove = useCallback(
    async (ids: ObjectId[]) => {
      for (const id of ids) {
        const o = objectsRef.current.find((x) => x.id === id);
        if (
          o &&
          o.kind === 'vector' &&
          o.source === 'existing' &&
          !liftedRef.current.has(id) &&
          vectorEdited(o)
        ) {
          liftedRef.current.add(id);
          await liftVector(o);
        }
      }
    },
    [liftVector],
  );

  const updateObject = useCallback(
    (id: ObjectId, patch: Partial<EditorObject>) => {
      const o = objectsRef.current.find((x) => x.id === id);
      // A visual edit (colour/font/size/bold/…) on existing text changes neither
      // its geometry nor its content, so textEdited() can't detect it. Flag it so
      // the line lifts off the page and the editable overlay — not the original
      // raster — renders. Geometry/text edits are still caught by textEdited.
      let eff = patch;
      if (
        o &&
        o.kind === 'text' &&
        o.source === 'existing' &&
        ['color', 'fontFamily', 'fontName', 'fontSize', 'bold', 'italic', 'align', 'lineHeight'].some(
          (k) => k in patch,
        )
      ) {
        eff = { ...patch, edited: true } as Partial<EditorObject>;
      }
      setObjects((prev) => prev.map((x) => (x.id === id ? ({ ...x, ...eff } as EditorObject) : x)));
      // First time an existing element is actually changed, lift it off the page.
      if (o && o.kind === 'vector' && o.source === 'existing' && !liftedRef.current.has(id)) {
        const merged = { ...o, ...eff } as VectorObject;
        if (vectorEdited(merged)) {
          liftedRef.current.add(id);
          void liftVector(merged);
        }
      }
      if (o && o.kind === 'text' && o.source === 'existing') {
        maybeLiftText({ ...o, ...eff } as TextObject);
      }
    },
    [liftVector, maybeLiftText],
  );

  const updateSelected = useCallback(
    (patch: Partial<TextObject>) => {
      if (selectedId) updateObject(selectedId, patch as Partial<EditorObject>);
    },
    [selectedId, updateObject],
  );

  const deleteObject = useCallback(
    (id: ObjectId) => {
      // Truly remove an existing element from the page rather than just covering
      // it — redact a text line's glyphs / a vector's line-art and re-render, so
      // nothing of it (moved or not) lingers on screen or in the export.
      const target = objectsRef.current.find((o) => o.id === id);
      if (
        target &&
        (target.kind === 'text' || target.kind === 'vector') &&
        target.source === 'existing' &&
        !liftedRef.current.has(id)
      ) {
        liftedRef.current.add(id);
        if (target.kind === 'text') void liftText(target);
        else void liftVector(target);
      }
      setObjects((prev) =>
        prev.flatMap((o) => {
          if (o.id !== id) return [o];
          // An existing element is baked into the page; it can't just vanish or
          // the raster shows it again. Keep a tombstone that erases the original
          // on screen and on save. User-added objects are simply dropped.
          if ((o.kind === 'text' || o.kind === 'vector') && o.source === 'existing') {
            return [{ ...o, deleted: true } as EditorObject];
          }
          return [];
        }),
      );
      setSelectedId((s) => (s === id ? null : s));
      setEditingId((e) => (e === id ? null : e));
    },
    [liftText, liftVector],
  );

  const deleteSelected = useCallback(() => {
    if (selectedId) deleteObject(selectedId);
  }, [selectedId, deleteObject]);

  // Copy a snapshot of an object; paste drops a duplicate, offset and selected.
  const copyObject = useCallback((id: ObjectId) => {
    const o = objectsRef.current.find((x) => x.id === id);
    if (o) clipboardRef.current = o;
  }, []);

  const copySelected = useCallback(() => {
    if (selectedId) copyObject(selectedId);
  }, [selectedId, copyObject]);

  const paste = useCallback(() => {
    const o = clipboardRef.current;
    if (!o) return;
    const id = nextId();
    const common = {
      id,
      x: o.x + 12,
      y: o.y + 12,
      pivot: { ...o.pivot },
    };
    const obj: EditorObject =
      o.kind === 'text'
        ? { ...o, ...common, source: 'new', originalBbox: null, originalText: '' }
        : o.kind === 'vector'
          ? { ...o, ...common, source: 'new' }
          : { ...o, ...common };
    setObjects((prev) => [...prev, obj]);
    setSelectedId(id);
    setEditingId(null);
  }, []);

  // Crop: shrink a text box snugly around its text.
  const cropObject = useCallback((id: ObjectId) => {
    setObjects((prev) =>
      prev.map((o) => {
        if (o.id !== id || o.kind !== 'text') return o;
        const width = measureTextWidth(o.text || ' ', o.fontSize, o.fontFamily, o.bold, o.italic);
        const lines = Math.max(1, o.text.split('\n').length);
        return { ...o, w: width + o.fontSize * 0.12, h: lines * o.fontSize * 1.15 };
      }),
    );
  }, []);

  // Reorder in the array; later objects render and bake on top.
  // Layer order = array order (later = on top). These move the element all the
  // way to the front/back in one click — a single-step swap barely changes the
  // visible stacking, so each press makes a decisive jump instead.
  const bringForward = useCallback((id: ObjectId) => {
    setObjects((prev) => {
      const i = prev.findIndex((o) => o.id === id);
      if (i < 0 || i === prev.length - 1) return prev;
      const next = prev.filter((o) => o.id !== id);
      next.push(prev[i]);
      return next;
    });
  }, []);

  const sendBackward = useCallback((id: ObjectId) => {
    setObjects((prev) => {
      const i = prev.findIndex((o) => o.id === id);
      if (i <= 0) return prev;
      const next = prev.filter((o) => o.id !== id);
      next.unshift(prev[i]);
      return next;
    });
  }, []);

  // Keyboard: Del removes, Ctrl+C copies, Ctrl+V pastes (not while in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = !!t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      if (editingId || inField) return; // let fields handle their own keys
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Delete' && selectedId) {
        e.preventDefault();
        deleteObject(selectedId);
      } else if (mod && (e.key === 'c' || e.key === 'C') && selectedId) {
        e.preventDefault();
        copySelected();
      } else if (mod && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        paste();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingId, selectedId, deleteObject, copySelected, paste]);

  // Re-render the page rasters when the zoom changes (objects are in points and
  // re-map automatically). Debounced so a wheel gesture coalesces into one pass.
  useEffect(() => {
    if (scaleInitRef.current) {
      scaleInitRef.current = false;
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const editor = editorRef.current;
      const documentInfo = infoRef.current;
      if (!editor || !documentInfo) return;
      revokeUrls();
      clearColorSampleCache();
      const rendered = await renderAll(editor, documentInfo.pageCount);
      if (!cancelled) setPages(rendered);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scale, renderAll, revokeUrls]);

  useEffect(() => {
    return () => {
      revokeUrls();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [revokeUrls]);

  const selected =
    (objects.find((o) => o.id === selectedId && o.kind === 'text') as TextObject | undefined) ??
    null;
  const selectedObject = objects.find((o) => o.id === selectedId) ?? null;

  return {
    status,
    error,
    info,
    scale,
    pages,
    objects,
    fonts,
    documentFonts,
    documentSizes,
    documentColors,
    lineRects,
    vectorRects,
    selectedId,
    editingId,
    selected,
    selectedObject,
    open,
    save,
    editExistingAt,
    selectVectorAt,
    selectAt,
    groupIds,
    selectInBox,
    moveGroup,
    endGroupMove,
    enterEditMode,
    addTextAt,
    addShapeAt,
    addImage,
    select,
    startEdit,
    commitEdit,
    exitEdit,
    textInput,
    updateObject,
    updateSelected,
    deleteSelected,
    deleteObject,
    bringForward,
    sendBackward,
    cropObject,
    copyObject,
    paste,
    zoomBy,
  };
}
