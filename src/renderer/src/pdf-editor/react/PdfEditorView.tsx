/**
 * PdfEditorView — the full object-based PDF editor surface.
 *
 * Toolbar: Open / Save, then tools — Edit text (click existing text to pick it
 * up with its style), Add text, Add image. Selected text shows a style panel
 * (font / size / bold / italic / colour). Objects can be dragged and resized
 * on the page and are baked into the PDF on save.
 *
 * Open/Save can be overridden by the host (Electron path dialogs); otherwise a
 * file picker and a browser download are used.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, MouseEvent, ReactElement } from 'react';
import type { PdfSource, SaveMode } from '../types.js';
import { useDocumentEditor } from './editor/useDocumentEditor.js';
import { ObjectLayer } from './editor/ObjectLayer.js';
import { StylePanel, ShapePanel, VectorPanel } from './editor/StylePanel.js';

export interface OpenedFile {
  name: string;
  data: PdfSource;
}

export interface PdfEditorViewProps {
  source?: PdfSource | File;
  fileName?: string;
  scale?: number;
  saveMode?: SaveMode;
  onRequestOpen?: () => Promise<OpenedFile | null>;
  onRequestSave?: (bytes: Uint8Array, suggestedName: string) => void | Promise<void>;
  className?: string;
  style?: CSSProperties;
}

type Tool = 'view' | 'edit' | 'text' | 'image' | 'shape';

export function PdfEditorView(props: PdfEditorViewProps): ReactElement {
  const { source, saveMode = 'rewrite', onRequestOpen, onRequestSave } = props;
  const ed = useDocumentEditor({ scale: props.scale });
  const scale = ed.scale;
  const zoomBy = ed.zoomBy;

  const [fileName, setFileName] = useState(props.fileName ?? 'document.pdf');
  const [dragging, setDragging] = useState(false);
  const [tool, setTool] = useState<Tool>('view');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const imgInputRef = useRef<HTMLInputElement | null>(null);
  const pendingImage = useRef<File | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const zoomAnchorRef = useRef<{
    ox: number;
    oy: number;
    scrollLeft0: number;
    scrollTop0: number;
    s0: number;
  } | null>(null);

  useEffect(() => {
    if (source !== undefined) void ed.open(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Ctrl + mouse wheel zooms — and ONLY zooms. Capture-phase, non-passive
  // listener on window so we cancel the scroll/zoom default before any element
  // (the viewport scroller, the browser) can act on the wheel.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // plain wheel scrolls normally
      e.preventDefault();
      e.stopPropagation();
      // Remember the point under the cursor so we can keep it fixed after zoom.
      const el = viewportRef.current;
      if (el) {
        const vr = el.getBoundingClientRect();
        zoomAnchorRef.current = {
          ox: Math.max(0, Math.min(vr.width, e.clientX - vr.left)),
          oy: Math.max(0, Math.min(vr.height, e.clientY - vr.top)),
          scrollLeft0: el.scrollLeft,
          scrollTop0: el.scrollTop,
          s0: scaleRef.current,
        };
      }
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    const opts = { passive: false, capture: true };
    window.addEventListener('wheel', onWheel, opts);
    return () => window.removeEventListener('wheel', onWheel, opts);
  }, [zoomBy]);

  // After the new scale lays out, scroll so the cursor's document point stays
  // put (zoom-to-cursor). The page divs resize synchronously with `scale`, so
  // measuring/adjusting here is exact for the visible layout.
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const el = viewportRef.current;
    if (!anchor || !el) return;
    zoomAnchorRef.current = null;
    const f = scale / anchor.s0;
    el.scrollLeft = (anchor.scrollLeft0 + anchor.ox) * f - anchor.ox;
    el.scrollTop = (anchor.scrollTop0 + anchor.oy) * f - anchor.oy;
  }, [scale]);

  // Hold Space to pan the (zoomed/scrolled) document like a hand tool.
  useEffect(() => {
    // Only text fields legitimately consume Space; everywhere else it pans.
    const isTextField = (t: EventTarget | null) =>
      t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTextField(e.target)) return;
      // Kill the default on EVERY Space keydown (incl. OS auto-repeat) so the
      // browser never scrolls a page-down underneath the hand-drag.
      e.preventDefault();
      if (e.repeat) return;
      // Drop focus off any button so Space can't re-trigger it.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
      setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const onPanMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const el = viewportRef.current;
      if (!spaceHeld || !el) return;
      e.preventDefault();
      setPanning(true);
      panRef.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      const move = (ev: globalThis.MouseEvent) => {
        const p = panRef.current;
        if (!p || !viewportRef.current) return;
        viewportRef.current.scrollLeft = p.left - (ev.clientX - p.x);
        viewportRef.current.scrollTop = p.top - (ev.clientY - p.y);
      };
      const up = () => {
        panRef.current = null;
        setPanning(false);
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [spaceHeld],
  );

  const loadFile = useCallback(
    (file: File) => {
      setFileName(file.name);
      void ed.open(file);
    },
    [ed],
  );

  const handleOpen = useCallback(async () => {
    if (onRequestOpen) {
      const result = await onRequestOpen();
      if (result) {
        setFileName(result.name);
        void ed.open(result.data);
      }
      return;
    }
    pdfInputRef.current?.click();
  }, [onRequestOpen, ed]);

  const handleSave = useCallback(async () => {
    const bytes = await ed.save(saveMode);
    if (!bytes) return;
    if (onRequestSave) {
      await onRequestSave(bytes, fileName);
      return;
    }
    downloadBytes(bytes, fileName);
  }, [ed, saveMode, onRequestSave, fileName]);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files[0];
      if (file && file.type === 'application/pdf') loadFile(file);
    },
    [loadFile],
  );

  // --- rubber-band (marquee) selection on empty page space -----------------
  const [marquee, setMarquee] = useState<{
    pageIndex: number;
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  // Live drag bounds (container-relative px) + the click-suppression flag.
  const marqueeDrag = useRef<{
    pageIndex: number;
    left: number;
    top: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const suppressClick = useRef(false);

  const onPageMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>, pageIndex: number) => {
      // Only an empty-space left press starts a marquee. Materialised objects swallow
      // the press via their frame; a press that lands on an (unmaterialised) text line
      // is a single click-to-select, not a rubber-band — otherwise hand jitter on the
      // text would group it with the vector underneath. Vectors are NOT treated as
      // content here: a page background is one big vector and would block the marquee.
      if (tool !== 'edit' || event.button !== 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const px = x / scale;
      const py = y / scale;
      const overText = (ed.lineRects[pageIndex] ?? []).some(
        (r) => px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height,
      );
      if (overText) return;
      marqueeDrag.current = { pageIndex, left: rect.left, top: rect.top, x0: x, y0: y, x1: x, y1: y };
      setMarquee({ pageIndex, x, y, w: 0, h: 0 });
    },
    [tool, scale, ed],
  );

  useEffect(() => {
    if (!marquee) return;
    const move = (e: globalThis.MouseEvent) => {
      const d = marqueeDrag.current;
      if (!d) return;
      d.x1 = e.clientX - d.left;
      d.y1 = e.clientY - d.top;
      setMarquee({
        pageIndex: d.pageIndex,
        x: Math.min(d.x0, d.x1),
        y: Math.min(d.y0, d.y1),
        w: Math.abs(d.x1 - d.x0),
        h: Math.abs(d.y1 - d.y0),
      });
    };
    const up = () => {
      const d = marqueeDrag.current;
      marqueeDrag.current = null;
      setMarquee(null);
      if (!d) return;
      const w = Math.abs(d.x1 - d.x0);
      const h = Math.abs(d.y1 - d.y0);
      if (w > 3 && h > 3) {
        suppressClick.current = true; // the trailing click must not deselect
        void ed.selectInBox(d.pageIndex, {
          x: Math.min(d.x0, d.x1) / scale,
          y: Math.min(d.y0, d.y1) / scale,
          width: w / scale,
          height: h / scale,
        });
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [marquee !== null, scale, ed]);

  const onPageClick = useCallback(
    (event: MouseEvent<HTMLDivElement>, pageIndex: number) => {
      if (suppressClick.current) {
        suppressClick.current = false; // swallow the click that ends a marquee drag
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const pageX = (event.clientX - rect.left) / scale;
      const pageY = (event.clientY - rect.top) / scale;
      if (tool === 'edit') {
        if (event.ctrlKey) {
          // Ctrl + double-click inserts a new text box right here.
          if (event.detail >= 2) ed.addTextAt(pageIndex, pageX, pageY);
        } else {
          // Resolve the click by geometry: pick the smallest element (text line
          // or vector) whose bbox is under the cursor. event.detail === 2 → edit.
          void ed.selectAt(pageIndex, pageX, pageY, event.detail >= 2);
        }
      } else if (tool === 'text') {
        ed.addTextAt(pageIndex, pageX, pageY);
        setTool('view');
      } else if (tool === 'shape') {
        ed.addShapeAt(pageIndex, pageX, pageY);
        setTool('view');
      } else if (tool === 'image' && pendingImage.current) {
        void ed.addImage(pageIndex, pendingImage.current, pageX, pageY);
        pendingImage.current = null;
        setTool('view');
      } else {
        ed.select(null);
      }
    },
    [tool, scale, ed],
  );

  const toggleTool = useCallback(
    (next: Tool) => {
      ed.select(null);
      setTool((prev) => (prev === next ? 'view' : next));
    },
    [ed],
  );

  const status = ed.status;
  const hint =
    tool === 'edit'
      ? 'Кликните по тексту или фигуре — появится рамка; двойной клик по тексту для правки'
      : tool === 'text'
        ? 'Кликните, где впечатать текст'
        : tool === 'shape'
          ? 'Кликните, куда вставить рамку'
          : tool === 'image'
            ? 'Кликните, куда вставить картинку'
            : ed.info
            ? `${ed.info.pageCount} стр.`
            : '';

  return (
    <div
      className={props.className}
      style={{ ...styles.root, ...props.style }}
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragging(false);
      }}
    >
      <div style={styles.toolbar}>
        <button type="button" style={styles.button} onClick={handleOpen}>
          Открыть
        </button>
        <button
          type="button"
          style={styles.button}
          onClick={handleSave}
          disabled={status !== 'ready'}
        >
          Сохранить
        </button>
        <span style={styles.divider} />
        <button
          type="button"
          style={tool === 'edit' ? styles.buttonActive : styles.button}
          onClick={() => toggleTool('edit')}
          disabled={status !== 'ready'}
        >
          ✎ Править текст
        </button>
        <button
          type="button"
          style={tool === 'text' ? styles.buttonActive : styles.button}
          onClick={() => toggleTool('text')}
          disabled={status !== 'ready'}
        >
          ➕ Текст
        </button>
        <button
          type="button"
          style={tool === 'image' ? styles.buttonActive : styles.button}
          onClick={() => {
            ed.select(null);
            imgInputRef.current?.click();
          }}
          disabled={status !== 'ready'}
        >
          🖼 Картинка
        </button>
        <button
          type="button"
          style={tool === 'shape' ? styles.buttonActive : styles.button}
          onClick={() => toggleTool('shape')}
          disabled={status !== 'ready'}
        >
          ▭ Рамка
        </button>
        <span style={styles.divider} />
        <button
          type="button"
          style={styles.button}
          onClick={() => zoomBy(1 / 1.15)}
          disabled={status !== 'ready'}
          title="Уменьшить (Ctrl+колесо)"
        >
          −
        </button>
        <span style={styles.zoom}>{Math.round(scale * 100)}%</span>
        <button
          type="button"
          style={styles.button}
          onClick={() => zoomBy(1.15)}
          disabled={status !== 'ready'}
          title="Увеличить (Ctrl+колесо)"
        >
          +
        </button>
        <input
          ref={pdfInputRef}
          type="file"
          accept="application/pdf,.pdf"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) loadFile(file);
            event.target.value = '';
          }}
        />
        <input
          ref={imgInputRef}
          type="file"
          accept="image/png,image/jpeg"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              pendingImage.current = file;
              setTool('image');
            }
            event.target.value = '';
          }}
        />
      </div>

      {/* Always-present second row so selecting an object never changes the
          header height (no layout jitter). Holds the style panel or a hint. */}
      <div style={styles.subbar}>
        {ed.selected ? (
          <StylePanel
            object={ed.selected}
            fonts={ed.fonts}
            documentFonts={ed.documentFonts}
            documentSizes={ed.documentSizes}
            documentColors={ed.documentColors}
            onChange={ed.updateSelected}
            onDelete={ed.deleteSelected}
          />
        ) : ed.selectedObject?.kind === 'rect' ? (
          <ShapePanel
            object={ed.selectedObject}
            onChange={(patch) => ed.updateObject(ed.selectedObject!.id, patch)}
            onDelete={ed.deleteSelected}
          />
        ) : ed.selectedObject?.kind === 'vector' ? (
          <VectorPanel
            object={ed.selectedObject}
            onChange={(patch) => ed.updateObject(ed.selectedObject!.id, patch)}
            onDelete={ed.deleteSelected}
          />
        ) : (
          <span style={styles.subhint}>
            {status === 'loading'
              ? 'Загрузка…'
              : status === 'error'
                ? `Ошибка: ${ed.error}`
                : hint || 'Кликните по тексту, чтобы выделить; двойной клик — правка'}
          </span>
        )}
      </div>

      <div
        style={{
          ...styles.viewport,
          cursor: spaceHeld ? (panning ? 'grabbing' : 'grab') : undefined,
        }}
        ref={viewportRef}
        onMouseDown={onPanMouseDown}
      >
        <div style={styles.pagesWrap}>
        {ed.pages.length === 0 && status !== 'loading' ? (
          <div style={styles.placeholder}>Перетащите PDF сюда или нажмите «Открыть»</div>
        ) : (
          ed.pages.map((page) => {
            // Stretch the (possibly stale-scale) raster to the current zoom so it
            // and the overlay stay aligned until the crisp re-render lands.
            const k = scale / page.renderedScale;
            const dispW = page.width * k;
            const dispH = page.height * k;
            return (
            <div
              key={page.pageIndex}
              style={{
                ...styles.page,
                width: dispW,
                height: dispH,
                cursor: tool === 'view' ? 'default' : 'crosshair',
                // While panning, let drags fall through to the viewport.
                pointerEvents: spaceHeld ? 'none' : undefined,
              }}
              onMouseDown={(event) => onPageMouseDown(event, page.pageIndex)}
              onClick={(event) => onPageClick(event, page.pageIndex)}
            >
              <img
                src={page.url}
                width={dispW}
                height={dispH}
                style={styles.pageImg}
                alt={`Страница ${page.pageIndex + 1}`}
                draggable={false}
              />
              <ObjectLayer
                scale={scale}
                objects={ed.objects.filter((o) => o.pageIndex === page.pageIndex)}
                selectedId={ed.selectedId}
                editingId={ed.editingId}
                onSelect={ed.select}
                onStartEdit={ed.startEdit}
                onChange={ed.updateObject}
                onTextInput={ed.textInput}
                onCommit={ed.commitEdit}
                onExitEdit={ed.exitEdit}
                onDelete={ed.deleteObject}
                onBringForward={ed.bringForward}
                onSendBackward={ed.sendBackward}
                onCrop={ed.cropObject}
                onCopy={ed.copyObject}
                onPaste={ed.paste}
                guideLines={ed.lineRects[page.pageIndex] ?? []}
                vectorOutlines={ed.vectorRects[page.pageIndex] ?? []}
                showOutlines={tool === 'edit'}
                groupIds={ed.groupIds}
                onGroupMove={ed.moveGroup}
                onGroupMoveEnd={ed.endGroupMove}
                pageUrl={page.url}
              />
              {marquee && marquee.pageIndex === page.pageIndex && (
                <div
                  style={{
                    position: 'absolute',
                    left: marquee.x,
                    top: marquee.y,
                    width: marquee.w,
                    height: marquee.h,
                    border: '1px solid #2878dc',
                    background: 'rgba(40,120,220,0.12)',
                    pointerEvents: 'none',
                    zIndex: 50,
                  }}
                />
              )}
            </div>
            );
          })
        )}
        </div>
      </div>

      {dragging && <div style={styles.dropOverlay}>Отпустите PDF</div>}
    </div>
  );
}

