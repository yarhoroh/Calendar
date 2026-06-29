/**
 * Registry of fonts pulled out of the open PDF. When a line of existing text is
 * lifted into an editable overlay we want it to render with the document's own
 * font — not a CSS substitute — so the glyph shapes stay one-to-one with the
 * page. Each embedded font program is registered as a FontFace under a private
 * family name, keyed by its (cleaned) PDF font name.
 */
import type { EmbeddedFont } from '../../types.js';
import { cleanFontName } from './objects.js';

const families = new Map<string, string>(); // PDF font name -> CSS family
let counter = 0;

// PDF subset fonts are often NOT 4-byte aligned (the PDF format doesn't require it), but the
// browser's font sanitizer (OTS) rejects them ("glyf/fpgm misaligned table") and FontFace.load()
// throws → we'd fall back to a substitute and the glyph shapes change. Repack the sfnt with every
// table 4-byte aligned + fresh checksums so OTS accepts it and the real embedded font loads.
function repackSfnt(input: ArrayBuffer): Uint8Array {
  const src = new Uint8Array(input);
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const numTables = dv.getUint16(4);
  const tables: { tag: Uint8Array; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const offset = dv.getUint32(rec + 8);
    const length = dv.getUint32(rec + 12);
    tables.push({ tag: src.subarray(rec, rec + 4), data: src.subarray(offset, offset + length) });
  }
  const dirSize = 12 + numTables * 16;
  let total = dirSize;
  for (const t of tables) total += (t.data.length + 3) & ~3; // pad each table to 4 bytes
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, dv.getUint32(0)); // sfntVersion
  odv.setUint16(4, numTables);
  const maxPow = numTables ? Math.pow(2, Math.floor(Math.log2(numTables))) : 1;
  odv.setUint16(6, maxPow * 16);
  odv.setUint16(8, Math.floor(Math.log2(Math.max(numTables, 1))));
  odv.setUint16(10, numTables * 16 - maxPow * 16);
  let off = dirSize;
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    const rec = 12 + i * 16;
    out.set(t.tag, rec);
    let sum = 0;
    for (let j = 0; j < t.data.length; j += 4) {
      const w = ((t.data[j] << 24) | ((t.data[j + 1] || 0) << 16) | ((t.data[j + 2] || 0) << 8) | (t.data[j + 3] || 0)) >>> 0;
      sum = (sum + w) >>> 0;
    }
    odv.setUint32(rec + 4, sum);
    odv.setUint32(rec + 8, off);
    odv.setUint32(rec + 12, t.data.length);
    out.set(t.data, off);
    off += (t.data.length + 3) & ~3;
  }
  return out;
}

// Load a FontFace, retrying with a repacked (4-byte aligned) sfnt if the raw program is rejected.
async function loadEmbeddedFace(family: string, data: ArrayBuffer): Promise<FontFace | null> {
  try {
    const f = new FontFace(family, data);
    await f.load();
    return f;
  } catch {
    /* OTS rejected the raw program — try a repacked copy */
  }
  try {
    const f = new FontFace(family, repackSfnt(data) as unknown as BufferSource);
    await f.load();
    return f;
  } catch {
    return null;
  }
}

/** Register one embedded font; returns its CSS family (or null if unusable). */
export async function registerEmbeddedFont(font: EmbeddedFont): Promise<string | null> {
  // A bare CFF can't be loaded by the browser without OTF-wrapping; skip it so
  // the caller falls back to a substitute rather than erroring per glyph.
  if (font.format === 'cff') return null;
  const cleaned = cleanFontName(font.name);
  const existing = families.get(font.name) ?? families.get(cleaned);
  if (existing) return existing;
  counter += 1;
  const family = `pdfembed-${counter}`;
  const face = await loadEmbeddedFace(family, font.data);
  if (!face) return null; // unloadable even after repack — caller falls back to a substitute
  document.fonts.add(face);
  // Key by both the raw (subset-prefixed) and cleaned name so either resolves.
  families.set(font.name, family);
  families.set(cleaned, family);
  return family;
}

/** The CSS family for a PDF font name, or null if it wasn't embedded/usable. */
export function familyForPdfFont(pdfFontName: string): string | null {
  return families.get(pdfFontName) ?? families.get(cleanFontName(pdfFontName)) ?? null;
}

/** True if a family name is one of our registered embedded fonts. */
export function isEmbeddedFamily(family: string): boolean {
  return family.startsWith('pdfembed-');
}

/** Forget the name→family map (on opening a new document). The FontFaces stay
 *  in document.fonts; their family names are unique so they never collide. */
export function clearEmbeddedFonts(): void {
  families.clear();
}
