/**
 * Bake a rotated object (text or image) into a PNG so it can be stamped into the
 * PDF at the right place. Rotation is hard to express for FreeText/Stamp
 * annotations, so a rotated object is flattened to an image covering its rotated
 * bounding box. Un-rotated objects keep their crisp vector/native path.
 */
import type { Rect } from '../../types.js';
import { cssColor, type EditorObject } from './objects.js';

const RASTER_SCALE = 3; // supersample for crisp output

/** Trace a rounded-rect path (radius clamped to half the shorter side). */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for rasterization'));
    img.src = src;
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('canvas.toBlob returned null'));
      blob
        .arrayBuffer()
        .then((buf) => resolve(new Uint8Array(buf)))
        .catch(reject);
    }, 'image/png');
  });
}

/** Render `obj` rotated onto a transparent canvas; return the PNG bytes and the
 *  axis-aligned bounding box (PDF points) it should occupy on the page. */
export async function rasterizeRotated(
  obj: EditorObject,
): Promise<{ rect: Rect; bytes: Uint8Array }> {
  const rad = (obj.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const wpt = obj.w;
  const hpt = obj.h;
  // Pivot offset from the box top-left, in points.
  const pvx = obj.pivot.x * wpt;
  const pvy = obj.pivot.y * hpt;

  // Rotate the 4 corners about the pivot; their bounds give the stamp box.
  const corners = [
    [0, 0],
    [wpt, 0],
    [wpt, hpt],
    [0, hpt],
  ].map(([cx, cy]) => {
    const dx = cx - pvx;
    const dy = cy - pvy;
    return [dx * cos - dy * sin, dx * sin + dy * cos];
  });
  const minX = Math.min(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxX = Math.max(...corners.map((c) => c[0]));
  const maxY = Math.max(...corners.map((c) => c[1]));
  const bw = maxX - minX;
  const bh = maxY - minY;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(bw * RASTER_SCALE));
  canvas.height = Math.max(1, Math.ceil(bh * RASTER_SCALE));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  // Place the pivot at the canvas origin, rotate, then draw the box relative
  // to the pivot (its top-left is at (-pvx,-pvy)).
  ctx.translate(-minX * RASTER_SCALE, -minY * RASTER_SCALE);
  ctx.rotate(rad);
  ctx.scale(RASTER_SCALE, RASTER_SCALE);

  if (obj.kind === 'image') {
    const img = await loadImage(obj.src);
    ctx.drawImage(img, -pvx, -pvy, wpt, hpt);
  } else if (obj.kind === 'rect') {
    if (obj.background) {
      ctx.fillStyle = cssColor(obj.background);
      roundRectPath(ctx, -pvx, -pvy, wpt, hpt, obj.radius);
      ctx.fill();
    }
  } else if (obj.kind === 'vector') {
    const ob = obj.origBbox;
    const sx = wpt / Math.max(ob.width, 0.01);
    const sy = hpt / Math.max(ob.height, 0.01);
    let d = '';
    for (const s of obj.segs) {
      if (s.op === 'Z') {
        d += 'Z';
        continue;
      }
      const parts: string[] = [];
      for (let i = 0; i < s.pts.length; i += 2) {
        parts.push(`${(s.pts[i] - ob.x) * sx} ${(s.pts[i + 1] - ob.y) * sy}`);
      }
      d += s.op + parts.join(' ');
    }
    const path = new Path2D(d);
    ctx.save();
    ctx.translate(-pvx, -pvy);
    if (obj.fill) {
      ctx.fillStyle = cssColor(obj.fill);
      ctx.fill(path, obj.evenOdd ? 'evenodd' : 'nonzero');
    }
    if (obj.stroke) {
      ctx.strokeStyle = cssColor(obj.stroke);
      ctx.lineWidth = obj.strokeWidth * ((sx + sy) / 2);
      ctx.stroke(path);
    }
    ctx.restore();
  } else {
    if (obj.background) {
      ctx.fillStyle = cssColor(obj.background);
      ctx.fillRect(-pvx, -pvy, wpt, hpt);
    }
    ctx.textBaseline = 'top';
    const lineHeight = obj.fontSize * obj.lineHeight;
    if (obj.runs && obj.runs.length > 1) {
      // Rich single line: draw each run in sequence with its own font / colour / horizontal scale.
      let x = -pvx;
      for (const r of obj.runs) {
        ctx.font = `${r.italic ? 'italic ' : ''}${r.bold ? '700 ' : '400 '}${r.fontSize}px ${r.fontFamily}`;
        ctx.fillStyle = cssColor(r.color);
        const sx = r.scaleX && r.scaleX > 0 ? r.scaleX : 1;
        ctx.save();
        ctx.translate(x, -pvy);
        if (sx !== 1) ctx.scale(sx, 1);
        ctx.fillText(r.text, 0, 0);
        ctx.restore();
        x += ctx.measureText(r.text).width * sx + (r.charSpacing || 0) * Math.max(r.text.length - 1, 0);
      }
    } else {
      ctx.font = `${obj.italic ? 'italic ' : ''}${obj.bold ? '700 ' : '400 '}${obj.fontSize}px ${obj.fontFamily}`;
      ctx.fillStyle = cssColor(obj.color);
      obj.text.split('\n').forEach((line, i) => {
        const lw = ctx.measureText(line).width;
        let lx = -pvx; // left edge of the box (in pivot-relative coords)
        if (obj.align === 'center') lx = -pvx + (wpt - lw) / 2;
        else if (obj.align === 'right') lx = -pvx + (wpt - lw);
        ctx.fillText(line, lx, -pvy + i * lineHeight);
      });
    }
  }

  const bytes = await canvasToPng(canvas);
  // The pivot stays fixed in page space; the stamp box is offset by (minX,minY).
  return {
    rect: { x: obj.x + pvx + minX, y: obj.y + pvy + minY, width: bw, height: bh },
    bytes,
  };
}
