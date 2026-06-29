/**
 * Typed request/response protocol between the PdfEditor facade and the MuPDF
 * worker. Each command lists its params and result type; the facade and worker
 * both index this single map, so they can never drift out of sync.
 */
import type {
  DocumentInfo,
  EmbeddedFont,
  FormField,
  ImageBlock,
  Rect,
  ReplaceLineParams,
  SaveMode,
  TextBlock,
  TextLine,
  TextOverlay,
  TextSpan,
  VectorPath,
} from '../types.js';

/** Render result on the wire: PNG travels as a transferable ArrayBuffer. */
export interface RenderedPageWire {
  pageIndex: number;
  width: number;
  height: number;
  png: ArrayBuffer;
}

export interface WorkerRequestMap {
  open: { params: { data: ArrayBuffer }; result: DocumentInfo };
  getPageCount: { params: undefined; result: number };
  renderPage: { params: { pageIndex: number; scale: number }; result: RenderedPageWire };
  getPageText: { params: { pageIndex: number }; result: TextSpan[] };
  getTextLayout: { params: { pageIndex: number }; result: TextLine[] };
  getTextBlocks: { params: { pageIndex: number }; result: TextBlock[] };
  getVectorPaths: { params: { pageIndex: number }; result: VectorPath[] };
  getImages: { params: { pageIndex: number }; result: ImageBlock[] };
  replaceLine: { params: ReplaceLineParams; result: null };
  getFormFields: { params: undefined; result: FormField[] };
  setFormField: { params: { name: string; value: string }; result: null };
  addTextOverlay: { params: TextOverlay; result: null };
  insertImage: { params: { pageIndex: number; rect: Rect; data: ArrayBuffer }; result: null };
  getDocumentFonts: { params: undefined; result: string[] };
  getEmbeddedFonts: { params: undefined; result: EmbeddedFont[] };
  redactRect: { params: { pageIndex: number; rect: Rect }; result: null };
  redactText: { params: { pageIndex: number; rect: Rect }; result: null };
  redactLineArt: { params: { pageIndex: number; rect: Rect }; result: null };
  redactLineArtBatch: { params: { pageIndex: number; rects: Rect[] }; result: null };
  fillRect: {
    params: { pageIndex: number; rect: Rect; color: [number, number, number] };
    result: null;
  };
  save: { params: { mode: SaveMode }; result: ArrayBuffer };
  close: { params: undefined; result: null };
}

export type WorkerRequestType = keyof WorkerRequestMap;

export interface RequestEnvelope<T extends WorkerRequestType = WorkerRequestType> {
  id: number;
  type: T;
  params: WorkerRequestMap[T]['params'];
}

export type ResponseEnvelope =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** Sent once by the worker after the WASM module has initialized. */
export interface ReadyMessage {
  type: '__ready__';
}
