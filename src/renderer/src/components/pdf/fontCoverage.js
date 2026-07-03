// Glyph coverage of a TrueType/OpenType font, straight from its cmap — so the editor can DISABLE a
// font in the dropdown when it can't render the run's characters (one font per run, no silent
// per-glyph mixing). Returns { has(codePoint) } or null when no usable cmap is present.
// Supports the two subtables that matter: format 4 (BMP) and format 12 (full unicode).
export function fontCoverageOf(buffer) {
  try {
    const dv = new DataView(buffer)
    const u8 = new Uint8Array(buffer)
    const numTables = dv.getUint16(4)
    let cmapOff = -1
    for (let i = 0; i < numTables; i++) {
      const r = 12 + i * 16
      if (String.fromCharCode(u8[r], u8[r + 1], u8[r + 2], u8[r + 3]) === 'cmap') { cmapOff = dv.getUint32(r + 8); break }
    }
    if (cmapOff < 0) return null
    const n = dv.getUint16(cmapOff + 2)
    let best = null, bestScore = -1
    for (let i = 0; i < n; i++) {
      const r = cmapOff + 4 + i * 8
      const plat = dv.getUint16(r), enc = dv.getUint16(r + 2), off = cmapOff + dv.getUint32(r + 4)
      const fmt = dv.getUint16(off)
      // prefer full-unicode (3,10 fmt12), then BMP (3,1 fmt4), then anything readable
      const score = plat === 3 && enc === 10 && fmt === 12 ? 4 : plat === 3 && enc === 1 && fmt === 4 ? 3 : fmt === 12 ? 2 : fmt === 4 ? 1 : 0
      if (score > bestScore) { bestScore = score; best = { off, fmt } }
    }
    if (!best) return null

    if (best.fmt === 12) {
      const groups = []
      const ng = dv.getUint32(best.off + 12)
      for (let i = 0; i < ng; i++) {
        const g = best.off + 16 + i * 12
        groups.push([dv.getUint32(g), dv.getUint32(g + 4)]) // start, end (startGlyphID>0 assumed)
      }
      return {
        has: (cp) => {
          let lo = 0, hi = groups.length - 1
          while (lo <= hi) { const m = (lo + hi) >> 1; if (cp < groups[m][0]) hi = m - 1; else if (cp > groups[m][1]) lo = m + 1; else return true }
          return false
        }
      }
    }

    // format 4
    const o = best.off
    const segX2 = dv.getUint16(o + 6), segCount = segX2 / 2
    const endO = o + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2
    return {
      has: (cp) => {
        if (cp > 0xffff) return false
        for (let s = 0; s < segCount; s++) {
          const end = dv.getUint16(endO + s * 2)
          if (cp > end) continue
          const start = dv.getUint16(startO + s * 2)
          if (cp < start) return false // segments are sorted → not covered
          const delta = dv.getUint16(deltaO + s * 2)
          const ro = dv.getUint16(rangeO + s * 2)
          if (ro === 0) return ((cp + delta) & 0xffff) !== 0
          const gi = rangeO + s * 2 + ro + (cp - start) * 2
          if (gi + 1 >= buffer.byteLength) return false
          const g = dv.getUint16(gi)
          return g !== 0 && ((g + delta) & 0xffff) !== 0
        }
        return false
      }
    }
  } catch { return null }
}

// every distinct non-space char of `text` present in the coverage? (null coverage = unknown → treat
// as capable, so we never falsely disable a font we couldn't inspect)
export function fontCovers(coverage, text) {
  if (!coverage) return true
  for (const ch of new Set(String(text || ''))) {
    if (!ch.trim()) continue
    if (!coverage.has(ch.codePointAt(0))) return false
  }
  return true
}
