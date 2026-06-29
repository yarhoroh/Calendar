/**
 * usePdfEditor — owns a PdfEditor instance and exposes the view state React
 * needs: status, page images, and open/save/edit actions. All MuPDF work is
 * delegated to the facade; this hook only manages lifecycle, object URLs, and a
 * per-page text-layout cache.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PdfEditor } from '../core/PdfEditor.js';
import type { DocumentInfo, PdfSource, SaveMode, TextLine, TextOverlay } from '../types.js';

export type EditorStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RenderedPageView {
  pageIndex: number;
  width: number;
  height: number;
  /** Object URL of the page PNG; revoked automatically on reload/unmount. */
  url: string;
}

export interface UsePdfEditorOptions {
  /** Render scale; 1 == 72 dpi. Default 1.5. */
  scale?: number;
}

export interface UsePdfEditor {
  status: EditorStatus;
  error: string | null;
  info: DocumentInfo | null;
  pages: RenderedPageView[];
  /** The underlying engine, for advanced ops (forms, redaction, overlays). */
  editor: PdfEditor | null;
  open: (source: PdfSource | File) => Promise<void>;
  save: (mode?: SaveMode) => Promise<Uint8Array | null>;
  /** Drop new text onto a page, then repaint that page. */
  addText: (overlay: TextOverlay) => Promise<void>;
  /** Existing text lines on a page (cached) — for click-to-edit hit testing. */
  getTextLayout: (pageIndex: number) => Promise<TextLine[]>;
  /** Replace one existing line in place, then repaint that page. */
  replaceLine: (pageIndex: number, line: TextLine, newText: string) => Promise<void>;
}

export function usePdfEditor(options: UsePdfEditorOptions = {}): UsePdfEditor {
  const scale = options.scale ?? 1.5;

  const editorRef = useRef<PdfEditor | null>(null);
  const urlsRef = useRef<string[]>([]);
  const layoutCache = useRef<Map<number, TextLine[]>>(new Map());

  const [status, setStatus] = useState<EditorStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<DocumentInfo | null>(null);
  const [pages, setPages] = useState<RenderedPageView[]>([]);

  const revokeUrls = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  const ensureEditor = useCallback(async (): Promise<PdfEditor> => {
    if (!editorRef.current) editorRef.current = await PdfEditor.create();
    return editorRef.current;
  }, []);

  const renderToUrl = useCallback(
    async (editor: PdfEditor, pageIndex: number): Promise<RenderedPageView> => {
      const page = await editor.renderPage(pageIndex, { scale });
      const url = URL.createObjectURL(new Blob([page.png as BlobPart], { type: 'image/png' }));
      urlsRef.current.push(url);
      return { pageIndex, width: page.width, height: page.height, url };
    },
    [scale],
  );

  /** Repaint one page in place and drop its stale text-layout cache. */
  const repaintPage = useCallback(
    async (editor: PdfEditor, pageIndex: number): Promise<void> => {
      layoutCache.current.delete(pageIndex);
      const updated = await renderToUrl(editor, pageIndex);
      setPages((prev) =>
        prev.map((p) => {
          if (p.pageIndex !== pageIndex) return p;
          URL.revokeObjectURL(p.url);
          return updated;
        }),
      );
    },
    [renderToUrl],
  );

  const open = useCallback(
    async (source: PdfSource | File): Promise<void> => {
      setStatus('loading');
      setError(null);
      try {
        const editor = await ensureEditor();
        const documentInfo = await editor.open(source);
        revokeUrls();
        layoutCache.current.clear();
        setPages([]);
        const rendered: RenderedPageView[] = [];
        for (let i = 0; i < documentInfo.pageCount; i++) {
          rendered.push(await renderToUrl(editor, i));
        }
        setInfo(documentInfo);
        setPages(rendered);
        setStatus('ready');
      } catch (err) {
        revokeUrls();
        setPages([]);
        setInfo(null);
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    },
    [ensureEditor, renderToUrl, revokeUrls],
  );

  const save = useCallback(async (mode: SaveMode = 'incremental'): Promise<Uint8Array | null> => {
    const editor = editorRef.current;
    if (!editor) return null;
    return editor.save(mode);
  }, []);

  const addText = useCallback(
    async (overlay: TextOverlay): Promise<void> => {
      const editor = editorRef.current;
      if (!editor) return;
      await editor.addTextOverlay(overlay);
      await repaintPage(editor, overlay.pageIndex);
    },
    [repaintPage],
  );

  const getTextLayout = useCallback(async (pageIndex: number): Promise<TextLine[]> => {
    const editor = editorRef.current;
    if (!editor) return [];
    const cached = layoutCache.current.get(pageIndex);
    if (cached) return cached;
    const lines = await editor.getTextLayout(pageIndex);
    layoutCache.current.set(pageIndex, lines);
    return lines;
  }, []);

  const replaceLine = useCallback(
    async (pageIndex: number, line: TextLine, newText: string): Promise<void> => {
      const editor = editorRef.current;
      if (!editor) return;
      await editor.replaceLine({
        pageIndex,
        bbox: line.bbox,
        text: newText,
        fontSize: line.fontSize,
        color: line.color,
        bold: line.bold,
        italic: line.italic,
        serif: line.serif,
      });
      await repaintPage(editor, pageIndex);
    },
    [repaintPage],
  );

  // Tear down the worker and any object URLs when the host component unmounts.
  useEffect(() => {
    return () => {
      revokeUrls();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [revokeUrls]);

  return {
    status,
    error,
    info,
    pages,
    editor: editorRef.current,
    open,
    save,
    addText,
    getTextLayout,
    replaceLine,
  };
}
