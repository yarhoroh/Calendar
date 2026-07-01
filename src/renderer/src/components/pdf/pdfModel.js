// Pure helpers for building a page's rich-text model from MuPDF walk() output. No mupdf here, so
// this stays unit-testable and reusable. A "run" is a span of consecutive characters sharing one
// style (font/size/bold/italic/color) — the unit RichEdit edits.

// PDF colors arrive as [gray] | [r,g,b] | [c,m,y,k] floats 0..1. We only handle gray/rgb for now.
export function colorToHex(c) {
  if (!Array.isArray(c) || c.length === 0) return '#000000'
  const rgb = c.length === 1 ? [c[0], c[0], c[0]] : c.slice(0, 3)
  return '#' + rgb.map((n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0')).join('')
}

function styleKey(ch) {
  // include horizontal scale (rounded to 0.01%) so 103.17%/103.24% zones don't merge into one run
  return `${ch.fontName}|${ch.size}|${ch.bold}|${ch.italic}|${ch.color}|${Math.round((ch.hScale || 1) * 10000)}`
}

// Group consecutive chars of one line into runs. A run breaks on a style change OR a big horizontal
// gap — the latter splits table columns/cells that share a baseline and a style into separate,
// editable pieces instead of one long line. Each char:
//   { c, fontName, size, bold, italic, serif, mono, color, x0, y0, x1, y1 }
export function charsToRuns(chars) {
  const runs = []
  let cur = null
  for (const ch of chars) {
    const key = styleKey(ch)
    // gap from the previous char's right edge; > ~1.2em means a column break, not a word space
    const gap = cur ? ch.x0 - cur.x1 : 0
    const bigGap = cur && gap > (ch.size || 0) * 1.2
    if (!cur || cur.key !== key || bigGap) {
      cur = {
        key,
        text: '',
        fontName: ch.fontName,
        size: ch.size,
        bold: ch.bold,
        italic: ch.italic,
        serif: ch.serif,
        mono: ch.mono,
        color: ch.color,
        hScale: ch.hScale, // horizontal scale (Tz), 1 = 100%
        z: ch.z, // first stream fragment (paint order)
        zs: [], // ALL stream fragments this run touches (one run can span several Tj of one style)
        paintZs: [], // q..Q block indices this run touches (for the move wrapper)
        baseline: ch.oy, // text baseline y (for super/subscript and line spacing)
        x0: ch.x0,
        y0: ch.y0,
        x1: ch.x1,
        y1: ch.y1,
      }
      runs.push(cur)
    }
    if (ch.z != null && !cur.zs.includes(ch.z)) cur.zs.push(ch.z)
    if (ch.paintZ != null && !cur.paintZs.includes(ch.paintZ)) cur.paintZs.push(ch.paintZ)
    cur.text += ch.c
    cur.x0 = Math.min(cur.x0, ch.x0)
    cur.y0 = Math.min(cur.y0, ch.y0)
    cur.x1 = Math.max(cur.x1, ch.x1)
    cur.y1 = Math.max(cur.y1, ch.y1)
  }
  return runs.map((r) => ({
    text: r.text,
    fontName: r.fontName,
    size: r.size,
    bold: r.bold,
    italic: r.italic,
    serif: r.serif,
    mono: r.mono,
    color: r.color,
    hScale: r.hScale,
    z: r.z,
    zs: r.zs,
    paintZs: r.paintZs,
    baseline: r.baseline,
    bbox: { x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0 },
  }))
}

// Precise baseline of a line = average oy of its most populated baseline group (rounded to group).
// Precise (not rounded) so line-spacing steps don't jitter ±0.5pt.
function dominantBaseline(chars) {
  const groups = new Map()
  for (const c of chars) {
    const k = Math.round(c.oy)
    const g = groups.get(k) || { n: 0, sum: 0 }
    g.n++
    g.sum += c.oy
    groups.set(k, g)
  }
  let best = -1
  let val = 0
  for (const g of groups.values()) {
    if (g.n > best) {
      best = g.n
      val = g.sum / g.n
    }
  }
  return best > 0 ? val : 0
}

// Block alignment from line edges: left/right/center/justify (≤2pt variance = "aligned").
function computeAlign(lines) {
  if (lines.length < 2) return 'left'
  const lefts = lines.map((l) => l.x)
  const rights = lines.map((l) => l.x + l.width)
  const centers = lines.map((l) => l.x + l.width / 2)
  const range = (a) => Math.max(...a) - Math.min(...a)
  const tol = 2
  const lv = range(lefts)
  const rv = range(rights)
  const cv = range(centers)
  if (lv <= tol && rv <= tol) return 'justify'
  if (lv <= tol) return 'left'
  if (rv <= tol) return 'right'
  if (cv <= tol) return 'center'
  return 'left'
}

// Line spacing as a multiple of font size (Acrobat's "1.13" style): avg step between DISTINCT
// visual baselines ÷ size. Lines sharing a baseline (table cells in a row) collapse to one, so a
// single visual row returns null instead of a bogus 0.
function computeLineSpacing(lines) {
  const seen = new Set()
  const bs = []
  for (const l of [...lines].sort((a, b) => a.baseline - b.baseline)) {
    const k = Math.round(l.baseline)
    if (!seen.has(k)) {
      seen.add(k)
      bs.push(l.baseline)
    }
  }
  if (bs.length < 2) return null
  let sum = 0
  for (let i = 1; i < bs.length; i++) sum += bs[i] - bs[i - 1]
  const avg = sum / (bs.length - 1)
  // divide by the DOMINANT (most common) run size, not max — a big heading line must not skew it
  const counts = new Map()
  for (const l of lines) for (const r of l.runs) {
    const s = Math.round(r.size * 4) / 4
    counts.set(s, (counts.get(s) || 0) + 1)
  }
  let size = 0
  let best = 0
  for (const [s, c] of counts) if (c > best) { best = c; size = s }
  if (size <= 0) return null
  const ls = Math.round((avg / size) * 100) / 100
  return ls >= 0.5 ? ls : null // sub-0.5 means rows shared a baseline (super/sub jitter), not real spacing
}

// Build one block: lines → runs, tag super/subscript runs, compute alignment + line spacing.
export function buildBlock(rb) {
  const lines = []
  for (const ln of rb.lines) {
    const runs = charsToRuns(ln.chars).filter((r) => r.text.trim().length > 0)
    if (!runs.length) continue
    const baseline = dominantBaseline(ln.chars)
    const maxSize = Math.max(...runs.map((r) => r.size))
    for (const r of runs) {
      const smaller = r.size < maxSize * 0.85
      if (smaller && r.baseline < baseline - 0.5) r.vAlign = 'super'
      else if (smaller && r.baseline > baseline + 0.5) r.vAlign = 'sub'
      else r.vAlign = 'normal'
      r.underline = false // set later from vectors
    }
    lines.push({ x: ln.x, y: ln.y, width: ln.width, height: ln.height, baseline, runs })
  }
  if (!lines.length || rb.width <= 0.5 || rb.height <= 0.5) return null
  return {
    x: rb.x,
    y: rb.y,
    width: rb.width,
    height: rb.height,
    lines,
    align: computeAlign(lines),
    lineSpacing: computeLineSpacing(lines),
    paragraphSpacing: null, // filled by computeParagraphSpacing across the page
  }
}

// Split a block the way Acrobat does. Cells of a table row sit on the same baseline but are
// separated by a BIG horizontal gap (column boundary); inline style spans (a bold word mid-sentence)
// sit on the same baseline too but run flush against each other. So we only split when a row has a
// real column gap — a paragraph (even with inline bold) stays one block.
const COL_GAP = 1.5 // gap > 1.5em between pieces on one baseline = a column boundary

function mkBlock(lines) {
  const x = Math.min(...lines.map((l) => l.x))
  const y = Math.min(...lines.map((l) => l.y))
  const x1 = Math.max(...lines.map((l) => l.x + l.width))
  const y1 = Math.max(...lines.map((l) => l.y + l.height))
  return { x, y, width: x1 - x, height: y1 - y, lines, align: 'left', lineSpacing: null, paragraphSpacing: 0 }
}

// Group a row's lines into columns: adjacent pieces with no big gap merge; a big gap starts a column.
function rowColumns(rowLines) {
  const sorted = [...rowLines].sort((a, b) => a.x - b.x)
  const size = Math.max(...rowLines.flatMap((l) => l.runs.map((r) => r.size)))
  const cols = []
  let cur = null
  for (const l of sorted) {
    if (cur && l.x - (cur.x1) <= size * COL_GAP) {
      cur.lines.push(l)
      cur.x1 = Math.max(cur.x1, l.x + l.width)
    } else {
      cur = { lines: [l], x1: l.x + l.width }
      cols.push(cur)
    }
  }
  return cols
}

export function splitTableBlock(block) {
  // group lines into rows by baseline (±3pt)
  const rows = []
  for (const l of [...block.lines].sort((a, b) => a.baseline - b.baseline)) {
    const row = rows.find((r) => Math.abs(r.y - l.baseline) <= 3)
    if (row) {
      row.lines.push(l)
      row.y = (row.y * (row.lines.length - 1) + l.baseline) / row.lines.length
    } else {
      rows.push({ y: l.baseline, lines: [l] })
    }
  }
  // table-like only if some row actually splits into >1 column (a real gap, not flush bold spans)
  const tableLike = rows.some((r) => rowColumns(r.lines).length > 1)
  if (!tableLike) return [block] // paragraph (even with inline bold) → keep whole
  return rows.flatMap((r) => rowColumns(r.lines).map((c) => mkBlock(c.lines)))
}

// Document-typical line spacing = the most common per-block lineSpacing (used when a block has only
// one visual row and can't measure its own).
export function documentLineSpacing(blocks) {
  const counts = new Map()
  for (const b of blocks) if (b.lineSpacing != null) counts.set(b.lineSpacing, (counts.get(b.lineSpacing) || 0) + 1)
  let best = 0
  let val = null
  for (const [v, c] of counts) if (c > best) { best = c; val = v }
  return val
}

// Paragraph spacing (Acrobat-style) = EXTRA gap above the block beyond the normal line step — not
// the raw geometric gap. Usual paragraphs flow at the normal step → 0; a real extra indent shows up
// as a positive value. `docLine` is the fallback multiple for blocks without their own measurement.
export function computeParagraphSpacing(blocks, docLine) {
  for (const b of blocks) {
    let above = null
    for (const o of blocks) {
      if (o === b) continue
      const overlap = !(o.x > b.x + b.width || o.x + o.width < b.x)
      if (!overlap || o.y + o.height > b.y + 0.5) continue // must sit strictly above
      if (!above || o.y + o.height > above.y + above.height) above = o
    }
    if (!above) {
      b.paragraphSpacing = 0
      continue
    }
    const thisTop = Math.min(...b.lines.map((l) => l.baseline))
    const aboveBottom = Math.max(...above.lines.map((l) => l.baseline))
    const gap = thisTop - aboveBottom
    const size = Math.max(...b.lines.flatMap((l) => l.runs.map((r) => r.size)))
    const ls = b.lineSpacing || above.lineSpacing || docLine || 1.2
    const extra = gap - ls * size
    // only count it as a real paragraph gap if it exceeds a full extra line; normal flow → 0
    b.paragraphSpacing = extra > size ? Math.round(extra * 100) / 100 : 0
  }
}

// Underline = a thin horizontal vector sitting at/just below a run's baseline, overlapping its x-span.
export function markUnderlines(blocks, vectors) {
  const rules = vectors.filter((v) => v.height <= 2 && v.width > 3)
  if (!rules.length) return
  for (const b of blocks) {
    for (const ln of b.lines) {
      for (const r of ln.runs) {
        const rx0 = r.bbox.x
        const rx1 = r.bbox.x + r.bbox.width
        r.underline = rules.some(
          (v) => v.y >= ln.baseline - 1 && v.y <= ln.baseline + 3 && v.x < rx1 && v.x + v.width > rx0
        )
      }
    }
  }
}

// Unique fonts and colors across the whole page (document palette).
export function collectPalette(blocks) {
  const fonts = new Map()
  const colors = new Set()
  for (const b of blocks) {
    for (const ln of b.lines) {
      for (const r of ln.runs) {
        colors.add(r.color)
        const fk = `${r.fontName}|${r.bold}|${r.italic}`
        if (!fonts.has(fk)) fonts.set(fk, { name: r.fontName, bold: r.bold, italic: r.italic, serif: r.serif, mono: r.mono })
      }
    }
  }
  return { fonts: [...fonts.values()], colors: [...colors] }
}

// Distinct styles inside one block (for the panel: "what styles does this block use?").
export function blockStyles(block) {
  const seen = new Map()
  for (const ln of block.lines) {
    for (const r of ln.runs) {
      const k = `${r.fontName}|${r.size}|${r.bold}|${r.italic}|${r.color}`
      if (!seen.has(k)) seen.set(k, { fontName: r.fontName, size: r.size, bold: r.bold, italic: r.italic, serif: r.serif, mono: r.mono, color: r.color })
    }
  }
  return [...seen.values()]
}
