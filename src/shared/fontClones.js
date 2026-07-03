// ONE common table of font equivalents — imported by BOTH sides (the "similar" logic used to live
// twice and drift apart):
//  • main (googleFonts): which Google family to DOWNLOAD as a metric clone;
//  • renderer (PdfEditor.similar): which SYSTEM family to fall back to for preview.
// Metric clones share letter widths with the originals, so substituted text keeps its layout.
// Order matters: specific families first, generic catch-alls last.
export const FONT_CLONE_TABLE = [
  { re: /arial|helvetica|nimbus ?sans|liberation ?sans|arimo|swiss/i, google: 'Arimo', system: 'Arial' },
  { re: /times|nimbus ?roman|nimbus ?serif|liberation ?serif|tinos|dutch/i, google: 'Tinos', system: 'Times New Roman' },
  { re: /courier|nimbus ?mono|liberation ?mono|cousine/i, google: 'Cousine', system: 'Courier New' },
  { re: /calibri|carlito/i, google: 'Carlito', system: 'Calibri' },
  { re: /cambria|caladea/i, google: 'Caladea', system: 'Cambria' },
  // generic catch-alls — a rough shape guess when nothing specific matched
  { re: /georgia|garamond|palatino|book|roman|serif/i, google: 'Tinos', system: 'Times New Roman' },
  { re: /mono/i, google: 'Cousine', system: 'Courier New' }
]

// the clone entry for a PDF font name, or null when nothing matches (caller decides the default)
export function cloneFor(name) {
  const s = String(name || '')
  for (const e of FONT_CLONE_TABLE) if (e.re.test(s)) return e
  return null
}
