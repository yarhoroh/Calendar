/**
 * PdfEditor — the framework-agnostic facade over the MuPDF worker.
 *
 * Knows nothing about React or the DOM beyond Worker/File. Owns the worker
 * lifecycle and turns the message protocol into a clean async API. This is the
 * object you embed in any app; the React layer is a thin shell on top of it.
 */
import type {
  DocumentInfo,
  EmbeddedFont,
  FormField,
  ImageBlock,
  PdfSource,
  Rect,
  RenderedPage,
  RenderOptions,
  ReplaceLineParams,
  SaveMode,
  TextBlock,
  TextLine,
  TextOverlay,
  TextSpan,
  VectorPath,
} from '../types.js';
import type {
  ReadyMessage,
  RequestEnvelope,
  ResponseEnvelope,
  WorkerRequestMap,
  WorkerRequestType,
} from '../worker/protocol.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class PdfEditor {
  private readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<void>;
  private disposed = false;

  private constructor() {
    this.worker = new Worker(new URL('../worker/mupdf.worker.ts', import.meta.url), {
      type: 'module',
    });

    this.ready = new Promise<void>((resolve) => {
      const onReady = (event: MessageEvent<ReadyMessage>) => {
        if (event.data?.type === '__ready__') {
          this.worker.removeEventListener('message', onReady);
          resolve();
        }
      };
      this.worker.addEventListener('message', onReady);
    });

    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('error', this.onError);
  }

  /** Spawn the worker and wait until the WASM engine is initialized. */
  static async create(): Promise<PdfEditor> {
    const editor = new PdfEditor();
    await editor.ready;
    return editor;
  }

  // ---- public API ---------------------------------------------------------

  async open(source: PdfSource | File): Promise<DocumentInfo> {
    const data = await toArrayBuffer(source);
    return this.request('open', { data }, [data]);
  }

  getPageCount(): Promise<number> {
    return this.request('getPageCount', undefined);
  }

  async renderPage(pageIndex: number, options: RenderOptions = {}): Promise<RenderedPage> {
    const scale = options.scale ?? 1.5;
    const wire = await this.request('renderPage', { pageIndex, scale });
    return {
      pageIndex: wire.pageIndex,
      width: wire.width,
      height: wire.height,
      png: new Uint8Array(wire.png),
    };
  }

  getPageText(pageIndex: number): Promise<TextSpan[]> {
    return this.request('getPageText', { pageIndex });
  }

  /** Existing text lines on a page, each with the style needed to re-render it. */
  getTextLayout(pageIndex: number): Promise<TextLine[]> {
    return this.request('getTextLayout', { pageIndex });
  }

  /** Existing text as paragraphs/blocks (multi-line), each with style + font name. */
  getTextBlocks(pageIndex: number): Promise<TextBlock[]> {
    return this.request('getTextBlocks', { pageIndex });
  }

  /** Vector shapes (fills & strokes) drawn on a page, for click-to-edit. */
  getVectorPaths(pageIndex: number): Promise<VectorPath[]> {
    return this.request('getVectorPaths', { pageIndex });
  }

  /** Images drawn on a page (box + PNG bytes), so a baked/embedded picture is selectable. */
  getImages(pageIndex: number): Promise<ImageBlock[]> {
    return this.request('getImages', { pageIndex });
  }

  /** Replace one line of existing text in place (erase original, restyle new). */
  replaceLine(params: ReplaceLineParams): Promise<null> {
    return this.request('replaceLine', params);
  }

  getFormFields(): Promise<FormField[]> {
    return this.request('getFormFields', undefined);
  }

  setFormField(name: string, value: string): Promise<null> {
    return this.request('setFormField', { name, value });
  }

  addTextOverlay(overlay: TextOverlay): Promise<null> {
    return this.request('addTextOverlay', overlay);
  }

  /** Stamp an image onto a page at the given box (PDF points). */
  insertImage(pageIndex: number, rect: Rect, bytes: Uint8Array): Promise<null> {
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return this.request('insertImage', { pageIndex, rect, data }, [data]);
  }

  /** PostScript names of every font used in the document (for the font picker). */
  getDocumentFonts(): Promise<string[]> {
    return this.request('getDocumentFonts', undefined);
  }

  /** The actual font programs embedded in the PDF, for one-to-one text editing. */
  getEmbeddedFonts(): Promise<EmbeddedFont[]> {
    return this.request('getEmbeddedFonts', undefined);
  }

  redactRect(pageIndex: number, rect: Rect): Promise<null> {
    return this.request('redactRect', { pageIndex, rect });
  }

  /** Erase only the text glyphs covered by the box, keeping images & line-art. */
  redactText(pageIndex: number, rect: Rect): Promise<null> {
    return this.request('redactText', { pageIndex, rect });
  }

  /** Erase only vector line-art covered by the box, leaving text & images. */
  redactLineArt(pageIndex: number, rect: Rect): Promise<null> {
    return this.request('redactLineArt', { pageIndex, rect });
  }

  /** Erase many vector shapes at once (one redaction pass), keeping text/images. */
  redactLineArtBatch(pageIndex: number, rects: Rect[]): Promise<null> {
    return this.request('redactLineArtBatch', { pageIndex, rects });
  }

  /** Paint a solid colour rectangle (e.g. a text field's background). */
  fillRect(pageIndex: number, rect: Rect, color: [number, number, number]): Promise<null> {
    return this.request('fillRect', { pageIndex, rect, color });
  }

  /**
   * Replace existing text in a rectangle: redact it away, then drop new text
   * on top — the same mechanism Acrobat uses under the hood.
   */
  async replaceText(overlay: TextOverlay): Promise<void> {
    await this.redactRect(overlay.pageIndex, overlay.rect);
    await this.addTextOverlay(overlay);
  }

  async save(mode: SaveMode = 'incremental'): Promise<Uint8Array> {
    const buffer = await this.request('save', { mode });
    return new Uint8Array(buffer);
  }

  /** Terminate the worker. The instance is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error('PdfEditor disposed'));
    }
    this.pending.clear();
    this.worker.terminate();
  }

  // ---- transport ----------------------------------------------------------

  private request<T extends WorkerRequestType>(
    type: T,
    params: WorkerRequestMap[T]['params'],
    transfer: Transferable[] = [],
  ): Promise<WorkerRequestMap[T]['result']> {
    if (this.disposed) {
      return Promise.reject(new Error('PdfEditor disposed'));
    }
    const id = ++this.seq;
    const envelope: RequestEnvelope<T> = { id, type, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject });
      this.worker.postMessage(envelope, transfer);
    });
  }

  private readonly onMessage = (event: MessageEvent<ResponseEnvelope | ReadyMessage>) => {
    const data = event.data;
    if (!data || !('id' in data)) return; // ready/other handled elsewhere
    const entry = this.pending.get(data.id);
    if (!entry) return;
    this.pending.delete(data.id);
    if (data.ok) {
      entry.resolve(data.result);
    } else {
      entry.reject(new Error(data.error));
    }
  };

  private readonly onError = (event: ErrorEvent) => {
    const error = new Error(event.message || 'PDF worker crashed');
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  };
}

async function toArrayBuffer(source: PdfSource | File): Promise<ArrayBuffer> {
  if (source instanceof ArrayBuffer) return source;
  if (typeof File !== 'undefined' && source instanceof File) return source.arrayBuffer();
  const view = source as Uint8Array;
  // Copy out an exact-length ArrayBuffer so we can transfer it safely.
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}