function downloadBytes(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const styles: Record<string, CSSProperties> = {
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    fontFamily: 'system-ui, sans-serif',
    background: '#f3f3f3',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: 8,
    borderBottom: '1px solid #d0d0d0',
    background: '#fff',
    flex: '0 0 auto',
    flexWrap: 'nowrap',
    overflowX: 'auto',
  },
  subbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 10px',
    minHeight: 44,
    borderBottom: '1px solid #e2e2e2',
    background: '#fafafa',
    flex: '0 0 auto',
  },
  subhint: { fontSize: 13, color: '#666' },
  button: {
    padding: '6px 12px',
    fontSize: 14,
    cursor: 'pointer',
    border: '1px solid #bbb',
    borderRadius: 4,
    background: '#fafafa',
  },
  buttonActive: {
    padding: '6px 12px',
    fontSize: 14,
    cursor: 'pointer',
    border: '1px solid #2878dc',
    borderRadius: 4,
    background: '#2878dc',
    color: '#fff',
  },
  divider: { width: 1, height: 22, background: '#ddd', margin: '0 4px' },
  zoom: { fontSize: 13, color: '#444', minWidth: 46, textAlign: 'center' },
  status: { marginLeft: 8, fontSize: 13, color: '#555' },
  viewport: {
    flex: '1 1 auto',
    overflow: 'auto',
    display: 'flex',
  },
  // margin:auto centres the pages when they fit and, crucially, collapses to 0
  // when they're wider/taller than the viewport — so the left/top stays
  // reachable by scrolling at any zoom (unlike align-items:center).
  pagesWrap: {
    margin: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: 16,
  },
  page: {
    position: 'relative',
    flex: '0 0 auto',
    boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
    background: '#fff',
  },
  pageImg: { display: 'block', userSelect: 'none' },
  placeholder: { margin: 'auto', color: '#888', fontSize: 15 },
  dropOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(40,120,220,0.12)',
    border: '3px dashed #2878dc',
    color: '#1a5cb0',
    fontSize: 18,
    pointerEvents: 'none',
  },
};
