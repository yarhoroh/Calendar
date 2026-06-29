/**
 * Sample the dominant (background) colour of a rectangle in a rendered page, so
 * erasing existing text can restore that colour instead of a white hole. Text is
 * a minority of the pixels in its own box, so the most frequent colour is the
 * background.
 */
const pageCanvas = (() => {
  let canvas: HTMLCanvasElement | null = null;
  return () => {
    if (!canvas) canvas = document.createElement('canvas');
    return canvas;
  };
})();

const imageDataCache = new Map<string, ImageData>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('sampleColor: image load failed'));
    img.src = src;
  });
}

/** Cache the page's pixels keyed by its object URL (changes on every re-render).
 *  Never throws: any load/read failure resolves to null so callers fall back to
 *  white instead of rejecting (a rejected sample must not break selection). */
async function pageImageData(url: string): Promise<ImageData | null> {
  const cached = imageDataCache.get(url);
  if (cached) return cached;
  try {
    const img = await loadImage(url);
    const canvas = pageCanvas();
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    imageDataCache.set(url, data);
    return data;
  } catch {
    return null;
  }
}

export function clearColorSampleCache(): void {
  imageDataCache.clear();
}

/**
 * Dominant colour (0..1 RGB) of the page rect [rx,ry,rw,rh] in raster pixels.
 * Falls back to white if the page can't be read.
 */
export async function sampleBackgroundColor(
  url: string,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): Promise<[number, number, number]> {
  const data = await pageImageData(url);
  if (!data) return [1, 1, 1];
  const x0 = Math.max(0, Math.floor(rx));
  const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(data.width, Math.ceil(rx + rw));
  const y1 = Math.min(data.height, Math.ceil(ry + rh));
  if (x1 <= x0 || y1 <= y0) return [1, 1, 1];

  // Quantize to 16 levels/channel only to GROUP pixels for the mode; accumulate
  // the actual colours so the returned value is exact (pure white stays 255,
  // not a quantized 248 that reads as grey).
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const px = data.data;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * data.width + x) * 4;
      const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
      const acc = buckets.get(key);
      if (acc) {
        acc.n++;
        acc.r += px[i];
        acc.g += px[i + 1];
        acc.b += px[i + 2];
      } else {
        buckets.set(key, { n: 1, r: px[i], g: px[i + 1], b: px[i + 2] });
      }
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const acc of buckets.values()) {
    if (!best || acc.n > best.n) best = acc;
  }
  if (!best) return [1, 1, 1];
  return [best.r / best.n / 255, best.g / best.n / 255, best.b / best.n / 255];
}
