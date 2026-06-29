/**
 * Measure rendered text size with an offscreen canvas so a text box can grow to
 * exactly fit its content. Measuring at the point size returns the width in PDF
 * points (1pt treated as 1px), which is what the object model stores.
 */
let ctx: CanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D {
  if (!ctx) {
    const canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
  }
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return ctx;
}

/** Widest line of `text` in points, for the given font/size/style. */
export function measureTextWidth(
  text: string,
  fontSize: number,
  family: string,
  bold: boolean,
  italic: boolean,
): number {
  const c = context();
  c.font = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${fontSize}px ${family}`;
  let max = 0;
  for (const line of text.split('\n')) max = Math.max(max, c.measureText(line).width);
  return max;
}

// Distance (px) from an overlay's top to its first-line BASELINE, measured the way the browser
// actually lays it out — NOT canvas fontBoundingBoxAscent (that's the full font box, larger, which
// pushed the text up). A zero-size inline-block with vertical-align:baseline sits its top exactly on
// the baseline; we read it back with the same font + line-height the overlay uses. Cached per key.
const ascentCache = new Map<string, number>();
let ascentProbe: HTMLDivElement | null = null;
export function measureAscent(
  fontSize: number,
  family: string,
  bold: boolean,
  italic: boolean,
): number {
  const key = `${fontSize}|${family}|${bold}|${italic}`;
  const hit = ascentCache.get(key);
  if (hit != null) return hit;
  if (!ascentProbe) {
    ascentProbe = document.createElement('div');
    ascentProbe.style.cssText =
      'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:nowrap;padding:0;margin:0;border:0;';
    document.body.appendChild(ascentProbe);
  }
  ascentProbe.style.font = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${fontSize}px ${family}`;
  ascentProbe.style.lineHeight = `${fontSize}px`; // same line-height the overlay uses for single lines
  ascentProbe.textContent = 'Hg';
  const strut = document.createElement('span');
  strut.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
  ascentProbe.appendChild(strut);
  const ascent = strut.getBoundingClientRect().top - ascentProbe.getBoundingClientRect().top;
  const val = ascent > 0 ? ascent : fontSize * 0.8; // guard against a 0 from a not-yet-ready layout
  ascentCache.set(key, val);
  return val;
}

/** Fit a text box (in points) to its content, always a touch larger than the
 *  text so no horizontal/vertical scrollbar can appear. */
export function fitTextBox(
  text: string,
  fontSize: number,
  family: string,
  bold: boolean,
  italic: boolean,
): { w: number; h: number } {
  const widest = measureTextWidth(text || ' ', fontSize, family, bold, italic);
  const lineCount = Math.max(1, text.split('\n').length);
  const padX = fontSize * 0.8; // ~half a character of breathing room each side
  return {
    w: Math.max(widest + padX, fontSize),
    h: lineCount * fontSize * 1.25,
  };
}
