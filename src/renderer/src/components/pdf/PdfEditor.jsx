import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ZoomInIcon, ZoomOutIcon, CopyIcon, PasteIcon, TrashIcon, PipetteIcon, ChevronLeftIcon, ChevronRightIcon } from '../icons'
import api from '../../lib/api'
import ContextMenu from '../ContextMenu'
import { useI18n } from '../../i18n/I18nContext'
import { createPdfEngine } from './pdfEngine'
import { registerUi, updateUiState, ui } from '../../lib/uiBridge'
import { cloneFor } from '../../../../shared/fontClones'
import { fontCoverageOf, fontCovers } from './fontCoverage'
import PdfPage from './PdfPage'
import './PdfEditor.css'

// files the AI itself created this session (copies / new invoices) — in-place saves on these are
// fine; overwriting a USER's original file needs their explicit request
const AI_CREATED_PATHS = new Set()

const SIZES = [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72, 80, 90]
const LH_OPTS = [1, 1.15, 1.25, 1.4, 1.5, 1.75, 2]

// ================= SLM — Spatial Layout Map =================
// A medium-agnostic way to hand a 2D layout to an AI as TEXT it can reason about spatially: every
// object (from ANY source — PDF scan, HTML getBoundingClientRect, image OCR) becomes a box; the
// page is recursively split along the widest whitespace gutter (recursive XY-cut) into a NESTING
// TREE of regions (header/body/footer → columns → rows), so the model sees structure, not a flat
// list. Boxes are normalised to a 0..1000 grid (origin top-left) so pt / px / image-px compare
// identically. Only the PDF adapter (buildSlm) lives here; the tree builder (slmSplit) is pure.

// merge [a,b] intervals, return the gaps BETWEEN them as {at (midpoint), size}
function gapsOf(intervals) {
  const iv = intervals.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0])
  if (iv.length < 2) return []
  const merged = [iv[0].slice()]
  for (let i = 1; i < iv.length; i++) {
    const last = merged[merged.length - 1]
    if (iv[i][0] <= last[1]) last[1] = Math.max(last[1], iv[i][1])
    else merged.push(iv[i].slice())
  }
  const gaps = []
  for (let i = 1; i < merged.length; i++) gaps.push({ at: (merged[i - 1][1] + merged[i][0]) / 2, size: merged[i][0] - merged[i - 1][1] })
  return gaps
}

// recursive XY-cut → an array of region nodes { id, box:[x,y,w,h], dir, children } | { id, box, els }
// els carry all their attributes; W/H are page dims (for the gutter thresholds in page units)
function slmSplit(els, W, H, id, depth) {
  const bx = () => {
    const x0 = Math.min(...els.map((e) => e.x)), y0 = Math.min(...els.map((e) => e.y))
    const x1 = Math.max(...els.map((e) => e.x + e.w)), y1 = Math.max(...els.map((e) => e.y + e.h))
    return [x0, y0, x1 - x0, y1 - y0]
  }
  if (els.length <= 3 || depth >= 6) return [{ id, box: bx(), els }]
  const vGaps = gapsOf(els.map((e) => [e.x, e.x + e.w])) // vertical gutters → column split
  const hGaps = gapsOf(els.map((e) => [e.y, e.y + e.h])) // horizontal gutters → row-group split
  const bestV = vGaps.sort((a, b) => b.size - a.size)[0]
  const bestH = hGaps.sort((a, b) => b.size - a.size)[0]
  const COL = Math.max(18, W * 0.03) // a real column gutter (pt)
  const ROW = Math.max(10, H * 0.018) // a real row-group gutter (pt)
  const vScore = bestV && bestV.size > COL ? bestV.size / COL : 0
  const hScore = bestH && bestH.size > ROW ? bestH.size / ROW : 0
  if (!vScore && !hScore) return [{ id, box: bx(), els }]
  const vertical = vScore >= hScore // cut columns first when the column gutter is the more decisive
  const cut = vertical ? bestV.at : bestH.at
  const key = vertical ? (e) => e.x + e.w / 2 : (e) => e.y + e.h / 2
  const A = els.filter((e) => key(e) < cut), B = els.filter((e) => key(e) >= cut)
  if (!A.length || !B.length) return [{ id, box: bx(), els }]
  return [{
    id, box: bx(), dir: vertical ? 'columns' : 'stacked',
    children: [...slmSplit(A, W, H, id + 'a', depth + 1), ...slmSplit(B, W, H, id + 'b', depth + 1)]
  }]
}

// SLM alignment grid — cluster the elements' edges into the document's real COLUMNS (shared
// vertical lines) and ROWS (shared horizontal lines), and flag near-misses (an element ALMOST on a
// line but shifted by a few pt). Pure geometry on boxes → reused as-is for HTML / WinForms later.
// els: [{ id, x, y, w, h }]; W/H page size. tol scales with the page so it works at any size.
function slmGrid(els, W, H) {
  if (els.length < 2) return { cols: [], rows: [], shifts: [] }
  const TOL = Math.max(2, W * 0.004) // "on the same line" if within this many pt
  const NEAR = TOL * 3 // within this but NOT within TOL → a near-miss (shifted)
  const BAND = Math.max(6, H * 0.012) // rows this far apart count as DISTINCT
  // 1D clustering on `v` (the edge), carrying each member's `cross` (perpendicular coord). A real
  // alignment line must span ≥2 DISTINCT cross-bands — otherwise it's just adjacent fragments of ONE
  // value on a single line (a split number), not a column. Break a cluster when the gap exceeds tol.
  const cluster = (pts, bandSize) => {
    const s = [...pts].sort((a, b) => a.v - b.v)
    const out = []
    for (const p of s) {
      const last = out[out.length - 1]
      if (last && p.v - last.v0 <= TOL) { last.ids.push(p.id); last.sum += p.v; last.at = last.sum / last.ids.length; last.bands.add(Math.round(p.cross / bandSize)) }
      else out.push({ v0: p.v, at: p.v, sum: p.v, ids: [p.id], bands: new Set([Math.round(p.cross / bandSize)]) })
    }
    return out.filter((c) => c.ids.length >= 2 && c.bands.size >= 2) // 2+ members on 2+ distinct bands
  }
  const byLeft = cluster(els.map((e) => ({ v: e.x, id: e.id, cross: e.y })), BAND)
  const byRight = cluster(els.map((e) => ({ v: e.x + e.w, id: e.id, cross: e.y })), BAND)
  const byTop = cluster(els.map((e) => ({ v: e.y, id: e.id, cross: e.x })), Math.max(20, W * 0.05))
  const px = (v, D) => Math.round((v / D) * 1000) / 10 // percent, 1 decimal
  const r1 = (v) => Math.round(v * 10) / 10
  let ci = 0, ri = 0
  const cols = [
    ...byLeft.map((c) => ({ id: 'CL' + ci++, kind: 'left', at: c.at, pct: px(c.at, W), n: c.ids.length })),
    ...byRight.map((c) => ({ id: 'CR' + ci++, kind: 'right', at: c.at, pct: px(c.at, W), n: c.ids.length }))
  ].sort((a, b) => b.n - a.n).slice(0, 12).sort((a, b) => a.at - b.at) // the strongest lines, left→right
  const rows = byTop.map((c) => ({ id: 'R' + ri++, at: c.at, pct: px(c.at, H), n: c.ids.length })).sort((a, b) => a.at - b.at)
  // near-misses: an element's left/right edge close to a column of the SAME kind but not on it
  const shifts = []
  for (const e of els) {
    for (const [edge, val] of [['left', e.x], ['right', e.x + e.w]]) {
      const near = cols.filter((c) => c.kind === edge).map((c) => ({ c, d: val - c.at })).filter(({ d }) => Math.abs(d) > TOL && Math.abs(d) <= NEAR).sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0]
      if (near && shifts.length < 20) shifts.push(`${e.id} ${edge} edge is ${r1(near.d)}pt off column ${near.c.id}(${r1(near.c.at)}pt) — align it`)
    }
  }
  return { cols, rows, shifts, r1 }
}

// Virtual document GRID — split the WHOLE page into a spreadsheet-like grid of rows × columns whose
// lines are the whitespace gutters between the elements' edges, then place every element in its
// cell(s). A wide element spans several columns (colspan), a tall one several rows (rowspan). This
// turns spatial questions into grid navigation the model does itself: "under X" = same column, next
// row; "beside X" = same row, next column. Pure geometry → reused for HTML / WinForms later.
function slmTable(els, W, H) {
  if (els.length < 2) return null
  const TOLX = Math.max(3, W * 0.01) // vertical grid lines: edges within this many pt are ONE column line
  // COLUMNS: cluster every left & right edge into vertical grid lines (x). A column = the gap
  // between two consecutive lines; a wide element spans several.
  const boundaries = (vals, tol) => {
    const s = [...vals].sort((a, b) => a - b)
    const out = []
    for (const v of s) {
      const last = out[out.length - 1]
      if (last && v - last.v0 <= tol) { last.sum += v; last.n++; last.at = last.sum / last.n }
      else out.push({ v0: v, at: v, sum: v, n: 1 })
    }
    return out.map((c) => Math.round(c.at * 10) / 10)
  }
  const colB = boundaries(els.flatMap((e) => [e.x, e.x + e.w]), TOLX)
  // ROWS = visual LINES, not every edge: sort element centres top→bottom and start a new row only
  // when the vertical gap jumps (so one line's pieces share a row). rowB = each row's centre y.
  const cs = els.map((e) => ({ c: e.y + e.h / 2, h: e.h })).sort((a, b) => a.c - b.c)
  const bands = []
  for (const { c, h } of cs) {
    const last = bands[bands.length - 1]
    if (last && c - last.c <= Math.max(3, h * 0.7)) { last.sum += c; last.n++; last.c = last.sum / last.n }
    else bands.push({ c, sum: c, n: 1 })
  }
  const rowB = bands.map((b) => Math.round(b.c * 10) / 10)
  const nearest = (B, v) => { let bi = 0, bd = Infinity; for (let i = 0; i < B.length; i++) { const d = Math.abs(B[i] - v); if (d < bd) { bd = d; bi = i } } return bi }
  const cellOf = (e) => {
    // columns: the element sits between col-line ci (its left) and cj (its right) → slots ci+1..cj
    const ci = nearest(colB, e.x), cj = nearest(colB, e.x + e.w)
    const cCol = Math.min(ci, cj) + 1, ceCol = Math.max(Math.max(ci, cj), cCol)
    // rows: which line-bands the element's vertical span covers (usually one; a tall box spans many)
    let r0 = Infinity, r1 = -Infinity
    for (let i = 0; i < rowB.length; i++) if (rowB[i] >= e.y - 1 && rowB[i] <= e.y + e.h + 1) { r0 = Math.min(r0, i); r1 = Math.max(r1, i) }
    if (r0 === Infinity) r0 = r1 = nearest(rowB, e.y + e.h / 2)
    return { rs: r0 + 1, re: r1 + 1, cs: cCol, ce: ceCol }
  }
  return { colB, rowB, cellOf, cols: Math.max(0, colB.length - 1), rows: rowB.length }
}

// letter-spacing quick-pick values for the LS dropdown (pt) — the +/− buttons still nudge freely and
// the value is click-to-type; this is just the fast common presets
const LS_PRESETS = [-2, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3, 5]

// The PDF action manual handed to the AI TOGETHER with the document model (pdfInfo) — the base
// chat prompt carries only a one-line pointer, so PDF instructions cost nothing until needed.
const AI_PDF_MANUAL = [
  'COORDINATE CONTRACT — READ THIS FIRST. Every coordinate you PASS to an action (pdfInsert x/baseline, pdfShape x/y/w/h and x1/y1/x2/y2, pdfMove dx/dy, pdfAlign) is in POINTS (pt), measured from the page TOP-LEFT, y growing DOWNWARD — the SAME unit and origin as the "[x,y,w,h]" pt boxes in the DETAILED line list and the MARGINS/GRID x-y line values in pdfInfo. Those pt numbers are the ONLY thing you may use as an action coordinate. The other pdfInfo numbers are for READING layout only and must NEVER be passed as a coordinate: the region-tree "0..1000 grid" boxes, the "%[L R T B]" percentages, and the "@R<n>C<n>" grid cells. If you want to draw a line at a text\'s top edge, take that text\'s pt y from the detailed list — do NOT convert a grid/%/cell value. Mixing them up puts shapes in the wrong place (a grid value used as pt lands too low).',
  'PDF ACTIONS — emit them in the normal ```calendar block; MANY actions per block are fine (they run in order). Every action takes "page" (default 0):',
  '- {"action":"pdfEditText","page":0,"id":"b3.l0","text":"new text"} — replace ONE piece\'s text in place (font/size/color/position kept).',
  '- {"action":"pdfRestyle","page":0,"ids":["b3.l0"],"family":"Arial","size":12,"color":"#c00000","bold":true,"italic":false,"ls":0} — restyle pieces; ONLY the fields you pass change.',
  '- {"action":"pdfInsert","page":0,"text":"Hello\\nsecond line","x":57,"baseline":120,"size":12,"family":"Arial","bold":false,"color":"#000000","lineHeight":1.3} — insert NEW text. x/baseline in pt from the page TOP-LEFT; baseline = the line the text SITS on. \\n makes extra lines; "lineHeight" (×size) is the LINE SPACING between them (default 1.3). To insert a line that matches the surrounding text\'s rhythm, step the baseline by the SAME Δ shown between existing lines in pdfInfo (e.g. neighbouring lines Δ15 → put your new line 15pt below the one above it). Keep line spacing consistent. ("ls" on pdfInsert/pdfRestyle is LETTER spacing — the gap between characters, different from line spacing.)',
  '- {"action":"pdfDelete","page":0,"ids":["b3.l0","v2"]} — delete pieces / graphics / images by id.',
  '- {"action":"pdfMove","page":0,"ids":["b3.l0"],"dx":10,"dy":-5} — shift objects by pt (dy positive = down).',
  '- {"action":"pdfAlign","page":0,"ids":["b5","b6","b7"],"edge":"right"} — align several objects to a common edge: "left"/"right" (line up a column of labels or amounts), "top"/"bottom" (line up a row). RIGHT-align number columns (amounts) so their right edges match; the reply of pdfInsert gives each piece\'s width so you can also place them by x = rightEdge − width. Respect the MARGINS from pdfInfo — never put content within ~12pt of the page edge (it looks cut off).',
  '- {"action":"pdfShape","page":0,"kind":"rect","x":40,"y":100,"w":515,"h":24,"color":"#dddddd","strokeW":1,"radius":0,"fill":"#f2f2f2"} — draw a frame/band/background ("fill" optional; "stroke":"none" = fill only). kind "line": {"x1","y1","x2","y2"} for table rules/separators. kind "ellipse": x/y/w/h box. For a rect/ellipse the reply lists every text OVERLAPPING the frame with its padding from the L/R/T/B edges (pt): use it to check the frame wraps the text cleanly (roughly equal paddings) — a NEGATIVE padding means the frame edge CUTS through that text, so grow/move the frame or reposition the text. A filled band drawn OVER text also needs pdfReorder "back" so the text shows.',
  '- {"action":"createVariable","name":"invoice_no","value":"INV-2026-001"} — make a template variable out of EVERY text in the document equal to value (create the text first with pdfInsert, then variable it). Name it meaningfully (invoice_no, client, due_date, total…).',
  '- {"action":"pdfSetVariable","name":"invoice_no","value":"INV-2026-002"} — change a variable\'s value: every place it occurs is rewritten in the PDF at once.',
  '- {"action":"pdfSave","as":"invoice-002.pdf"} — save a COPY next to the original (the reply gives the new file\'s full path — use it for attachFile / telegramFile / composeMail attachments). A plain pdfSave OVERWRITES the open file and is REFUSED on the user\'s own documents — only when the user explicitly asked to overwrite, retry with {"overwrite":true}. Files you created yourself (copies, new invoices) can be saved in place freely.',
  '- {"action":"pdfWorkOnCopy","as":"name-copy.pdf"} — save the current state as a copy next to the original AND switch editing to it (the copy opens as the active tab; every later action hits the copy; the original stays untouched). USE THIS FIRST whenever the user asks for serious changes to an existing document and did not say to change the original itself.',
  '- {"action":"pdfStyleShape","page":0,"ids":["v1"],"fill":"#f2f2f2","stroke":"#cccccc","strokeW":1,"radius":4,"opacity":1} — restyle an EXISTING shape/box IN PLACE: "fill" = its BACKGROUND colour, "stroke" = its BORDER colour, "strokeW" = border width (pt), "radius" = rounded corners, "opacity" 0..1 (whole shape) or separate "fillOpacity"/"strokeOpacity" 0..1 (fill and border transparency are INDEPENDENT in PDF), "none" clears a fill or border. To CHANGE a box\'s colour/size/border, use THIS or pdfDelete + a fresh pdfShape — do NOT draw another box on top of the old one. To REMOVE a box, pdfDelete it by its v-id. Every shape in pdfInfo shows its current fill= and border= so you know what you are changing. A shape has TWO colours: fill (background) and stroke (the outline); "stroke":"none" = filled-only (a solid band), "fill":"none" = outline-only (an empty frame).',
  '- {"action":"pdfReorder","page":0,"ids":["v1"],"mode":"back"} — change Z-ORDER (stacking). mode: "back" (behind everything — for a background band/fill), "front" (on top), "backward"/"forward" (one step). Paint order = stack order: whatever has the HIGHER z sits on top. If a background/fill covers text (its z is higher), send it "back". Draw backgrounds/bands FIRST so text drawn later is on top; if you added a fill after the text, reorder it back.',
  '- {"action":"pdfNew","name":"invoice.pdf"} — create a BLANK A4 PDF from scratch, open it and link it into Files (lands in a linked folder, else Documents/Calendar PDFs). Creating a document FROM NOTHING is fully supported — use this, then pdfInfo, then build it.',
  'WORKFLOW — building a document (invoice / contract) from scratch on a blank page: 1) lay out with pdfShape (header band, table rules) and pdfInsert (texts — put a LABEL and its VALUE in SEPARATE inserts so values can become variables; align columns by giving rows the same x and stepping baseline by ~1.3×size); 2) createVariable for every changeable field (number, dates, client, quantities, unit prices, totals — recompute totals yourself when quantities change); 3) pdfSave. For a date editable by parts, insert day / month / year as separate pieces and variable each. For a two-language document, lay the second language as its own column or line pairs.',
  'METRICS — plan the layout with real numbers: the page size is in the PAGE header (A4 ≈ 595x842pt). A text line occupies ≈ size×1.3 pt of height (cap height ≈ 0.7×size above the baseline, descenders ≈ 0.25×size below). Rough width estimate ≈ 0.5×size per character (Arial). You do NOT need to guess precisely: every pdfInsert REPLIES with the exact box of what landed — "inserted: …" with x, baseline, w, h per line — use those real numbers to place the next elements, right-align amounts (x = right_edge − w), and verify nothing overlaps. A document has MARGINS (blank space around the content) — on an existing document read the actual margins from pdfInfo (MARGINS line) and stay inside them; on a blank page CHOOSE a sensible, consistent margin yourself and keep all content within it. Don\'t assume any fixed number.',
  'READING THE PIECES: inside a line every neighbour pair shows its exact <gap Npt>. gap ≲ 0.15×size → GLUED fragments of ONE word/value (PDF just split it — always treat/edit them TOGETHER); gap ≈ a space width → words of one phrase; gap over ~1×size → separate fields/columns. So "0" <gap 0.2> ",00 €" is ONE amount, while "Due:" <gap 40> "04.07.2026" is a label and a value.',
  'REPLACING / CONSOLIDATING a value that is broken into pieces (a number, a date): ONE block = first a SINGLE pdfDelete listing ALL the old piece ids, then the pdfInsert of the clean text. NEVER insert a replacement without deleting the old pieces in the SAME block — that leaves the old text underneath (duplicates). Ids go STALE after every mutation: if a pdfDelete comes back FAILED, the REST of that block is skipped automatically — re-run pdfInfo and redo with fresh ids.',
  'SPLITTING a value so PART of it is editable (e.g. only the MONTH inside "July 15, 2026"): pdfDelete the whole chain, then pdfInsert each part as its OWN piece on the same baseline — insert part 1, take the returned w, insert part 2 at x+w (+ a space gap), etc. — then createVariable for the part(s) that will change. Do the same when a date/amount must be re-usable per month.',
  'SELF-CHECK LOOP: after building or changing a layout, call {"action":"pdfInfo"} again and READ it back — it is your visual snapshot of the document as data: every visual line with each piece\'s [x0..x1] span, the page\'s alignment columns (which left/right edges line up), an OVERLAPS section (texts on top of each other) and a POSSIBLE DUPLICATES section (same text twice in one place — a leftover of a bad replace). If something overlaps, duplicates, misaligns or is missing: fix it (pdfMove / pdfDelete / pdfInsert) and re-check with pdfInfo again until both sections are clean. Only then pdfSave and report to the user.',
  'IMPORTANT: after ANY edit the piece ids CHANGE — call {"action":"pdfInfo"} again for fresh ids before further edits. If a font error comes back ("не содержит символы" / "недоступен"), that family cannot render the text — pick another family (document font or Arial/Times New Roman/Courier New) and retry.'
].join('\n')

// Colour swatch button + dropdown panel: the document's palette, Transparent, and a custom picker.
// Used for vector stroke/fill (value may be 'none').
function ColorDrop({ value, colors, onPick, title, opacity, onOpacity }) {
  const [open, setOpen] = useState(null)
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!e.target.closest('.pdfed__colorpanel')) setOpen(null) }
    window.addEventListener('mousedown', close, true)
    return () => window.removeEventListener('mousedown', close, true)
  }, [open])
  return (
    <span className="pdfed__colorwrap">
      <button
        className="pdfed__btn"
        title={title}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setOpen((v) => (v ? null : { x: r.left, y: r.bottom + 4 }))
        }}
      >
        <span className={'pdfed__swatch' + (value === 'none' ? ' is-none' : '')} style={value === 'none' ? undefined : { background: value }} />
      </button>
      {open && (
        <div className="pdfed__colorpanel" style={{ left: open.x, top: open.y }}>
          <div className="pdfed__swatches">
            {(colors || []).map((c) => (
              <button
                key={c}
                className={'pdfed__swatchbtn' + (c === value ? ' is-on' : '')}
                style={{ background: c }}
                title={c}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(c); setOpen(null) }}
              />
            ))}
          </div>
          <button className="pdfed__custom pdfed__custom--btn" onClick={() => { onPick('none'); setOpen(null) }}>
            <span className="pdfed__swatch is-none" /> Transparent
          </button>
          <label className="pdfed__custom">
            Custom
            <input type="color" value={value === 'none' ? '#000000' : value} onChange={(e) => onPick(e.target.value)} />
          </label>
          {onOpacity && (
            // whole-object transparency (PDF ExtGState alpha) — 0% fully transparent, 100% solid
            <label className="pdfed__custom pdfed__opacity" title="Opacity — 0% fully transparent, 100% solid">
              Opacity
              <input type="range" min="0" max="100" step="5" value={opacity ?? 100} onChange={(e) => onOpacity(+e.target.value)} />
              <span className="pdfed__opval">{opacity ?? 100}%</span>
            </label>
          )}
        </div>
      )}
    </span>
  )
}

// Number input + a dropdown of standard values sharing one box. The input keeps a local draft so
// partial entries ("-", "1.", "") survive typing — the parent is only notified on valid numbers.
function ComboNum({ value, onPick, opts, step = 1, min, max, width, title, onGrab, disabled }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const push = (raw) => {
    const v = parseFloat(raw)
    if (!isNaN(v)) onPick(Math.min(max, Math.max(min, v)))
  }
  return (
    <span className={'pdfed__combo' + (disabled ? ' is-locked' : '')} style={width ? { width } : undefined} title={title}>
      <input
        className="pdfed__num"
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        onMouseDown={onGrab}
        onChange={(e) => { setDraft(e.target.value); push(e.target.value) }}
        onBlur={() => setDraft(String(value))}
        onKeyDown={(e) => { if (e.key === 'Enter') push(e.currentTarget.value) }}
      />
      {opts?.length > 0 && (
        <select className="pdfed__combosel" value="" disabled={disabled} onMouseDown={onGrab} onChange={(e) => onPick(parseFloat(e.target.value))}>
          <option value="" hidden></option>
          {opts.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      )}
    </span>
  )
}

// selection-mode icons: single arrow — pick one element; double arrow — pick whole blocks
const CursorOneIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
    <path d="M6 3l12 9-6 1 3.5 7-2.8 1.3L9.4 14 6 18z" />
  </svg>
)
const CursorBlockIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
    <path d="M4 2l9 7-4.5 0.8 2.6 5.2-2.2 1L6.6 11 4 14z" />
    <path d="M12 9l9 7-4.5 0.8 2.6 5.2-2.2 1-2.3-5.2L12 21z" opacity="0.55" />
  </svg>
)

// a variable — braces {x}
const VariableIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 4c-2 0-3 1-3 3v2c0 1-1 2-2 2 1 0 2 1 2 2v2c0 2 1 3 3 3" />
    <path d="M16 4c2 0 3 1 3 3v2c0 1 1 2 2 2-1 0-2 1-2 2v2c0 2-1 3-3 3" />
  </svg>
)

const InfoIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
)

// align icons (standard: an edge line + two bars snapped to it)
const AlignLeftIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 3v18" />
    <rect x="7" y="6" width="13" height="4" fill="currentColor" stroke="none" />
    <rect x="7" y="14" width="8" height="4" fill="currentColor" stroke="none" />
  </svg>
)
// distribute rows — three bars at equal vertical spacing
const DistributeRowsIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <rect x="4" y="4" width="16" height="3" fill="currentColor" stroke="none" />
    <rect x="4" y="10.5" width="16" height="3" fill="currentColor" stroke="none" />
    <rect x="4" y="17" width="16" height="3" fill="currentColor" stroke="none" />
  </svg>
)
const AlignTopIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M3 4h18" />
    <rect x="6" y="7" width="4" height="13" fill="currentColor" stroke="none" />
    <rect x="14" y="7" width="4" height="8" fill="currentColor" stroke="none" />
  </svg>
)
const AlignRightIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M20 3v18" />
    <rect x="4" y="6" width="13" height="4" fill="currentColor" stroke="none" />
    <rect x="9" y="14" width="8" height="4" fill="currentColor" stroke="none" />
  </svg>
)
const AlignBottomIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M3 20h18" />
    <rect x="6" y="4" width="4" height="13" fill="currentColor" stroke="none" />
    <rect x="14" y="9" width="4" height="8" fill="currentColor" stroke="none" />
  </svg>
)

// undo / redo — curved arrows (local: only the PDF toolbar)
const UndoIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 7L4 12l5 5" /><path d="M4 12h11a5 5 0 0 1 0 10h-1" />
  </svg>
)
const RedoIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 7l5 5-5 5" /><path d="M20 12H9a5 5 0 0 0 0 10h1" />
  </svg>
)
// "insert shape" — a square with a plus (local: only the PDF toolbar uses it)
const InsertShapeIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="7" width="12" height="12" rx="2" />
    <path d="M19 3v6M16 6h6" />
  </svg>
)

// "insert image" — a picture with a plus (local: only the PDF toolbar uses it)
const InsertImageIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="14" height="14" rx="2" />
    <circle cx="8" cy="10" r="1.5" />
    <path d="m3 17 4-4 3 3 4-4 3 3" />
    <path d="M19 3v6M16 6h6" />
  </svg>
)

// "insert text" — a T with a plus (local: only the PDF toolbar uses it)
const InsertTextIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5V3h12v2M10 3v14M7 17h6" />
    <path d="M18 15v6M15 18h6" />
  </svg>
)

// PDF editor. Each page is a raster image (exact visual) + a JSON text model loaded in parallel.
// Clicking a run selects it and frames it on the image (Stage 1); later stages add area selection,
// rich-text editing of the selected runs, and export back into the PDF stream.
// Ctrl+wheel zooms (anchored on the cursor); hold Space to pan.
export default function PdfEditor({ source, path, active = true }) {
  const { t } = useI18n()
  const [model, setModel] = useState([]) // [{ pageIndex, width, height, runs }]
  const modelRef = useRef(model); modelRef.current = model // fresh model for the AI dispatch (post-await safety)
  const [imgs, setImgs] = useState([]) // [{ pageIndex, url, width, height }] — re-rendered per scale
  const [pageCount, setPageCount] = useState(0)
  const [fontsNonce, setFontsNonce] = useState(0) // bumped after inserts: new EF faces need FontFaces
  const [lsEdit, setLsEdit] = useState(null) // string while the LS value is being typed manually
  const [editText, setEditText] = useState('') // live plain text of the open editor (coverage check)
  const [editErr, setEditErr] = useState(null) // "font X can't render …" — keeps the editor open
  const [covNonce, setCovNonce] = useState(0) // bumped when a font's glyph coverage finishes loading
  const covRef = useRef(new Map()) // family(lower) → {has} | null | 'loading'
  const [scale, setScale] = useState(1.5)
  const [status, setStatus] = useState('idle')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const [selected, setSelected] = useState(null) // { page, objs: [...] } — the resolved objects themselves (no re-filtering per action)
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false }) // mupdf journal state → undo/redo buttons
  const [saving, setSaving] = useState(false)
  const [nudge, setNudge] = useState(null) // accumulated arrow-key shift (pt), not yet committed
  const nudgeRef = useRef(null)
  const [clip, setClip] = useState(null) // clipboard: { page, items:[{type,bbox}] } for copy/paste duplication
  const [menu, setMenu] = useState(null) // right-click menu: { page, kind:'sel'|'empty', sx, sy, x?, y? }
  const [docFonts, setDocFonts] = useState([]) // PDF fonts: { name, embedded, subset, match } (match = similar system font)
  const [sysFonts, setSysFonts] = useState([]) // system/bundled font families
  const [fontSel, setFontSel] = useState('')
  const [colorSel, setColorSel] = useState('#000000')
  const [textOpacity, setTextOpacity] = useState(100) // selected text opacity 0..100 (transparency)
  const [colorOpen, setColorOpen] = useState(false)
  const [insertMode, setInsertMode] = useState(false) // false | 'text' | { image: {bytes,w,h} } — the next click places it
  const [textEdit, setTextEdit] = useState(null) // active rich-text editor: { page, x, y } (pt)
  const [fontSize, setFontSize] = useState(12) // pt
  const [boldSel, setBoldSel] = useState(false) // sticky style state: survives deselection, so a new
  const [italicSel, setItalicSel] = useState(false) // text starts with the last clicked text's style
  const [lineH, setLineH] = useState(1.25) // line-height multiplier (editor layout — coords carry it into the PDF)
  const [letterS, setLetterS] = useState(0) // letter spacing, pt → Tc
  const [pipette, setPipette] = useState(false) // eyedropper: next click on a text copies its full style into the editor
  const [shapeMenu, setShapeMenu] = useState(null) // shape-kind picker popover: { x, y }
  const [strokeW, setStrokeW] = useState(1) // shape stroke width, pt
  const [cornerR, setCornerR] = useState(0) // rect corner radius, pt
  const [dashSel, setDashSel] = useState('solid') // line type for inserted shapes
  const [showAll, setShowAll] = useState(() => localStorage.getItem('pdfedShowAll') === '1') // faint grey frames around EVERY (non-empty) element; persists across restarts
  const [liveGeo, setLiveGeo] = useState(null) // geometry readout while dragging/resizing (from PdfPage)
  const [showInfo, setShowInfo] = useState(false) // the quick-guide overlay
  // ---- variables (PDF templating): named groups of identical text; editing the value updates every occurrence ----
  const [variables, setVariables] = useState([]) // [{ id, name, value, occurrences:[{page,x,baseline,bbox,family,bold,italic,size,color,ls,enabled}] }]
  const variablesRef = useRef(variables); variablesRef.current = variables
  const [varDraft, setVarDraft] = useState(null) // create popup: { value, name, page, objs }
  const [expandedVars, setExpandedVars] = useState(() => new Set()) // ids whose occurrence list is open (hidden by default)
  const toggleVarExpand = (id) => setExpandedVars((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const [varsCollapsed, setVarsCollapsed] = useState(() => localStorage.getItem('pdfedVarsCol') === '1')
  const [varsWidth, setVarsWidth] = useState(() => Math.min(Math.max(Number(localStorage.getItem('pdfedVarsW')) || 280, 180), 520))
  const varsWidthRef = useRef(varsWidth); varsWidthRef.current = varsWidth
  const varsRestoredRef = useRef(false) // guard: don't persist until we've loaded the stored vars
  const varsSaveRef = useRef(null) // debounce timer for persisting variables
  const [selMode, setSelMode] = useState('single') // default: pick ONE element (less confusing); 'block' — whole text blocks
  const rteRef = useRef(null)
  const engineRef = useRef(null)
  const urlsRef = useRef([])
  const viewportRef = useRef(null)
  const panRef = useRef(null)
  const zoomAnchorRef = useRef(null) // keeps the point under the cursor fixed across a zoom step

  const revoke = () => { for (const u of urlsRef.current) URL.revokeObjectURL(u); urlsRef.current = [] }

  useEffect(() => { engineRef.current = createPdfEngine(); return () => { engineRef.current?.dispose(); revoke() } }, [])

  // open the document when bytes arrive
  useEffect(() => {
    if (source === undefined || !engineRef.current) return
    let alive = true
    setStatus('loading')
    console.log('[pdf][open]', path || '(no path)') // full path in every session log — bug reports point at the exact file
    Promise.resolve(engineRef.current.open(source))
      .then((info) => { if (alive) setPageCount(info?.pageCount || 0) })
      .catch((err) => { console.error('[pdf] open failed:', err, '—', path); if (alive) setStatus('error') })
    return () => { alive = false }
  }, [source])

  // load the JSON text model once (scale-independent)
  useEffect(() => {
    if (!pageCount || !engineRef.current) return
    let alive = true
    ;(async () => {
      const out = []
      for (let i = 0; i < pageCount; i++) {
        const r = await engineRef.current.getModel(i)
        if (!alive) return
        out.push({ pageIndex: i, ...r }) // width/height, palettes (fonts/colors), runs, images, vectors
      }
      if (alive) setModel(out)
    })().catch((err) => console.error('[pdf] getModel failed:', err))
    return () => { alive = false }
  }, [pageCount])

  // Raster resolution is capped: above RENDER_CAP× the same bitmap is stretched by CSS. A full A4 at
  // 7× would be ~25 Mpx per re-render (seconds of rasterise+PNG-encode on every move/zoom step);
  // at 4× it stays ~8 Mpx, and zooming past the cap doesn't touch the worker at all.
  const RENDER_CAP = 4
  const renderScale = Math.min(scale, RENDER_CAP)

  // render page images whenever the doc opens or the (capped) render scale changes
  useEffect(() => {
    if (!pageCount || !engineRef.current) return
    let alive = true
    setStatus('loading')
    ;(async () => {
      const out = []
      for (let i = 0; i < pageCount; i++) {
        const r = await engineRef.current.renderImage(i, renderScale)
        if (!alive) return
        out.push({ pageIndex: i, url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), width: r.width, height: r.height })
      }
      if (!alive) { for (const p of out) URL.revokeObjectURL(p.url); return }
      revoke(); urlsRef.current = out.map((p) => p.url); setImgs(out); setStatus('ready')
    })().catch(() => alive && setStatus('error'))
    return () => { alive = false }
  }, [pageCount, renderScale])

  // Font inventory for the dropdown: the document's own fonts first (each non-embedded or subset one
  // paired with the most similar installed family), then every system font.
  useEffect(() => {
    if (!pageCount || !engineRef.current) return
    let alive = true
    ;(async () => {
      const [info, sys] = await Promise.all([
        engineRef.current.getFontsInfo().catch(() => ({ fonts: [] })),
        Promise.resolve(api.fonts?.list?.()).catch(() => [])
      ])
      if (!alive) return
      const families = (Array.isArray(sys) ? sys : []).map((f) => f?.family || f).filter(Boolean)
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
      const nf = families.map((f) => [norm(f), f])
      const similar = (name) => {
        const n = norm(name)
        const hit = nf.find(([k]) => k === n) || nf.find(([k]) => k.length > 3 && (n.includes(k) || k.includes(n)))
        if (hit) return hit[1]
        // ONE common clone table (src/shared/fontClones) — the same one main uses for Google downloads
        return cloneFor(name)?.system || 'Arial'
      }
      // every PDF font may need a lookalike for NEW text (subset / non-embedded / non-loadable)
      const fonts = (info.fonts || []).map((f) => ({ ...f, match: f.embedded && !f.subset ? null : similar(f.name) }))
      // Register a @font-face under the PDF font's OWN NAME for every document font, so
      // font-family: "NimbusSans-Regular" actually renders in the editor:
      //  • browser-loadable embedded faces (TrueType + cmap) use their real bytes;
      //  • everything else gets the bytes of its closest system lookalike under that name.
      for (const f of fonts) {
        try {
          const look = f.match || similar(f.name)
          const addFace = (bytes) => new FontFace(f.name, bytes).load().then((ff) => document.fonts.add(ff))
          // remember which family ACTUALLY substitutes this doc font — the dropdown shows "≈ Family"
          const noteSubst = (fam) => { if (fam && alive) setDocFonts((prev) => prev.map((x) => (x.name === f.name ? { ...x, subst: fam } : x))) }
          // fonts:file runs the full chain in main (installed → Google exact → Google metric clone
          // → Noto) — so an exotic family downloads its REAL face and the editor shows true glyphs
          const loadLookalike = () => Promise.resolve(api.fonts.file(baseFamily(f.name), {})).then((sys) => {
            if (sys?.bytes) { noteSubst(sys.family); ensureDomFace(sys.family, sys.bytes, sys.bold, sys.italic); return addFace(sys.bytes) }
            return Promise.resolve(api.fonts.file(look, {})).then((s2) => { if (s2?.bytes) { noteSubst(s2.family); ensureDomFace(s2.family, s2.bytes, s2.bold, s2.italic); return addFace(s2.bytes) } })
          }).catch(() => {})
          // real bytes when the browser accepts them; if OTS rejects the face (subset without a
          // cmap etc.) the SAME name still gets the substitute — the editor never falls to a blank
          if (f.bytes) addFace(f.bytes).catch(loadLookalike)
          else loadLookalike()
        } catch (_) {}
      }
      setDocFonts(fonts)
      setSysFonts(families)
      if (fonts.length) setFontSel((v) => v || fonts[0].name)
    })()
    return () => { alive = false }
  }, [pageCount, fontsNonce])

  // preload doc-font coverage whenever the font dropdown could act on text — editing OR a text
  // object selected on the page — so incapable fonts are greyed out from the first frame
  useEffect(() => {
    if (!textEdit) { setEditText(''); setEditErr(null) }
    if (textEdit || (selected?.objs || []).some((o) => o.type === 'text')) for (const f of docFonts) ensureCoverage(f.name, f.bytes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textEdit, selected])

  // every colour used in the document (text + art), merged across pages — the colour dropdown
  const docColors = [...new Set(model.flatMap((p) => p.colors || []))]

  // a single selected TEXT object shows ITS font/size/colour (and B/I light up) in the toolbar;
  // any wider selection locks the style controls instead
  const singleText = !textEdit && selected?.objs.length === 1 && selected.objs[0].type === 'text' ? selected.objs[0] : null
  // style controls (font, size, B/I, LS, colour) are live whenever ANY text is selected — a change
  // applies to EVERY selected text object; locked only for non-text (images/vectors) or empty
  const styleLocked = !textEdit && !selected?.objs.some((o) => o.type === 'text')
  const selPg = selected ? model.find((p) => p.pageIndex === selected.page) : null
  useEffect(() => {
    if (textEdit || !selPg) return
    // representative run = the FIRST selected text object (reading order), for ANY count — a
    // multi-piece selection used to leave the toolbar showing a STALE font from a prior selection
    const rep = (selected?.objs || []).filter((o) => o.type === 'text').sort((a, b) => a.y - b.y || a.x - b.x)[0]
    if (!rep) return
    const f = selPg.fonts?.[rep.f]
    if (f) {
      // show the run's ACTUAL font. Only right AFTER a pick (pickApplyRef) do we collapse the
      // weight-specific readback (Arial-BoldMT) to what the user just chose (Arial) — a plain
      // selection must NOT inherit a stale pick from earlier (that showed "Arial Black" for a
      // real Arial-Bold run).
      const shown = pickApplyRef.current ? displayFontName(f.name) : f.name
      pickApplyRef.current = false
      console.log(`[pdf][sel] rep run f=${rep.f} → font "${f.name}" → shown "${shown}" (b=${!!f.bold} i=${!!f.italic})`)
      setFontSel(shown); setBoldSel(!!f.bold); setItalicSel(!!f.italic)
    }
    if (rep.c !== undefined && selPg.colors?.[rep.c]) setColorSel(selPg.colors[rep.c])
    if (rep.size) setFontSize(rep.size)
    setLetterS(rep.ls || 0) // the run's ORIGINAL Tc from the stream (e.g. -1.1)
    setTextOpacity(rep.opacity ?? 100) // its transparency, if any
    // …and the values STAY after deselection — a new text starts with the last clicked style
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  // the colour panel closes on any press outside it (capture — overlays stop propagation)
  useEffect(() => {
    if (!colorOpen) return
    const close = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.pdfed__colorwrap')) setColorOpen(null) }
    window.addEventListener('mousedown', close, true)
    return () => window.removeEventListener('mousedown', close, true)
  }, [colorOpen])

  // Ctrl + wheel zoom (non-passive so we cancel the browser zoom). Anchor on the point under the cursor.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setScale((s) => {
        const ns = Math.min(10, Math.max(0.3, s * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
        if (ns !== s) zoomAnchorRef.current = { contentX: (el.scrollLeft + cx) / s, contentY: (el.scrollTop + cy) / s, cx, cy }
        return ns
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // After a zoom re-layout, scroll so the recorded content point sits back under the cursor.
  useLayoutEffect(() => {
    const a = zoomAnchorRef.current
    const el = viewportRef.current
    if (!a || !el) return
    el.scrollLeft = a.contentX * scale - a.cx
    el.scrollTop = a.contentY * scale - a.cy
    zoomAnchorRef.current = null
  }, [scale])

  // Keyboard: arrows nudge the selection by one screen pixel (page scroll suppressed) — the frame
  // moves instantly, the accumulated shift is committed to the stream after a short pause. Ctrl+C
  // copies the selection to the internal clipboard, Ctrl+V duplicates it into the stream.
  useEffect(() => {
    const isField = (n) => n instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) || n.isContentEditable)
    const onKey = (e) => {
      if (isField(e.target)) return
      if (e.key === 'Escape' && pipette) { setPipette(false); return }
      // physical keys (e.code), so the shortcuts work in any keyboard layout (RU gives e.key='с'/'м')
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') { if (selected) { e.preventDefault(); copySelected() } return }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') { if (clip) { e.preventDefault(); pasteClip() } return }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return } // undo / Shift = redo
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); doRedo(); return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); deleteSelected(); return } // same as the trash button / context menu
      const K = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
      if (!K || !selected || e.ctrlKey || e.metaKey) return
      e.preventDefault() // keep the viewport from scrolling
      const step = (e.shiftKey ? 10 : 1) / scale // one screen pixel per press, 10 with Shift
      const cur = nudgeRef.current || { dx: 0, dy: 0, page: selected.page, objs: selected.objs }
      cur.dx += K[0] * step
      cur.dy += K[1] * step
      nudgeRef.current = cur
      setNudge({ page: cur.page, dx: cur.dx, dy: cur.dy })
      clearTimeout(cur.timer)
      cur.timer = setTimeout(() => {
        const n = nudgeRef.current
        nudgeRef.current = null
        setNudge(null)
        if (n && (n.dx || n.dy)) moveSelected(n.page, n.objs, n.dx, n.dy)
      }, 350)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, clip, model, scale, pipette])

  // While the context menu is open, ANY mousedown outside it closes it. Capture phase — the page
  // overlays stopPropagation their mousedowns, so the menu's own document listener never sees them.
  useEffect(() => {
    if (!menu) return
    const close = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.ctx-menu')) setMenu(null) }
    window.addEventListener('mousedown', close, true)
    return () => window.removeEventListener('mousedown', close, true)
  }, [menu])

  // Hold Space to pan the view like a hand tool
  useEffect(() => {
    const isField = (n) => n instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)
    const down = (e) => { if (e.code !== 'Space' || isField(e.target) || e.target?.isContentEditable) return; e.preventDefault(); setSpaceHeld(true) }
    const up = (e) => { if (e.code === 'Space') setSpaceHeld(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  const onPanMouseDown = (e) => {
    const el = viewportRef.current
    if (!spaceHeld || !el) return
    e.preventDefault()
    setPanning(true)
    panRef.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
    const move = (ev) => {
      const p = panRef.current
      if (!p || !viewportRef.current) return
      viewportRef.current.scrollLeft = p.left - (ev.clientX - p.x)
      viewportRef.current.scrollTop = p.top - (ev.clientY - p.y)
    }
    const upp = () => { panRef.current = null; setPanning(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', upp) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', upp)
  }

  // debug: one compact line per object, so selection/copy/paste lists can be compared
  const dbg = (o) => `${o.id} ${o.type} z${o.z} [${o.bbox.x},${o.bbox.y},${o.bbox.w},${o.bbox.h}]${o.text ? ' "' + o.text.slice(0, 30) + '"' : ''}`

  const onSelect = (pageIndex, objs) => {
    // any selection change discards an uncommitted arrow-key nudge — its timer must never fire
    // against a selection that no longer exists
    if (nudgeRef.current) { clearTimeout(nudgeRef.current.timer); nudgeRef.current = null; setNudge(null) }
    console.log(`[pdf][select] ${path?.split(/[\\/]/).pop() || '?'} page ${pageIndex}, ${objs?.length || 0} objs:\n` + (objs || []).map(dbg).join('\n'))
    setSelected(objs && objs.length ? { page: pageIndex, objs } : null)
  }
  const imgOf = (i) => imgs.find((im) => im.pageIndex === i)

  // transparent sprite of ONLY the given objects (for the drag ghost) — nothing around them leaks in
  const spriteFor = async (pageIndex, objs) => {
    // a merged fill+stroke shape (filled arrow) spans TWO device ops — include its fill z too
    const zs = objs.flatMap((o) => (o.zf !== undefined ? [o.z, o.zf] : [o.z])).filter((z) => z >= 0)
    if (!zs.length) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const o of objs) { x0 = Math.min(x0, o.bbox.x); y0 = Math.min(y0, o.bbox.y); x1 = Math.max(x1, o.bbox.x + o.bbox.w); y1 = Math.max(y1, o.bbox.y + o.bbox.h) }
    try {
      const r = await engineRef.current.renderObjects(pageIndex, zs, { x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 }, renderScale)
      return { url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), x: r.x, y: r.y, w: r.w, h: r.h }
    } catch (err) { console.error('[pdf] sprite failed:', err); return null }
  }

  // Save: OS save dialog starting at the source file (same name → the OS confirms the overwrite,
  // a new name → a copy), then write the worker's edited document to disk.
  const handleSave = async () => {
    if (!engineRef.current || saving) return
    setSaving(true)
    try {
      const out = await api.pdf.saveDialog(path)
      if (out) {
        const r = await engineRef.current.save()
        const w = await api.pdf.write(out, new Uint8Array(r.bytes))
        if (!w?.ok) throw new Error(w?.error || 'write failed')
        // Save-As (new name) → switch the editor to the NEW file (its undo history starts fresh).
        // Same file → keep editing the current doc so the UNDO history survives (no re-open).
        if (out !== path) ui('openPdf', { path: out })
      }
    } catch (err) { console.error('[pdf] save failed:', err) } finally { setSaving(false) }
  }

  // re-render one page's image + model after a mutation; returns the fresh model
  const refreshPage = async (pageIndex) => {
    const [im, m] = await Promise.all([engineRef.current.renderImage(pageIndex, scale), engineRef.current.getModel(pageIndex)])
    const url = URL.createObjectURL(new Blob([im.png], { type: 'image/png' }))
    urlsRef.current.push(url)
    // DECODE the new page image BEFORE swapping it in — otherwise the browser paints the still-decoding
    // <img> a frame late, and on an edit-commit the OLD text flashes under the (now-removed) cover
    try { const pre = new Image(); pre.src = url; await pre.decode() } catch { /* fall through — worst case a tiny flash */ }
    setImgs((prev) => prev.map((p) => (p.pageIndex === pageIndex ? { pageIndex, url, width: im.width, height: im.height } : p)))
    setModel((prev) => prev.map((p) => (p.pageIndex === pageIndex ? { pageIndex, ...m } : p)))
    engineRef.current.undoState().then(setUndoState).catch(() => {}) // keep the undo/redo buttons live
    return m
  }
  // re-render EVERY page — used after undo/redo, which can touch any page
  const refreshAll = async () => { for (let i = 0; i < pageCount; i++) await refreshPage(i) }
  // undo / redo the last document mutation (mupdf journal), then repaint and drop the (now stale) selection
  const doUndo = async () => {
    if (!engineRef.current || busyRef.current || !undoState.canUndo) return // undo currently disabled (journal off)
    busyRef.current = true
    try { const st = await engineRef.current.undo(); onSelect(selected?.page ?? 0, null); await refreshAll(); setUndoState(st) }
    catch (err) { console.error('[pdf] undo failed:', err) } finally { busyRef.current = false }
  }
  const doRedo = async () => {
    if (!engineRef.current || busyRef.current || !undoState.canRedo) return
    busyRef.current = true
    try { const st = await engineRef.current.redo(); onSelect(selected?.page ?? 0, null); await refreshAll(); setUndoState(st) }
    catch (err) { console.error('[pdf] redo failed:', err) } finally { busyRef.current = false }
  }

  // drag → shift the objects' coordinates inside the PDF stream, then re-render. The objects arrive
  // as an argument (not from state) so press-and-drag works in ONE gesture, before the state lands.
  // ONE client-side selection shift for every op (move/align/distribute): bbox, anchors, the
  // oriented ink box of rotated objects AND line endpoints all travel together — partial copies of
  // this kept drifting apart (the frame snapped back to stale coordinates)
  const shiftObj = (o, dx, dy) => ({
    ...o,
    bbox: { ...o.bbox, x: o.bbox.x + dx, y: o.bbox.y + dy },
    x: o.x + dx,
    y: o.y + dy,
    ox: o.ox !== undefined ? o.ox + dx : undefined,
    oy: o.oy !== undefined ? o.oy + dy : undefined,
    line: o.line ? { ...o.line, x1: o.line.x1 + dx, y1: o.line.y1 + dy, x2: o.line.x2 + dx, y2: o.line.y2 + dy } : undefined
  })

  // does this text run share its baseline with another run of the SAME block? (then a plain stream
  // move would drag the whole line — "June" would pull "TES developing" along)
  const sharesLine = (pageIndex, o) => {
    const pg = model.find((p) => p.pageIndex === pageIndex)
    if (!pg || o.type !== 'text') return false
    const blk = (o.id || '').split('.')[0]
    return pg.runs.some((r) => r.id !== o.id && Math.abs(r.y - o.y) < 3 && (r.id || '').split('.')[0] === blk)
  }

  // detach ONE text object off its shared line and drop it at the new spot: blank only its own show
  // (by x/baseline anchor — neighbours untouched) and re-insert the same text with its OWN embedded
  // font at x+dx / baseline+dy. Uses the proven replaceText path (no fragile Td surgery).
  const detachMoveText = async (pageIndex, o, dx, dy) => {
    const pg = model.find((p) => p.pageIndex === pageIndex)
    if (!pg) return false
    const cur = pg.fonts?.[o.f] || {}
    const family = cur.name || 'Arial', bold = !!cur.bold, italic = !!cur.italic
    const k = `${family}|${bold ? 'b' : ''}${italic ? 'i' : ''}`
    const fonts = {}
    const src = await fontSourceFor(family, bold, italic) // the run's own font — exact, no reflow
    if (src) fonts[k] = src
    const gaps = Math.max(1, (o.text || '').length - 1)
    await engineRef.current.replaceText(
      pageIndex,
      [{ type: 'text', bbox: o.bbox, x: o.x, y: o.y }], // blank ONLY this run's show
      { lines: [[{ text: o.text, size: o.size, color: pg.colors?.[o.c] || '#000000', fontKey: k, x: o.x + dx, baseline: o.y + dy, ls: undefined, fitW: o.bbox.w }]] },
      fonts,
      await getFallbacksFor(fonts),
      true // textOnly: blank the show, don't redact
    )
    return true
  }

  const moveSelected = async (pageIndex, objs, dx, dy) => {
    if (!objs?.length || busyRef.current) return
    // a single text object sitting on a shared line → detach it instead of moving the whole line
    if (objs.length === 1 && objs[0].type === 'text' && sharesLine(pageIndex, objs[0])) {
      busyRef.current = true
      try {
        const o = objs[0]
        await detachMoveText(pageIndex, o, dx, dy)
        const m = await refreshPage(pageIndex)
        // select ONLY the re-inserted piece at its new spot — NOT a signature diff: blanking this
        // run nudges the raster width of its old line-mates, which a diff would wrongly grab too
        const tx = o.x + dx, ty = o.y + dy
        const moved = allOf(m).filter((r) => r.type === 'text' && (r.text || '').trim() === (o.text || '').trim())
          .sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty))[0]
        console.log(`[pdf][move] detached "${o.text}" d=(${dx.toFixed(1)},${dy.toFixed(1)})`)
        onSelect(pageIndex, moved ? [moved] : [])
      } catch (err) { console.error('[pdf] detach-move failed:', err) } finally { busyRef.current = false }
      return
    }
    const items = objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y, dx, dy })) // x/y = exact text anchor
    try {
      await engineRef.current.moveObjects(pageIndex, items)
      await refreshPage(pageIndex)
      // keep the SAME selection, just shifted — no re-computing from the fresh model (which could
      // return inflated/merged boxes when the objects land next to other content). The selection
      // lives until the user clicks something else.
      const shifted = objs.map((o) => shiftObj(o, dx, dy))
      console.log(`[pdf][move] d=(${dx.toFixed(1)},${dy.toFixed(1)}), ${shifted.length} object(s) shifted`)
      onSelect(pageIndex, shifted)
    } catch (err) { console.error('[pdf] move failed:', err) }
  }

  // rotate the whole selection (one or many objects) around a pivot; the worker wraps each unit in
  // a conjugated rotation cm — the objects turn as a group. Re-select via before/after diff.
  const rotateSelected = async (pageIndex, objs, angle, cx, cy) => {
    if (busyRef.current || !objs?.length) return
    busyRef.current = true
    try {
      const pg = model.find((p) => p.pageIndex === pageIndex)
      const before = new Set(allOf(pg).map(sigOf))
      await engineRef.current.rotateObjects(pageIndex, objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })), angle, cx, cy)
      const m = await refreshPage(pageIndex)
      const changed = allOf(m).filter((o) => !before.has(sigOf(o)))
      console.log(`[pdf][rotate] ${objs.length} obj(s) by ${angle.toFixed(1)}° around (${cx.toFixed(0)},${cy.toFixed(0)})`)
      onSelect(pageIndex, changed.length ? changed : [])
    } catch (err) { console.error('[pdf] rotate failed:', err) } finally { busyRef.current = false }
  }

  // object signature that survives a re-parse: for text — stext metrics + the string itself (the
  // raster bbox tightening can shift y/h when a copy overlaps a neighbour, so those stay out of it)
  const sigOf = (o) => (o.type === 'text'
    ? `t|${o.bbox.x.toFixed(1)}|${o.bbox.w.toFixed(1)}|${o.size}|${o.text}`
    : `${o.type}|${o.bbox.x.toFixed(1)},${o.bbox.y.toFixed(1)},${o.bbox.w.toFixed(1)},${o.bbox.h.toFixed(1)}|${o.kind || ''}`)
  const allOf = (pg) => [...pg.runs, ...(pg.images || []), ...(pg.vectors || [])]

  // one mutation at a time: rapid clicks (B, B, I…) while a delete+insert+re-render is in flight
  // would operate on stale bboxes and shred neighbouring content
  const busyRef = useRef(false)

  // universal fallback font for every text mutation — the worker swaps it in whenever a chosen
  // font can't encode the text (validated BEFORE anything is deleted)
  const fallbackRef = useRef(null)
  const getFallback = async () => {
    if (!fallbackRef.current) {
      const f = await Promise.resolve(api.fonts.file('Arial', {})).catch(() => null)
      if (f?.bytes) fallbackRef.current = { bytes: f.bytes, family: f.family || 'Arial' }
    }
    return fallbackRef.current
  }
  // every REAL face the chain resolves gets a DOM FontFace under its own family name (with proper
  // weight/style descriptors): the editor then MEASURES with the same bytes the PDF embeds — the
  // browser's default-font fallback had different digit widths, so committed gaps didn't match
  const domFacesRef = useRef(new Set())
  const ensureDomFace = (family, bytes, bold = false, italic = false) => {
    const k = `${family}|${bold ? 1 : 0}${italic ? 1 : 0}`
    if (!family || !bytes || domFacesRef.current.has(k)) return
    domFacesRef.current.add(k)
    try {
      new FontFace(family, bytes.slice(0), { weight: bold ? '700' : '400', style: italic ? 'italic' : 'normal' })
        .load().then((ff) => document.fonts.add(ff)).catch(() => {})
    } catch (_) {}
  }
  // per-(family+style) substitute through the FULL chain (installed → Google exact → metric clone →
  // Noto) — nothing hardcoded: NimbusSans-Bold gets Arimo Bold, an exotic family gets its own real
  // face. Cached per session.
  const fbCacheRef = useRef(new Map())
  const fallbackFor = async (family, bold, italic) => {
    const kk = `${family}|${bold ? 1 : 0}${italic ? 1 : 0}`
    const c = fbCacheRef.current
    if (!c.has(kk)) {
      let f = await Promise.resolve(api.fonts.file(baseFamily(family), { bold, italic })).catch(() => null)
      if (!f?.bytes) f = await Promise.resolve(api.fonts.file('Arial', { bold, italic })).catch(() => null) // last resort
      c.set(kk, f?.bytes ? { bytes: f.bytes, family: f.family || baseFamily(family) } : null)
      const hit = c.get(kk)
      if (hit) ensureDomFace(hit.family, hit.bytes, bold, italic) // the editor must measure with the SAME face
    }
    return c.get(kk)
  }
  // fallback bundle for a fonts map (key = "Family|bi"): every key gets ITS OWN style-matched
  // substitute — the worker uses it for whole-run fallback AND per-char mixed-font splits
  const getFallbacksFor = async (fonts) => {
    const byKey = {}
    for (const k of Object.keys(fonts || {})) {
      const fam = fonts[k].pdf || fonts[k].family || k.split('|')[0]
      const st = k.split('|')[1] || ''
      const fb = await fallbackFor(fam, st.includes('b'), st.includes('i'))
      if (fb) byKey[k] = fb
    }
    const def = byKey[Object.keys(byKey)[0]] || (await getFallback())
    return def ? { ...def, byKey } : null
  }

  // Resolve the font FILE for a family+style. A document font reuses its own bytes (pdf: name → the
  // worker pulls them from the file) so restyled text looks exactly like the rest of the document.
  // BUT: for NEW text a subset/non-embedded PDF font can't be trusted (missing glyphs) — the system
  // lookalike steps in. A style change (bold/italic) also falls back to the lookalike in that style.
  // strip subset/PostScript/style decorations → a plain family the system loader can resolve
  // (weight/slant are requested separately via {bold, italic}); "Arial-BoldMT" → "Arial",
  // "TimesNewRomanPS-BoldMT" → "Times New Roman"
  const baseFamily = (n) => {
    let s = String(n).replace(/^[A-Z]{6}\+/, '') // subset tag ABCDEF+
    s = s.replace(/[-,\s]*(Bold|Italic|Oblique|Black|Heavy|Light|Medium|Semibold|Demi|Regular|Roman)+(MT|PS|PSMT)*$/i, '')
    s = s.replace(/(PSMT|PS|MT)$/i, '') // trailing PostScript markers
    s = s.replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → words (TimesNewRoman → Times New Roman)
    return s.trim() || String(n)
  }
  const fontSourceFor = async (family, bold, italic, forNewText = false) => {
    const src = await fontSourceForImpl(family, bold, italic, forNewText)
    console.log(`[pdf][font] resolve "${family}" b=${!!bold} i=${!!italic} newText=${forNewText} → ${src ? (src.pdf ? 'embedded {pdf:' + src.pdf + '}' : 'file «' + src.family + '»') : 'NULL'}`)
    return src
  }
  const fontSourceForImpl = async (family, bold, italic, forNewText = false) => {
    const df = docFonts.find((f) => f.name === family)
    // own bytes only for TrueType document fonts (Type1/CFF mis-encode through our CID insert),
    // and — for NEW text — only full (non-subset) faces. The requested style must match the style
    // BAKED INTO the face: "NimbusSans-Bold" asked as bold IS the exact face (the old !bold guard
    // sent every bold doc font to a substitute); asking it as regular is a real restyle → resolve.
    const hasB = /bold|black|heavy/i.test(family), hasI = /italic|oblique/i.test(family)
    if (df && df.tt && !!bold === hasB && !!italic === hasI && !(forNewText && (df.subset || !df.embedded))) return { pdf: family }
    // EXACT family only — NO substitute (df.match). "Helvetica" resolves to the real Helvetica or
    // NOTHING (→ the caller errors and the user picks another). The picked family verbatim.
    const fam = baseFamily(df ? df.name : family)
    const f = await api.fonts.file(fam, { bold, italic })
    return f?.bytes ? { bytes: f.bytes, family: fam } : null
  }

  // Core re-style/re-text of ANY text runs on a page (used by the toolbar AND the AI): delete their
  // units and re-insert at the same baselines with the new font/colour/style/text — position is
  // untouched by construction. patch.text (single run) replaces the content. Throws on font
  // problems (FONT_UNAVAILABLE|family / worker FONT_MISS|family|chars) — callers present them.
  const restyleRuns = async (page, texts, patch) => {
    const pg = modelRef.current.find((p) => p.pageIndex === page)
    if (!pg) throw new Error(`page ${page} is not loaded`)
    const fonts = {}
    const lines = []
    for (const o of texts) {
      const cur = pg.fonts?.[o.f] || {}
      const family = patch.family || cur.name || 'Arial'
      // picking a specific DOCUMENT face (e.g. "NimbusSans-Regular") means THAT face — its weight/
      // slant come from ITS name, not the run's current bold (asking a Regular face as bold missed
      // {pdf} and hunted a non-existent system "Nimbus Sans Bold" → "недоступен" for an EMBEDDED font)
      const pickedDoc = patch.family && docFonts.find((d) => d.name === patch.family)
      const bold = pickedDoc ? /bold|black|heavy/i.test(patch.family) : patch.bold !== undefined ? patch.bold : !!cur.bold
      const italic = pickedDoc ? /italic|oblique/i.test(patch.family) : patch.italic !== undefined ? patch.italic : !!cur.italic
      const k = `${family}|${bold ? 'b' : ''}${italic ? 'i' : ''}`
      if (!fonts[k]) {
        // CHANGING the font (pipette / dropdown) → use the full loadable face, not the doc's
        // subset: the picked font's subset may not cover THIS run's glyphs (→ "cannot encode").
        // Pure colour/size restyle keeps the run's own subset (it always covers its own text).
        const src = await fontSourceFor(family, bold, italic, !!patch.family)
        if (src) fonts[k] = src
        else throw new Error(`FONT_UNAVAILABLE|${family}`) // NO substitution, abort BEFORE any delete
      }
      // LS is a DELTA over the run's own base layout, never an absolute Tc of the replacement
      // font: base = current width minus its current spacing; target = base + wanted LS. So
      // LS=0 always returns to the run's ORIGINAL width (whatever font/kerning produced it),
      // and 5↔0 cycles are exact. NEW TEXT (patch.text) keeps the run's own ls, no width fit.
      const gaps = Math.max(1, (o.text || '').length - 1)
      const sizeScale = patch.size ? patch.size / (o.size || patch.size) : 1
      const baseW = (o.bbox.w - (o.ls || 0) * gaps) * sizeScale
      const wantLS = patch.ls !== undefined ? patch.ls : (o.ls || 0)
      const newText = patch.text !== undefined ? String(patch.text) : o.text
      lines.push([{
        text: newText,
        size: patch.size || o.size,
        color: patch.color || pg.colors?.[o.c] || '#000000',
        fontKey: k,
        x: o.x,
        baseline: o.y,
        ls: patch.text !== undefined ? (o.ls || 0) : undefined, // replaced text: natural width, own spacing
        fitW: patch.text !== undefined ? undefined : baseW + wantLS * gaps,
        alpha: (patch.opacity !== undefined ? patch.opacity : (o.opacity ?? 100)) / 100 // text transparency (keep the run's own unless changed)
      }])
    }
    // replaceText re-inserts each run UNROTATED at its baseline anchor — remember which runs were
    // rotated so we can turn their fresh copies back afterwards (LS/colour/size must not drop rotation)
    const rotated = texts.filter((o) => o.rot).map((o) => ({ x: o.x, y: o.y, rot: o.rot }))
    const before = new Set(allOf(pg).map(sigOf))
    // ATOMIC replace: the worker validates every font against the actual text FIRST — if a font
    // can't encode it (and the fallback can't either), nothing gets deleted
    await engineRef.current.replaceText(
      page,
      texts.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })), // x/y anchors → each run's OWN show op is blanked, neighbours untouched
      { lines },
      fonts,
      await getFallbacksFor(fonts)
    )
    // restore rotation BEFORE the first on-screen paint: locate each rotated run's fresh (unrotated)
    // copy via getModel ONLY (no render) and rotate it back around its baseline anchor by the original
    // angle. A refreshPage here would briefly paint the text horizontal, then rotate it — the "jumps
    // to vertical, then returns" flicker. Only the single refreshPage below repaints, straight to the
    // rotated result.
    for (const r of rotated) {
      const mm = await engineRef.current.getModel(page)
      const fresh = allOf(mm).find((o) => o.type === 'text' && !o.rot && Math.abs(o.x - r.x) < 1.5 && Math.abs(o.y - r.y) < 1.5)
      if (fresh) await engineRef.current.rotateObjects(page, [{ type: fresh.type, bbox: fresh.bbox, x: fresh.x, y: fresh.y }], -r.rot, fresh.x, fresh.y)
    }
    const m = await refreshPage(page) // ONE visible repaint — the final rotated, restyled state
    setFontsNonce((n) => n + 1) // the restyled text may embed a NEW font — refresh the dropdown list
    return allOf(m).filter((o) => !before.has(sigOf(o)))
  }

  // human-readable font error (shared by the toolbar banner and the AI feedback)
  const fontErrText = (err) => {
    const s = String(err?.message || '')
    const miss = s.match(/FONT_MISS\|([^|]+)\|(.+)/)
    if (miss) return `шрифт «${miss[1]}» не содержит символы: ${miss[2]} — выберите другой`
    const unav = s.match(/FONT_UNAVAILABLE\|(.+)/)
    if (unav) return `шрифт «${unav[1]}» недоступен для встраивания — выберите другой`
    return null
  }

  // Re-style the SELECTED text objects (toolbar path): wraps the core with selection + banner UX.
  const restyleSelected = async (patch) => {
    if (!selected || busyRef.current) return
    const texts = selected.objs.filter((o) => o.type === 'text')
    if (!texts.length) return
    busyRef.current = true
    try {
      const changed = await restyleRuns(selected.page, texts, patch)
      console.log(`[pdf][restyle] ${texts.length} run(s) →`, patch)
      onSelect(selected.page, changed)
    } catch (err) {
      const fe = fontErrText(err)
      if (fe) setEditErr(`Шрифт: ${fe}.`)
      console.error('[pdf] restyle failed (nothing deleted):', err)
    } finally { busyRef.current = false }
  }

  // ---- variables: persistence (Phase 2) ----
  // restore once, when the model first loads: prefer the DB mirror (by path), fall back to the
  // definitions baked into the PDF catalog (so a file with variables restores even without our DB)
  useEffect(() => {
    if (varsRestoredRef.current || !model.length || !engineRef.current) return
    varsRestoredRef.current = true
    ;(async () => {
      try {
        let json = path ? await api.pdf?.varsGet?.(path) : null
        if (!json) { const r = await engineRef.current.readVariables(); json = r?.json || null }
        const list = json ? JSON.parse(json) : null
        if (Array.isArray(list) && list.length) {
          // find the runs currently sitting at an occurrence's anchors (styles/chainBox may be
          // stale — e.g. saved before chainBox existed — so rebuild from the live model)
          const liveRuns = (occ) => {
            const pg = model.find((p) => p.pageIndex === occ.page)
            if (!pg) return null
            const runs = (occ.parts || [{ x: occ.x, baseline: occ.baseline }])
              .map((p) => pg.runs.find((r) => Math.abs(r.x - p.x) < 1.5 && Math.abs(r.y - p.baseline) < 1.5))
              .filter(Boolean)
            return runs.length ? runs : null
          }
          setVariables(list.map((v) => {
            const occurrences = v.occurrences.map((occ) => {
              const runs = liveRuns(occ)
              if (!runs) return occ
              // refresh only chainBox (positions may lack it if saved before the fix) — KEEP the
              // stored style: reading it from live runs would inherit a previously-corrupted font
              const x0 = Math.min(...runs.map((r) => r.bbox.x)), x1 = Math.max(...runs.map((r) => r.bbox.x + r.bbox.w))
              const y0 = Math.min(...runs.map((r) => r.bbox.y)), y1 = Math.max(...runs.map((r) => r.bbox.y + r.bbox.h))
              return { ...occ, chainBox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
            })
            // the input reflects what's ACTUALLY in the PDF now, not the last-saved value
            const runs0 = liveRuns(v.occurrences[0])
            const value = runs0 ? joinRuns(runs0).replace(/\s+/g, ' ').trim() : v.value
            return { ...v, occurrences, value }
          }))
          console.log(`[pdf][vars] restored ${list.length} variable(s)`)
        }
      } catch (e) { console.warn('[pdf][vars] restore failed:', e?.message) }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])
  // persist on change (debounced): mirror to the DB (by path) AND embed in the in-memory PDF
  // catalog so the next Save bakes them into the file
  useEffect(() => {
    if (!varsRestoredRef.current) return
    clearTimeout(varsSaveRef.current)
    varsSaveRef.current = setTimeout(() => {
      const json = variables.length ? JSON.stringify(variables) : ''
      try { engineRef.current?.writeVariables(json) } catch {}
      if (path) api.pdf?.varsSet?.(path, json, variables.length)
    }, 500)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variables])

  // ---- variables ----
  const vnorm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
  // for matching: strip EVERY space so "2 000,00 €" and "2000,00€" are the same number
  const vmatch = (s) => (s || '').replace(/\s+/g, '').toLowerCase()
  // reconstruct the text of a chain of runs, inserting a space only where there's a real gap
  const joinRuns = (runs) => {
    const s = [...runs].sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))
    let out = ''
    for (let i = 0; i < s.length; i++) {
      if (i > 0) {
        const p = s[i - 1], c = s[i]
        if (Math.abs(c.y - p.y) > 3) out += '\n'
        else if (c.x - (p.x + p.bbox.w) > (c.size || 10) * 0.25) out += ' '
      }
      out += s[i].text || ''
    }
    return out
  }
  // one occurrence = a CHAIN of adjacent runs whose combined text is the value. styles by VALUE (not
  // palette index — those shift); parts[] holds every piece's anchor (all blanked on change), the
  // FIRST piece is where the single new value is inserted → the chain collapses to one clean text.
  const occFromRuns = (page, runs) => {
    const s = [...runs].sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))
    const first = s[0]
    const pg = model.find((p) => p.pageIndex === page)
    const f = pg?.fonts?.[first.f] || {}
    // union box of the whole chain — blanking uses its x-range so EVERY piece's show is caught,
    // even advance-chained ones whose shows all share the same Td px (per-piece anchors miss them)
    const x0 = Math.min(...s.map((r) => r.bbox.x)), x1 = Math.max(...s.map((r) => r.bbox.x + r.bbox.w))
    const y0 = Math.min(...s.map((r) => r.bbox.y)), y1 = Math.max(...s.map((r) => r.bbox.y + r.bbox.h))
    return {
      page, x: first.x, baseline: first.y, bbox: first.bbox,
      chainBox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      family: f.name || 'Arial', bold: !!f.bold, italic: !!f.italic, size: first.size,
      color: pg?.colors?.[first.c] || '#000000', ls: first.ls || 0,
      parts: s.map((r) => ({ x: r.x, baseline: r.y })),
      enabled: true
    }
  }
  const occParts = (o) => o.parts || [{ x: o.x, baseline: o.baseline }]
  // find every chain of adjacent same-line runs whose combined text equals the value (also single
  // runs) — so "2 000 EUR" split across 3 pieces and an unsplit "2000 EUR" both match
  const findChains = (target) => {
    const T = vmatch(target)
    if (!T) return []
    const out = []
    for (const pg of model) {
      const lines = new Map()
      for (const r of pg.runs) { const key = Math.round(r.y / 2); (lines.get(key) || lines.set(key, []).get(key)).push(r) }
      for (const line of lines.values()) {
        line.sort((a, b) => a.x - b.x)
        let i = 0
        while (i < line.length) {
          let acc = '', matched = false
          for (let j = i; j < line.length && j < i + 14; j++) {
            acc += line[j].text || '' // spaces are stripped by vmatch, so gaps don't matter
            const na = vmatch(acc)
            if (na === T) { out.push({ page: pg.pageIndex, runs: line.slice(i, j + 1) }); i = j + 1; matched = true; break }
            if (!T.startsWith(na)) break
          }
          if (!matched) i++
        }
      }
    }
    return out
  }
  // right-click "Create variable": open the popup with the selected chain's text as value/name
  const startCreateVariable = () => {
    if (!selected) return
    const texts = selected.objs.filter((o) => o.type === 'text')
    if (!texts.length) return
    const value = joinRuns(texts).replace(/\s+/g, ' ').trim()
    setVarDraft({ value, name: value, existing: '', page: selected.page, objs: texts })
  }
  // popup buttons: "add this" = the selected chain only; "find identical" = every matching chain
  const finishCreate = (findAll) => {
    const d = varDraft
    if (!d) return
    const occurrences = findAll
      ? findChains(d.value).map((c) => occFromRuns(c.page, c.runs))
      : [occFromRuns(d.page, d.objs)]
    if (!occurrences.length) { setVarDraft(null); return }
    const name = (d.existing || d.name || '').trim() || d.value.trim() || 'var'
    setVariables((vs) => {
      // typed/picked an EXISTING name → merge the new places into that variable (dedup by anchor)
      const existing = vs.find((v) => v.name.toLowerCase() === name.toLowerCase())
      if (existing) {
        const key = (o) => `${o.page}|${Math.round(o.x)}|${Math.round(o.baseline)}`
        const have = new Set(existing.occurrences.map(key))
        const merged = [...existing.occurrences, ...occurrences.filter((o) => !have.has(key(o)))]
        return vs.map((v) => (v === existing ? { ...v, occurrences: merged } : v))
      }
      const id = crypto.randomUUID?.() || 'v' + Math.random().toString(36).slice(2)
      return [...vs, { id, name, value: d.value, occurrences }]
    })
    setVarDraft(null)
    setVarsCollapsed(false)
  }
  // apply a new value to every ENABLED occurrence — blank the whole chain (chainBox x-range catches
  // every piece), insert the value as clean line(s) in the occurrence's own font at the first anchor
  const applyVariable = async (occurrences, value) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const byPage = {}
      for (const o of occurrences) { if (o.enabled === false) continue; (byPage[o.page] = byPage[o.page] || []).push(o) }
      for (const pageIndex of Object.keys(byPage).map(Number)) {
        const occs = byPage[pageIndex]
        const fonts = {}
        const items = []
        const specLines = []
        for (const o of occs) {
          items.push({ type: 'text', bbox: o.chainBox || o.bbox, x: o.x, y: o.baseline })
          const k = `${o.family}|${o.bold ? 'b' : ''}${o.italic ? 'i' : ''}`
          // reuse the run's OWN embedded font (exact, keeps weight) — fall back only if it can't
          // encode; forcing the full system face here made everything render bold
          if (!fonts[k]) { const src = await fontSourceFor(o.family, o.bold, o.italic); if (src) fonts[k] = src }
          const lh = (o.size || 10) * 1.25
          String(value).split('\n').forEach((line, li) => {
            if (line === '') return
            specLines.push([{ text: line, size: o.size, color: o.color, fontKey: k, x: o.x, baseline: o.baseline + li * lh, ls: o.ls || 0 }])
          })
        }
        await engineRef.current.replaceText(pageIndex, items, { lines: specLines }, fonts, await getFallbacksFor(fonts), true) // textOnly: don't redact already-blanked pieces
        await refreshPage(pageIndex)
      }
    } catch (e) { console.error('[pdf][variable] apply failed:', e) } finally { busyRef.current = false }
  }
  const changeVarValue = (id, val) => {
    setVariables((vs) => vs.map((v) => (v.id === id ? { ...v, value: val } : v)))
    const v = variablesRef.current.find((x) => x.id === id)
    if (v) deferMutation(() => applyVariable(v.occurrences, val))
  }
  const toggleOcc = (id, i) =>
    setVariables((vs) => vs.map((v) => (v.id !== id ? v : { ...v, occurrences: v.occurrences.map((o, k) => (k === i ? { ...o, enabled: o.enabled === false } : o)) })))
  const removeVariable = (id) => { setVariables((vs) => vs.filter((v) => v.id !== id)); setExpandedVars((s) => { const n = new Set(s); n.delete(id); return n }) }
  // does an occurrence (any piece of its chain) sit at a selected text object's anchor?
  const occMatches = (o, page, objs) => o.page === page && occParts(o).some((p) => objs.some((t) => t.type === 'text' && Math.abs(t.x - p.x) < 1.5 && Math.abs(t.y - p.baseline) < 1.5))
  // right-click "Remove from variable": drop the selected place(s) from every variable holding them
  // (a variable left with no places is removed entirely — so the last one takes the variable with it)
  const removeSelectionFromVars = () => {
    if (!selected) return
    const { page, objs } = selected
    setVariables((vs) => vs
      .map((v) => ({ ...v, occurrences: v.occurrences.filter((o) => !occMatches(o, page, objs)) }))
      .filter((v) => v.occurrences.length))
  }
  // click an occurrence → select every run currently at its chain's anchors (text may have changed)
  const highlightOcc = (o) => {
    const pg = model.find((p) => p.pageIndex === o.page)
    if (!pg) return
    const runs = []
    for (const p of occParts(o)) {
      const r = pg.runs.find((rr) => Math.abs(rr.x - p.x) < 1.5 && Math.abs(rr.y - p.baseline) < 1.5)
      if (r) runs.push(r)
    }
    if (runs.length) onSelect(o.page, runs)
  }
  const startVarsResize = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = varsWidthRef.current
    const onMove = (ev) => setVarsWidth(Math.min(Math.max(startW - (ev.clientX - startX), 180), 520)) // grows leftward
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); localStorage.setItem('pdfedVarsW', String(varsWidthRef.current)) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const toggleVarsCollapsed = () => setVarsCollapsed((c) => { localStorage.setItem('pdfedVarsCol', c ? '0' : '1'); return !c })

  // CSS family for a font name: a document font falls back to its system lookalike, so the editor
  // previews something sensible even when the embedded face couldn't be loaded into the browser
  // glyph coverage per font family (from its bytes' cmap). doc fonts carry bytes; anything else is
  // fetched through the same chain the commit uses, so "can this font render it" is authoritative.
  const ensureCoverage = (family, bytes) => {
    const key = String(family || '').toLowerCase()
    if (!key || covRef.current.has(key)) return
    covRef.current.set(key, 'loading')
    // 'unavailable' = no real bytes (not installed / not on Google / not embedded) → can't be used
    // at ALL → dropdown disables it; a coverage object = glyph set; null = bytes but no cmap
    const done = (ab, unavail) => { covRef.current.set(key, unavail ? 'unavailable' : ab ? fontCoverageOf(ab) : null); setCovNonce((n) => n + 1) }
    if (bytes) { done(bytes); return }
    Promise.resolve(api.fonts.file(family, {})).then((f) => done(f?.bytes || null, !f?.bytes)).catch(() => done(null, true))
  }
  // the text a font change would land on: the open editor's text, else the SELECTED text objects —
  // so the dropdown greys out incapable fonts both while editing AND on a plain page selection
  const coverageText = () => (textEdit ? editText : (selected?.objs || []).filter((o) => o.type === 'text').map((o) => o.text || '').join(''))
  // font state for the dropdown: 'ok' | 'unavailable' (no embeddable bytes) | 'nocover' (missing
  // glyphs for the current text). unknown → kick a load, treat as ok until it arrives
  const fontState = (family, bytes) => {
    const key = String(family || '').toLowerCase()
    const c = covRef.current.get(key)
    if (c === undefined) { ensureCoverage(family, bytes); return 'ok' }
    if (c === 'unavailable') return 'unavailable'
    if (c === 'loading') return 'ok'
    const txt = coverageText()
    if (!txt.trim()) return 'ok'
    return fontCovers(c, txt) ? 'ok' : 'nocover'
  }
  const fontCanRender = (family, bytes) => fontState(family, bytes) === 'ok'

  // remember EXACTLY what font the user last picked, so the dropdown keeps showing THAT — not the
  // weight-specific PS name the run reads back as. Picked "Arial" stays "Arial"; picked
  // "Arial-BoldMT" stays "Arial-BoldMT". Only collapse to the pick when the family matches (same
  // font, different weight); otherwise show the real readback name.
  const pickedFontRef = useRef(null)
  const pickApplyRef = useRef(false) // true for the ONE selection sync right after a pick — then off
  const displayFontName = (name) => {
    const p = pickedFontRef.current
    // no substitution now, so a picked font reads back under its OWN family — collapse the
    // weight-specific PS name (Arial-BoldMT → Arial) to the pick when the family matches
    return p && baseFamily(p) === baseFamily(name) ? p : name
  }

  const cssFontFor = (family) => {
    const df = docFonts.find((f) => f.name === family)
    // second family = what ACTUALLY substitutes (subst — the same face the commit chain resolves),
    // so per-glyph CSS fallback in the editor matches the letters the PDF will get
    const alt = df?.subst || df?.match
    return alt ? `"${family}", "${alt}"` : `"${family}"`
  }

  // typing into a number box fires per keystroke — batch the page-mutations into ONE (450ms after
  // the last change); the open rich-editor is styled immediately (cheap, local)
  const deferRef = useRef(null)
  const deferMutation = (fn) => { clearTimeout(deferRef.current); deferRef.current = setTimeout(fn, 450) }

  // toolbar controls: an open rich-editor gets the command; otherwise the page selection is restyled
  const pickFont = (family) => { pickedFontRef.current = family; pickApplyRef.current = true; setFontSel(family); if (textEdit) rteRef.current?.exec('fontName', cssFontFor(family)); else restyleSelected({ family }) }
  const pickColor = (hex) => { setColorSel(hex); if (textEdit) rteRef.current?.exec('foreColor', hex); else restyleSelected({ color: hex }) }
  const pickSize = (v) => { const s = Math.max(4, Math.min(200, v || 12)); setFontSize(s); if (textEdit) rteRef.current?.exec('size', s); else deferMutation(() => restyleSelected({ size: s })) }
  const allBold = () => { const pg = model.find((p) => p.pageIndex === selected?.page); return !!pg && selected.objs.filter((o) => o.type === 'text').every((o) => pg.fonts?.[o.f]?.bold) }
  const allItalic = () => { const pg = model.find((p) => p.pageIndex === selected?.page); return !!pg && selected.objs.filter((o) => o.type === 'text').every((o) => pg.fonts?.[o.f]?.italic) }
  const toggleBold = () => {
    if (textEdit) { setBoldSel((v) => !v); rteRef.current?.exec('bold') }
    else if (selected) { const b = !allBold(); setBoldSel(b); restyleSelected({ bold: b }) }
    else setBoldSel((v) => !v) // nothing open/selected → default for the next inserted text
  }
  const toggleItalic = () => {
    if (textEdit) { setItalicSel((v) => !v); rteRef.current?.exec('italic') }
    else if (selected) { const i = !allItalic(); setItalicSel(i); restyleSelected({ italic: i }) }
    else setItalicSel((v) => !v)
  }

  // LS on a selection: re-insert the runs with the letter spacing written as Tc
  const pickLS = (v) => {
    const ls = isNaN(v) ? 0 : v
    setLetterS(ls)
    // in the text editor apply LS to the SELECTION via the RTE (like font/size/colour do); only when
    // NOT editing does it restyle the committed run
    if (textEdit) rteRef.current?.exec('letterSpacing', ls)
    else if (selected) deferMutation(() => restyleSelected({ ls }))
  }
  // text transparency: opacity 0..100 (0 = fully transparent/invisible). Restyle path writes it as an
  // ExtGState alpha on the committed run — only when NOT in the text editor (the RTE has no opacity).
  const pickTextOpacity = (v) => {
    const op = Math.max(0, Math.min(100, Math.round(v)))
    setTextOpacity(op)
    if (!textEdit && selected) deferMutation(() => restyleSelected({ opacity: op }))
  }
  // LH on a selection of SEVERAL text lines: respace their baselines (top line stays put,
  // every next baseline lands at prev + LH × its size) — plain per-item vertical moves
  const pickLH = (v) => {
    const lh = v || 1.25
    setLineH(lh)
    if (!textEdit && selected) deferMutation(() => applyLineHeight(lh))
  }
  const applyLineHeight = async (lh) => {
    if (busyRef.current || !selected) return
    const texts = selected.objs.filter((o) => o.type === 'text').sort((a, b) => a.y - b.y)
    if (texts.length < 2) { console.log('[pdf][line-height] needs 2+ selected text lines'); return }
    busyRef.current = true
    try {
      const items = []
      const shifted = [texts[0]]
      let target = texts[0].y
      for (let i = 1; i < texts.length; i++) {
        target += lh * (texts[i].size || 12)
        const dy = +(target - texts[i].y).toFixed(2)
        if (dy) items.push({ type: 'text', bbox: texts[i].bbox, x: texts[i].x, y: texts[i].y, dx: 0, dy })
        shifted.push({ ...texts[i], y: +target.toFixed(2), bbox: { ...texts[i].bbox, y: +(texts[i].bbox.y + dy).toFixed(2) } })
      }
      if (items.length) {
        await engineRef.current.moveObjects(selected.page, items)
        await refreshPage(selected.page)
      }
      console.log(`[pdf][line-height] ${lh} → ${items.length} line(s) moved`)
      onSelect(selected.page, shifted.concat(selected.objs.filter((o) => o.type !== 'text')))
    } catch (err) { console.error('[pdf] line-height failed:', err) } finally { busyRef.current = false }
  }

  // eyedropper: pick a text on the page → copy its FULL style (font, size, colour, bold/italic)
  // into the toolbar state AND the current target: the open rich editor, or the selected text
  // objects on the page (restyled in the stream)
  const pipettePick = (pageIndex, o) => {
    setPipette(false)
    const pg = model.find((p) => p.pageIndex === pageIndex)
    const f = pg?.fonts?.[o.f]
    if (!f) return
    const color = pg.colors?.[o.c] || '#000000'
    const ls = o.ls || 0 // letter spacing (Tc) of the picked object — must travel with the style
    setFontSel(f.name); setFontSize(o.size); setColorSel(color); setBoldSel(!!f.bold); setItalicSel(!!f.italic); setLetterS(ls); setTextOpacity(o.opacity ?? 100)
    console.log('[pdf][pipette]', f.name, o.size, color, f.bold ? 'bold' : '', f.italic ? 'italic' : '', 'ls=' + ls)
    if (textEdit) {
      rteRef.current?.exec('applyStyle', { family: cssFontFor(f.name), sizePx: o.size, color, bold: !!f.bold, italic: !!f.italic })
    } else if (selected) {
      restyleSelected({ family: f.name, size: o.size, color, bold: !!f.bold, italic: !!f.italic, ls })
    }
  }

  // one gateway for every in-place object mutation (recolor / radius / stroke width / opacity):
  // run the op, re-read the page, re-find the object by its centre so it stays selected
  const mutateObject = async (op, kinds = ['vector'], center = null) => {
    if (busyRef.current || !selObj1 || !kinds.includes(selObj1.type)) return
    busyRef.current = true
    const pageIndex = selected.page
    const obj = selObj1
    try {
      await op(pageIndex, { type: obj.type, bbox: obj.bbox })
      const m = await refreshPage(pageIndex)
      const pool = obj.type === 'vector' ? m.vectors : m.images
      // re-find where the object is EXPECTED to be: a geometry-changing op (endpoint drag) passes
      // the new centre — searching around the old bbox would lose a rotated line entirely
      const cx = center ? center.x : obj.bbox.x + obj.bbox.w / 2
      const cy = center ? center.y : obj.bbox.y + obj.bbox.h / 2
      let best = null, bestD = center ? 25 : 9
      for (const o of pool || []) {
        const d = Math.hypot(o.bbox.x + o.bbox.w / 2 - cx, o.bbox.y + o.bbox.h / 2 - cy)
        if (d < bestD) { bestD = d; best = o }
      }
      onSelect(pageIndex, best ? [best] : [obj])
    } catch (err) { console.error('[pdf] object op failed:', err) } finally { busyRef.current = false }
  }
  const recolorSelected = (colors) => mutateObject((p, it) => engineRef.current.recolorVector(p, it, colors))
  const radiusSelected = (r) => mutateObject((p, it) => engineRef.current.setVectorRadius(p, it, r))
  const strokeWidthSelected = (w) => mutateObject((p, it) => engineRef.current.setStrokeWidth(p, it, w))
  // fillPct = fill (ca) opacity, strokePct = stroke (CA) opacity, both 0..100 and INDEPENDENT (PDF
  // ExtGState). strokePct omitted → same as fill (images / whole-object).
  const opacitySelected = (fillPct, strokePct) => {
    const f = Math.max(0, Math.min(100, fillPct))
    const s = Math.max(0, Math.min(100, strokePct ?? fillPct))
    return mutateObject((p, it) => engineRef.current.setOpacity(p, it, f / 100, s / 100), ['vector', 'image'])
  }
  const dashSelected = (d) => mutateObject((p, it) => engineRef.current.setDash(p, it, d))
  const lineGeoSelected = (pageIndex, obj, geo) =>
    mutateObject((p, it) => engineRef.current.setLineGeo(p, it, geo), ['vector'], { x: (geo.x1 + geo.x2) / 2, y: (geo.y1 + geo.y2) / 2 })

  // align 2+ selected objects: everything to the leftmost edge / the topmost edge
  const alignSelected = async (edge) => {
    if (!selected || selected.objs.length < 2 || busyRef.current) return
    busyRef.current = true
    try {
      const objs = selected.objs
      const minX = Math.min(...objs.map((o) => o.bbox.x))
      const minY = Math.min(...objs.map((o) => o.bbox.y))
      const maxX = Math.max(...objs.map((o) => o.bbox.x + o.bbox.w)) // rightmost edge
      const maxY = Math.max(...objs.map((o) => o.bbox.y + o.bbox.h)) // bottom edge
      // horizontal align works PER LINE: every piece of a line shifts by the SAME delta (that of the
      // line's leading piece) so advance-chained continuations ("Horokho"+"v") follow their leader
      // instead of each being snapped independently. left → line's leftmost; right → line's rightmost.
      const lineOf = new Map()
      let li = 0, prevY = null
      for (const o of [...objs].sort((a, b) => a.bbox.y - b.bbox.y)) {
        if (prevY !== null && o.bbox.y - prevY > 6) li++
        lineOf.set(o, li); prevY = o.bbox.y
      }
      const lineLeft = new Map(), lineRight = new Map()
      for (const o of objs) {
        const k = lineOf.get(o)
        lineLeft.set(k, Math.min(lineLeft.has(k) ? lineLeft.get(k) : Infinity, o.bbox.x))
        lineRight.set(k, Math.max(lineRight.has(k) ? lineRight.get(k) : -Infinity, o.bbox.x + o.bbox.w))
      }
      const dOf = (o) => ({
        dx: edge === 'left' ? minX - lineLeft.get(lineOf.get(o)) : edge === 'right' ? maxX - lineRight.get(lineOf.get(o)) : 0,
        dy: edge === 'top' ? minY - o.bbox.y : edge === 'bottom' ? maxY - (o.bbox.y + o.bbox.h) : 0
      })
      const items = objs
        .map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y, ...dOf(o) }))
        .filter((it) => Math.abs(it.dx) > 0.01 || Math.abs(it.dy) > 0.01)
      if (items.length) {
        await engineRef.current.moveObjects(selected.page, items)
        await refreshPage(selected.page)
        const shifted = objs.map((o) => { const { dx, dy } = dOf(o); return shiftObj(o, dx, dy) })
        onSelect(selected.page, shifted)
      }
    } catch (err) { console.error('[pdf] align failed:', err) } finally { busyRef.current = false }
  }

  // distribute the selected objects into rows at an EQUAL vertical step — the step is the gap
  // between the first two (by current top): row i lands at firstTop + i * step (x untouched)
  const distributeRows = async () => {
    if (!selected || selected.objs.length < 3 || busyRef.current) return
    busyRef.current = true
    try {
      const objs = [...selected.objs].sort((a, b) => a.bbox.y - b.bbox.y)
      const step = objs[1].bbox.y - objs[0].bbox.y // the gap between the first and second
      const targetY = (i) => objs[0].bbox.y + i * step
      const dyOf = new Map(objs.map((o, i) => [o, targetY(i) - o.bbox.y]))
      const items = objs
        .map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y, dx: 0, dy: dyOf.get(o) }))
        .filter((it) => Math.abs(it.dy) > 0.01)
      if (items.length) {
        await engineRef.current.moveObjects(selected.page, items)
        await refreshPage(selected.page)
        const shifted = selected.objs.map((o) => shiftObj(o, 0, dyOf.get(o) || 0))
        onSelect(selected.page, shifted)
      }
    } catch (err) { console.error('[pdf] distribute failed:', err) } finally { busyRef.current = false }
  }

  // resize an image/vector to a new bbox (from the selection frame's handles)
  const resizeSelected = async (pageIndex, obj, nb) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      await engineRef.current.resizeObject(pageIndex, { type: obj.type, bbox: obj.bbox }, nb)
      await refreshPage(pageIndex)
      onSelect(pageIndex, [{ ...obj, bbox: nb }]) // keep it selected at its new size
    } catch (err) { console.error('[pdf] resize failed:', err) } finally { busyRef.current = false }
  }

  // resize of a ROTATED object: the worker scales along the object's own axes around the fixed
  // anchor corner; re-select via before/after diff (the quad box changes shape)
  const resizeRotSelected = async (pageIndex, obj, spec) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const pg = model.find((p) => p.pageIndex === pageIndex)
      const before = new Set(allOf(pg).map(sigOf))
      await engineRef.current.resizeObject(pageIndex, { type: obj.type, bbox: obj.bbox }, null, spec)
      const m = await refreshPage(pageIndex)
      const changed = allOf(m).filter((o) => !before.has(sigOf(o)))
      onSelect(pageIndex, changed.length ? changed : [])
    } catch (err) { console.error('[pdf] rotated resize failed:', err) } finally { busyRef.current = false }
  }

  // ---- insert text: rich-editor content → styled runs → written into the PDF stream ----
  const startTextEdit = (pageIndex, x, y) => {
    setInsertMode(false)
    onSelect(pageIndex, null)
    setTextEdit({ page: pageIndex, x, y })
  }

  // the page's background colour around a rect — sampled from the rendered raster (perimeter
  // points, most frequent quantized colour). Covers the original text while it's being edited.
  const sampleBg = async (pageIndex, rect) => {
    try {
      const im = imgOf(pageIndex)
      const pg = model.find((p) => p.pageIndex === pageIndex)
      if (!im || !pg) return '#ffffff'
      const img = new Image()
      img.src = im.url
      await img.decode()
      const k = img.width / (pg.width || img.width) // raster px per pt
      const c = document.createElement('canvas')
      c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const pts = []
      for (let i = 0; i <= 4; i++) {
        pts.push([rect.x + (rect.w * i) / 4, rect.y - 2], [rect.x + (rect.w * i) / 4, rect.y + rect.h + 2])
      }
      pts.push([rect.x - 2, rect.y + rect.h / 2], [rect.x + rect.w + 2, rect.y + rect.h / 2])
      const votes = new Map()
      for (const [px2, py2] of pts) {
        const X = Math.round(px2 * k), Y = Math.round(py2 * k)
        if (X < 0 || Y < 0 || X >= c.width || Y >= c.height) continue
        const d = ctx.getImageData(X, Y, 1, 1).data
        const key = `${d[0] >> 3},${d[1] >> 3},${d[2] >> 3}` // quantize /8 — antialiasing noise collapses
        const v = votes.get(key) || { n: 0, rgb: [d[0], d[1], d[2]] }
        v.n++
        votes.set(key, v)
      }
      let best = null
      for (const v of votes.values()) if (!best || v.n > best.n) best = v
      return best ? `rgb(${best.rgb[0]},${best.rgb[1]},${best.rgb[2]})` : '#ffffff'
    } catch { return '#ffffff' }
  }

  // ---- EDIT existing text: double-click opens the SAME rich editor pre-filled with the block's
  // text in its original fonts/sizes/colours; commit atomically replaces the stream text (the
  // originals are blanked by their own anchors — Escape cancels without touching anything) ----
  const startEditSelected = async (pageIndex, objs) => {
    if (busyRef.current || textEdit) return
    const texts = (objs || []).filter((o) => o.type === 'text')
    if (!texts.length) return
    const pg = model.find((p) => p.pageIndex === pageIndex)
    if (!pg) return
    // TWO-PHASE ordering: cluster into visual lines first (y-sweep with a size-adaptive tolerance),
    // then sort each line's pieces by x. The old single comparator (same-line→x, else→y) is NOT
    // transitive when baselines drift a little — Array.sort shuffled mixed-font pieces randomly.
    const byY = [...texts].sort((a, b) => a.y - b.y || a.x - b.x)
    const lineTol = Math.max(3, (byY[0]?.size || 12) * 0.45)
    const lines = []
    for (const o of byY) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(o.y - last[0].y) < lineTol) last.push(o)
      else lines.push([o])
    }
    for (const l of lines) l.sort((a, b) => a.x - b.x)
    const sorted = lines.flat()
    const master = sorted[0]
    // ROTATED text: we edit it as if HORIZONTAL (the overlay can't be CSS-rotated — the DOM rect
    // measurements the commit needs would be wrong). While editing, the rotated original hides under
    // the cover and the editor sits UNrotated at the baseline anchor (pivot); on commit we re-rotate
    // the inserted text back by the same angle around that pivot. hPos() un-rotates a piece's anchor
    // onto the horizontal baseline so multi-piece lines keep their spacing.
    const rot = master.rot || 0
    const pivot = { x: master.x, y: master.y }
    const rad = (-rot) * Math.PI / 180 // screen angle
    const ux = Math.cos(rad), uy = Math.sin(rad)
    const hPos = (o) => rot ? { x: pivot.x + (o.x - pivot.x) * ux + (o.y - pivot.y) * uy, y: pivot.y } : { x: o.x, y: o.y }
    const mf = pg.fonts?.[master.f] || {}
    // the toolbar mirrors the edited block's master style — INCLUDING LS: a sticky toolbar value
    // from an earlier selection used to leak into the container and re-space the whole block
    setFontSel(displayFontName(mf.name || 'Arial')); setFontSize(master.size || 12); setColorSel(pg.colors?.[master.c] || '#000000')
    setBoldSel(!!mf.bold); setItalicSel(!!mf.italic); setLetterS(master.ls || 0); setTextOpacity(master.opacity ?? 100)
    if (lines.length > 1) setLineH(+(((lines[1][0].y - lines[0][0].y) / (master.size || 10))).toFixed(2))
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // every piece carries data-rid through the session — the commit DIFFS by it and leaves
    // untouched runs alone in the stream (no rewrite → no font/position churn at all)
    const origPieces = []
    const html = lines.map((l) => '<p>' + l.map((o, i) => {
      const f = pg.fonts?.[o.f] || {}
      const color = (pg.colors?.[o.c] || '#000000').toLowerCase()
      let raw = String(o.text || '')
      // a space only for REAL column gaps (> 0.75em): the sub-em gaps between pieces of one word
      // (leftovers of a mixed-font split) must join seamlessly — the injected space "came back"
      // every time the user deleted it
      if (i > 0) { const prev = l[i - 1]; if (o.bbox.x - (prev.bbox.x + prev.bbox.w) > (o.size || 10) * 0.75) raw = ' ' + raw }
      const rid = origPieces.length
      origPieces.push({
        text: raw,
        fontName: f.name || 'Arial',
        size: o.size || 12,
        color,
        bold: !!f.bold,
        italic: !!f.italic,
        ls: o.ls || 0,
        x: hPos(o).x, // horizontal position for the (un-rotated) editor overlay
        baseline: hPos(o).y,
        item: { type: 'text', bbox: o.bbox, x: o.x, y: o.y } // the ORIGINAL (rotated) stream anchor for a targeted blank
      })
      let t = esc(raw)
      if (f.bold) t = `<strong>${t}</strong>`
      if (f.italic) t = `<em>${t}</em>`
      // cssFontFor returns double-QUOTED families — inside a double-quoted style attribute they
      // terminated it, the browser dropped the whole style and every span lost its font/size/colour.
      // font-weight/style are EXPLICIT per span: the container carries the master's bold, and a
      // regular piece (fallback digits) inherited it — looked bold in the editor, thin in the PDF
      const fam = cssFontFor(f.name || 'Arial').replace(/"/g, '&quot;')
      return `<span data-rid="${rid}" style="font-family: ${fam}; font-size: ${(o.size || 12) * scale}px; color: ${color}; font-weight: ${f.bold ? 700 : 400}; font-style: ${f.italic ? 'italic' : 'normal'}; letter-spacing: ${((o.ls || 0) * scale).toFixed(3)}px">${t}</span>`
    }).join('') + '</p>').join('')
    // one SWEEP item per visual line: a real edit rewrites its lines WHOLE, and the sweep blanks
    // every show on the baseline inside the line's extent — leftovers of any era (legacy Tj-flow
    // pieces with clustered anchors) cannot survive and duplicate
    const lineSweeps = lines.map((l) => {
      const x0 = Math.min(...l.map((o) => o.bbox.x))
      const x1 = Math.max(...l.map((o) => o.bbox.x + o.bbox.w))
      const y0 = Math.min(...l.map((o) => o.bbox.y))
      const y1 = Math.max(...l.map((o) => o.bbox.y + o.bbox.h))
      return { type: 'text', sweep: true, bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, x: l[0].x, y: l[0].y }
    })
    const minX = Math.min(...sorted.map((o) => o.bbox.x))
    // the ORIGINAL text hides under a page-background cover while it's being edited — otherwise it
    // shines through behind the editor as a double; commit/cancel removes the cover automatically
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const o of sorted) { x0 = Math.min(x0, o.bbox.x); y0 = Math.min(y0, o.bbox.y); x1 = Math.max(x1, o.bbox.x + o.bbox.w); y1 = Math.max(y1, o.bbox.y + o.bbox.h) }
    const coverRect = { x: x0 - 1.5, y: y0 - 1.5, w: x1 - x0 + 3, h: y1 - y0 + 3 }
    const coverColor = await sampleBg(pageIndex, coverRect)
    onSelect(pageIndex, null)
    setInsertMode(false)
    setTextEdit({
      page: pageIndex, x: rot ? pivot.x : minX, y: (rot ? pivot.y : master.y) - 0.8 * (master.size || 12), // rough spot; the editor self-aligns to the baseline
      initialHTML: html, anchorLeft: rot ? pivot.x : minX, anchorBaseline: rot ? pivot.y : master.y, origPieces, lineSweeps,
      cover: { ...coverRect, color: coverColor },
      replaceItems: texts.map((o) => ({ type: 'text', bbox: o.bbox, x: o.x, y: o.y })),
      rot, pivot // rotated text: re-rotate the committed result back by this angle around the pivot
    })
  }

  // ---- insert image: pick a PNG/JPEG/SVG, then click the page where it goes ----
  // PDF has no native SVG — an SVG is rasterised to PNG at 3x for headroom before embedding
  const svgToPng = (svgBytes) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svgBytes], { type: 'image/svg+xml' }))
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth || 300, h = img.naturalHeight || 300
      const c = document.createElement('canvas')
      c.width = Math.round(w * 3); c.height = Math.round(h * 3)
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      c.toBlob((b) => (b ? b.arrayBuffer().then(resolve) : reject(new Error('svg rasterise failed'))), 'image/png')
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('svg load failed')) }
    img.src = url
  })
  const pickImageFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/svg+xml,.svg'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      try {
        let bytes = await f.arrayBuffer()
        if (/svg/i.test(f.type) || /\.svg$/i.test(f.name)) bytes = await svgToPng(bytes)
        const bmp = await createImageBitmap(new Blob([bytes]))
        const px = /svg/i.test(f.type) || /\.svg$/i.test(f.name) ? 3 : 1 // undo the 3x headroom for the on-page size
        const scale = Math.min(1 / px, 300 / bmp.width, 300 / bmp.height) // sane default size, keeps ratio
        const w = +(bmp.width * scale).toFixed(2), h = +(bmp.height * scale).toFixed(2)
        bmp.close?.()
        setInsertMode({ image: { bytes, w, h } })
      } catch (err) { console.error('[pdf] image pick failed:', err) }
    }
    input.click()
  }
  const placeImage = async (pageIndex, x, y, img) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const before = new Set(allOf(model.find((p) => p.pageIndex === pageIndex) || { runs: [] }).map(sigOf))
      await engineRef.current.insertImage(pageIndex, img.bytes, x, y, img.w, img.h)
      const m = await refreshPage(pageIndex)
      onSelect(pageIndex, allOf(m).filter((o) => !before.has(sigOf(o)))) // the placed image comes out selected
    } catch (err) { console.error('[pdf] insert image failed:', err) } finally { busyRef.current = false }
  }
  // ---- insert shape: pick a kind, then click (default size) or drag (custom size) on the page ----
  const placeShape = async (pageIndex, kind, geo) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const before = new Set(allOf(model.find((p) => p.pageIndex === pageIndex) || { runs: [] }).map(sigOf))
      await engineRef.current.insertShape(pageIndex, kind.kind || kind, geo, { color: colorSel, strokeW, radius: cornerR, dash: dashSel, head: kind.head })
      const m = await refreshPage(pageIndex)
      onSelect(pageIndex, allOf(m).filter((o) => !before.has(sigOf(o))))
    } catch (err) { console.error('[pdf] insert shape failed:', err) } finally { busyRef.current = false }
  }

  // one entry point for every armed insert mode; `drag` carries the drawn rectangle for shapes
  const startInsertAt = (pageIndex, x, y, drag) => {
    const mode = insertMode
    setInsertMode(false)
    if (mode === 'text') startTextEdit(pageIndex, x, y)
    else if (mode?.image) placeImage(pageIndex, x, y, mode.image)
    else if (mode?.shape) {
      const kind = mode.shape.kind
      let geo
      if (drag && (Math.abs(drag.x2 - drag.x1) > 3 || Math.abs(drag.y2 - drag.y1) > 3)) {
        geo = {
          x: Math.min(drag.x1, drag.x2), y: Math.min(drag.y1, drag.y2),
          w: Math.max(2, Math.abs(drag.x2 - drag.x1)), h: Math.max(2, Math.abs(drag.y2 - drag.y1)),
          x1: drag.x1, y1: drag.y1, x2: drag.x2, y2: drag.y2
        }
      } else {
        // sensible click-defaults: marks are small (16pt), an arrow 60pt, boxes 120x80, a line 120
        const dw = kind === 'check' || kind === 'cross' ? 16 : kind === 'arrow' ? 60 : 120
        const dh = kind === 'line' || kind === 'arrow' ? 0 : kind === 'check' || kind === 'cross' ? 16 : 80
        geo = { x, y, w: dw, h: dh, x1: x, y1: y, x2: x + dw, y2: y + dh }
      }
      // lines and arrows are FREE-ANGLE: drawn exactly from the press point to the release point
      // (the old axis snap forced every line to 0° or 90°)
      placeShape(pageIndex, mode.shape, geo)
    }
  }
  const commitText = async (lines) => {
    const te = textEdit
    if (!te || busyRef.current) return
    // EDIT mode, nothing changed → close WITHOUT touching the stream: a no-op rewrite re-resolved
    // fonts every time (Nimbus→Arial→…) and the text "randomly" drifted between edit sessions
    // EDIT diff by rid: pieces whose text/style/position are untouched are NOT rewritten at all —
    // the stream keeps their original bytes (no font churn, no reflow). Only changed/new pieces
    // are replaced, deleted pieces are blanked.
    let replaceItems = te?.replaceItems || null
    if (te?.origPieces) {
      const groups = new Map() // rid → { text, first }
      for (const l of lines) for (const s of l) {
        if (s.rid == null) continue
        const g = groups.get(s.rid)
        if (g) { g.text += s.text; g.styles.add(`${s.fontName}|${s.size}|${String(s.color).toLowerCase()}|${s.bold ? 1 : 0}${s.italic ? 1 : 0}`) }
        else groups.set(s.rid, { text: s.text, first: s, styles: new Set([`${s.fontName}|${s.size}|${String(s.color).toLowerCase()}|${s.bold ? 1 : 0}${s.italic ? 1 : 0}`]) })
      }
      const untouched = new Set()
      te.origPieces.forEach((op, rid) => {
        const g = groups.get(String(rid))
        if (!g) return // piece deleted → must be blanked
        const style = `${op.fontName}|${op.size}|${op.color}|${op.bold ? 1 : 0}${op.italic ? 1 : 0}`
        if (g.text === op.text && g.styles.size === 1 && g.styles.has(style) &&
            Math.abs((g.first.ls || 0) - (op.ls || 0)) < 0.05 &&
            Math.abs(g.first.x - op.x) < 0.35 && Math.abs(g.first.baseline - op.baseline) < 0.35) untouched.add(String(rid))
      })
      const newPieces = lines.reduce((a, l) => a + l.filter((s) => s.rid == null).length, 0)
      if (untouched.size === te.origPieces.length && !newPieces) {
        console.log('[pdf][edit] no changes — stream untouched')
        setTextEdit(null)
        return
      }
      // ANY real change → rewrite the block WHOLE with a per-line sweep: mixing surviving old
      // coordinates with re-flowed new ones (and legacy anchor misses) bred duplicates like
      // "Due:0lance Due:" — a full sweep+rewrite is the only layout that is always self-consistent
      replaceItems = [...(te.lineSweeps || []), ...te.origPieces.map((op) => op.item)]
      console.log(`[pdf][edit] diff: ${untouched.size}/${te.origPieces.length} untouched, ${newPieces} new → rewriting the block whole (${te.lineSweeps?.length || 0} line sweep(s))`)
    }
    busyRef.current = true
    try {
      // one embedded font per unique family+style used in the text (document fonts keep their own bytes)
      const keyOf = (s) => `${s.fontName}|${s.bold ? 'b' : ''}${s.italic ? 'i' : ''}`
      const fonts = {}
      console.log('[pdf][insert-text] parsed lines:', JSON.stringify(lines))
      for (const l of lines) for (const s of l) {
        const k = keyOf(s)
        if (fonts[k]) continue
        // INSERT: brand-new text → full system faces only (a subset can't be trusted for arbitrary
        // chars). EDIT: keep the DOCUMENT'S OWN font (NimbusSans stays NimbusSans — same glyphs,
        // same heights); the worker still validates encodability and falls back per-run if a newly
        // typed character isn't in the subset.
        // a DOCUMENT face carries its weight in the NAME: "NimbusSans-Regular" is regular even if the
        // span is styled bold — resolve it as regular so {pdf} uses the EMBEDDED bytes (asking bold
        // missed {pdf} and reported an embedded font as "недоступен")
        const pd = docFonts.find((d) => d.name === s.fontName)
        const b = pd ? /bold|black|heavy/i.test(s.fontName) : s.bold
        const it = pd ? /italic|oblique/i.test(s.fontName) : s.italic
        const src = await fontSourceFor(s.fontName, b, it, !te.replaceItems)
        if (src) fonts[k] = src
        else { setEditErr(`Шрифт «${s.fontName}» недоступен для встраивания — выберите другой.`); return } // no substitution: stop (finally resets busy), keep the editor open
      }
      console.log('[pdf][insert-text] fonts:', Object.keys(fonts).map((k) => `${k}${fonts[k].pdf ? ' (pdf)' : ' (file)'}`).join(', ') || 'NONE')
      // every run carries its EXACT page coordinates measured from the editor's real DOM rects
      const spec = { lines: lines.map((l) => l.map((s) => ({ text: s.text, size: s.size, color: s.color, fontKey: keyOf(s), x: s.x, baseline: s.baseline, ls: s.ls }))) }
      const before = new Set(allOf(model.find((p) => p.pageIndex === te.page) || { runs: [] }).map(sigOf))
      // EDIT mode: atomically blank the original runs (their own anchors) and insert the edited text
      if (replaceItems) {
        if (replaceItems.length) await engineRef.current.replaceText(te.page, replaceItems, spec, fonts, await getFallbacksFor(fonts), true)
        else await engineRef.current.insertText(te.page, spec, fonts, await getFallbacksFor(fonts)) // only NEW pieces — nothing to blank
      } else await engineRef.current.insertText(te.page, spec, fonts, await getFallbacksFor(fonts))
      // the editor (and the cover hiding the ORIGINAL text) stays up until the refreshed page
      // image lands — closing earlier flashed the OLD text before it jumped to the new one
      let m = await refreshPage(te.page)
      // ROTATED text: the edited text went in HORIZONTAL — turn the fresh pieces back to the original
      // angle around the pivot (same trick as the restyle re-rotate). Its own snapshot = a 2nd undo
      // step, acceptable.
      if (te.rot) {
        const items = allOf(m).filter((o) => o.type === 'text' && !o.rot && !before.has(sigOf(o))).map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y }))
        if (items.length) { await engineRef.current.rotateObjects(te.page, items, -te.rot, te.pivot.x, te.pivot.y); m = await refreshPage(te.page) }
      }
      setTextEdit(null) // close ONLY after a successful insert — a font failure keeps the editor (and the text) alive
      const added = allOf(m).filter((o) => !before.has(sigOf(o)))
      // the insertion is ONE text block now — select it WHOLE (every bN.lK line), same as a
      // block-mode click would
      const blocks = new Set(added.filter((o) => o.type === 'text').map((o) => String(o.id).split('.')[0]))
      const grouped = allOf(m).filter((o) => (o.type === 'text' && blocks.has(String(o.id).split('.')[0])) || added.includes(o))
      console.log(`[pdf][insert-text] page ${te.page}, ${lines.length} line(s) → ${added.length} new, ${grouped.length} in block(s)`)
      setFontsNonce((n) => n + 1) // freshly embedded EF faces get their FontFaces for the next edit
      setEditErr(null)
      onSelect(te.page, grouped.length ? grouped : added) // the inserted block comes out selected whole
    } catch (err) {
      // a font that can't render the text → keep the editor open and TELL the user which font/chars,
      // so they switch to a supported one (incapable fonts are already disabled in the dropdown)
      const msg = String(err?.message || '')
      const mMiss = msg.match(/FONT_MISS\|([^|]+)\|(.+)/)
      const mBad = msg.match(/FONT_UNUSABLE\|(.+)/)
      if (mMiss) setEditErr(`Шрифт «${mMiss[1]}» не содержит символы: ${mMiss[2]} — выберите шрифт с ними в списке.`)
      else if (mBad) setEditErr(`Шрифт «${mBad[1]}» не загрузился — выберите другой.`)
      else setEditErr('Не удалось сохранить текст — см. консоль.')
      console.error('[pdf] insert text failed (editor kept open):', err)
    } finally { busyRef.current = false }
  }

  // ================= AI control surface =================
  // The assistant drives the OPEN document through two ui() calls: 'pdfAiInfo' returns the full
  // model as text (every text piece with id/font/position grouped into VISUAL LINES — PDF stores
  // one line as several adjacent fragments) plus the complete action manual; 'pdfAiAct' executes
  // one action. Only the ACTIVE tab answers (registration below is gated on `active`).
  const buildAiInfo = () => {
    const name = (path || '').split(/[\\/]/).pop() || 'document.pdf'
    const pages = modelRef.current
    if (!pages.length) return null
    const c1 = (v) => Math.round(v * 10) / 10
    const out = []
    out.push(`PDF OPEN: "${name}" — ${pages.length} page(s). You have FULL edit control via the PDF actions below.`)
    out.push('HOW PDF TEXT WORKS: a visual line is stored as SEVERAL adjacent text FRAGMENTS ("pieces"). Below, pieces are grouped into their visual LINE — the quoted line text is the pieces joined in reading order. A piece id looks like "b12.l3". One word may span pieces and one piece may hold several words. Coordinates are pt, origin at the page TOP-LEFT; "base" is the text baseline y. To rewrite a whole visual line, act on ALL its pieces (or pdfDelete them and pdfInsert one clean replacement).')
    out.push(`DOCUMENT FONTS: ${docFonts.map((f) => f.name).join(', ') || '(none — blank page; use any installed family, e.g. Arial, Times New Roman, Courier New)'}. Any installed Windows family or exact Google Fonts name also works — an unusable font returns a clear error, then pick another.`)
    const vars = variablesRef.current
    out.push(vars.length ? `VARIABLES: ${vars.map((v) => `"${v.name}" = "${v.value}" (${v.occurrences.length} place(s))`).join('; ')}` : 'VARIABLES: none yet.')
    // ---- SLM: the spatial overview (region tree). Detailed pt-accurate lines follow below. ----
    out.push('SPATIAL MAP (SLM) — the page as a NESTING TREE of regions cut by whitespace; region boxes are [x,y,w,h] on a 0..1000 grid (origin top-left); "columns"=split left/right, "stacked"=split top/bottom. Each element also shows "%[L R T B]" = its left/right/top/bottom edges as PERCENT of the page ("R93" = right edge 93% across, "T12" = top 12% down) — read position/extent from this. Each PAGE lists its COLUMNS and ROWS (the real alignment lines several objects share, with x/y in pt and %) and flags any element that is MISALIGNED (a few pt off a column) — snap objects to these lines (pdfAlign / place at that x). "z<n>" = PAINT ORDER: higher z is ON TOP; a background needs LOWER z than the text over it (a fill covering text → pdfReorder back). Each PAGE is also split into a VIRTUAL GRID (a spreadsheet of rows×cols along the whitespace gutters) and every element is tagged "@R<row>C<col>" with the cell it sits in (a range like R3C5-6 = it spans those cells). Reason about position with the grid: SAME column + next row = directly BELOW; same row + next column = BESIDE. Use SLM for LAYOUT + alignment; the pt-accurate line list below is for exact edits.')
    for (const pg of pages) {
      const W = pg.width || 1, H = pg.height || 1
      const g = (v, D) => Math.round((v / D) * 1000)
      const nb = (b) => `${g(b[0], W)},${g(b[1], H)},${g(b[2], W)},${g(b[3], H)}`
      const els = []
      for (const r of pg.runs) { const f = pg.fonts?.[r.f] || {}; els.push({ id: r.id, t: 'T', z: r.z, x: r.bbox.x, y: r.bbox.y, w: r.bbox.w, h: r.bbox.h, text: r.text, font: f.name, size: r.size, bold: f.bold, italic: f.italic, color: pg.colors?.[r.c] }) }
      for (const v of pg.vectors || []) els.push({ id: v.id, t: v.kind || 'shape', z: v.z, x: v.bbox.x, y: v.bbox.y, w: v.bbox.w, h: v.bbox.h, fill: v.fc !== undefined ? pg.colors?.[v.fc] : null, stroke: pg.colors?.[v.c], sw: v.strokeW })
      for (const im of pg.images || []) els.push({ id: im.id, t: 'IMG', z: im.z, x: im.bbox.x, y: im.bbox.y, w: im.bbox.w, h: im.bbox.h })
      out.push(`  PAGE ${pg.pageIndex} [0,0,1000,${g(H, W)}] (${Math.round(W)}x${Math.round(H)}pt):`)
      if (!els.length) { out.push('    (empty page)'); continue }
      // MARGINS + content box: where the real content sits, and the safe area. Text put outside the
      // right/left margins looks broken (nearly off-page). The right margin edge is the x to
      // RIGHT-ALIGN amounts to; the left margin is where left-aligned labels start.
      const cx0 = Math.min(...els.map((e) => e.x)), cx1 = Math.max(...els.map((e) => e.x + e.w))
      const cy0 = Math.min(...els.map((e) => e.y)), cy1 = Math.max(...els.map((e) => e.y + e.h))
      const rr = (v) => Math.round(v)
      out.push(`  MARGINS (pt): left=${rr(cx0)}, right=${rr(W - cx1)}, top=${rr(cy0)}, bottom=${rr(H - cy1)} | content box x ${rr(cx0)}..${rr(cx1)}, y ${rr(cy0)}..${rr(cy1)} of ${rr(W)}x${rr(H)}. Keep new content INSIDE these margins; RIGHT-ALIGN amounts to x≈${rr(cx1)} (right edge − text width), LEFT-ALIGN labels to x≈${rr(cx0)}.`)
      const nearEdge = els.filter((e) => e.x < 12 || (e.x + e.w) > W - 12 || e.y < 12 || (e.y + e.h) > H - 12)
        .slice(0, 8).map((e) => `${e.id}${e.text ? ` "${e.text}"` : ''}`)
      if (nearEdge.length) out.push(`  ⚠ TOO CLOSE TO PAGE EDGE (<12pt, may look cut off): ${nearEdge.join(', ')} — move them inside the margins.`)
      // GRID: the document's real alignment lines (columns = shared vertical edges, rows = shared
      // tops) + which elements are SHIFTED off them. Snap objects to these to keep the layout tidy.
      const grid = slmGrid(els, W, H)
      if (grid.cols.length) out.push(`  COLUMNS (vertical alignment lines; snap left/right edges to these): ${grid.cols.map((c) => `${c.id} ${c.kind}@x=${grid.r1(c.at)}(${c.pct}%)×${c.n}`).join(' | ')}`)
      if (grid.rows.length) out.push(`  ROWS (horizontal alignment lines; tops): ${grid.rows.map((r) => `${r.id} y=${grid.r1(r.at)}(${r.pct}%)×${r.n}`).join(' | ')}`)
      if (grid.shifts.length) out.push(`  ⚠ MISALIGNED (near a column but not on it — nudge to fix): ${grid.shifts.join('; ')}`)
      // VIRTUAL GRID: split the whole page into a spreadsheet grid, then tag each element with the
      // cell(s) it occupies. "under X" = same column, next row; "beside X" = same row, next column.
      const table = slmTable(els, W, H)
      if (table) out.push(`  GRID (virtual spreadsheet of the page, ${table.rows} rows × ${table.cols} cols; each element below is tagged @R<row>C<col>, a range like R3C5-6 = spans those cells): column x-lines (pt) ${table.colB.map((v) => Math.round(v)).join(',')} · row y-lines (pt) ${table.rowB.map((v) => Math.round(v)).join(',')}`)
      const cellTag = (e) => {
        if (!table) return ''
        const { rs, re, cs, ce } = table.cellOf(e)
        return ` @R${rs === re ? rs : `${rs}-${re}`}C${cs === ce ? cs : `${cs}-${ce}`}`
      }
      // percentage box for each element — L/R (horizontal) and T/B (vertical) as % of the page, so
      // the model reads position/extent intuitively ("right edge at 93%, width 15%")
      const pctBox = (e) => `%[L${(e.x / W * 100).toFixed(1)} R${((e.x + e.w) / W * 100).toFixed(1)} T${(e.y / H * 100).toFixed(1)} B${((e.y + e.h) / H * 100).toFixed(1)}]`
      const elLine = (e) => e.t === 'T'
        ? `${e.id} T "${e.text}" [${nb([e.x, e.y, e.w, e.h])}] ${pctBox(e)}${cellTag(e)} z${e.z ?? '?'} p${pg.pageIndex} ${e.font || '?'} ${e.size ?? '?'}pt${e.bold ? ' bold' : ''}${e.italic ? ' italic' : ''} ${e.color || '#000'}`
        : `${e.id} ${e.t} [${nb([e.x, e.y, e.w, e.h])}] ${pctBox(e)}${cellTag(e)} z${e.z ?? '?'} p${pg.pageIndex}${e.t === 'IMG' ? '' : ` fill=${e.fill || 'none'} border=${e.stroke || 'none'}${e.sw ? ` ${c1(e.sw)}pt` : ''}`}`
      const walk = (node, d) => {
        const pad = '    ' + '  '.repeat(d)
        if (node.els) {
          out.push(`${pad}${node.id} [${nb(node.box)}] — ${node.els.length} el:`)
          for (const e of node.els.sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))) out.push(`${pad}  ${elLine(e)}`)
        } else {
          out.push(`${pad}${node.id} [${nb(node.box)}] ${node.dir}:`)
          for (const c of node.children) walk(c, d + 1)
        }
      }
      for (const node of slmSplit(els, W, H, 'R', 0)) walk(node, 0)
    }
    for (const pg of pages) {
      out.push(`PAGE ${pg.pageIndex} — ${Math.round(pg.width)}x${Math.round(pg.height)}pt. Text pieces by visual line ("base"=baseline y; "Δ"=vertical step in pt from the previous line's baseline = the LINE SPACING; a consistent Δ means even spacing — match it when inserting a line between others):`)
      const lines = new Map()
      for (const r of pg.runs) { const key = Math.round(r.y / 2); if (!lines.has(key)) lines.set(key, []); lines.get(key).push(r) }
      const keys = [...lines.keys()].sort((a, b) => a - b)
      let n = 0, prevBase = null
      for (const k of keys) {
        const rs = lines.get(k).sort((a, b) => a.x - b.x)
        // the pieces of one visual line, with the exact GAP between neighbours — this is how the
        // model tells "glued fragments of ONE text" (gap ≈ 0) from "separate fields/columns"
        const pieces = rs
          .map((r, i) => {
            const f = pg.fonts?.[r.f] || {}
            const gap = i > 0 ? ` <gap ${c1(r.bbox.x - (rs[i - 1].bbox.x + rs[i - 1].bbox.w))}pt> ` : ''
            return `${gap}${r.id} "${r.text}" [${c1(r.bbox.x)}..${c1(r.bbox.x + r.bbox.w)}] ${f.name || '?'} ${r.size ?? '?'}pt${f.bold ? ' bold' : ''}${f.italic ? ' italic' : ''} ${pg.colors?.[r.c] || '#000'}${r.ls ? ` ls=${c1(r.ls)}` : ''}`
          })
          .join('')
        const base = rs[0].y
        const dStep = prevBase !== null ? ` Δ${c1(base - prevBase)}` : ''
        prevBase = base
        out.push(`  base=${c1(base)}${dStep} "${joinRuns(rs)}" → ${pieces}`)
        if (++n >= 400) { out.push(`  … (${keys.length - n} more lines omitted)`); break }
      }
      const vecs = (pg.vectors || []).slice(0, 80).map((v) => `${v.id} ${v.kind || 'path'} @(${c1(v.bbox.x)},${c1(v.bbox.y)}) ${c1(v.bbox.w)}x${c1(v.bbox.h)}`).join('; ')
      if (vecs) out.push(`  graphics: ${vecs}`)
      const ims = (pg.images || []).map((im) => `${im.id} image @(${c1(im.bbox.x)},${c1(im.bbox.y)}) ${c1(im.bbox.w)}x${c1(im.bbox.h)}`).join('; ')
      if (ims) out.push(`  images: ${ims}`)
      // ---- the "visual snapshot as data" aids: alignment columns, overlaps, near-duplicates ----
      const rr = pg.runs
      // alignment map: left/right edges shared by 3+ pieces = the document's columns — tells the
      // model what "lined up" means here and whether an edit broke a column
      const cols = (edge) => {
        const groups = new Map()
        for (const r of rr) { const k = Math.round(edge(r) / 2) * 2; groups.set(k, (groups.get(k) || 0) + 1) }
        return [...groups.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([x, n]) => `x≈${x}(${n})`).join(', ')
      }
      const colL = cols((r) => r.bbox.x)
      const colR = cols((r) => r.bbox.x + r.bbox.w)
      if (colL || colR) out.push(`  alignment columns — left-aligned: ${colL || '(none)'}; right-aligned: ${colR || '(none)'}`)
      // self-check aid: flag TEXT pieces whose boxes intersect — the model re-reads pdfInfo after
      // building and fixes what this section flags (move/delete), then re-checks until it's clean
      const laps = []
      for (let i = 0; i < rr.length && laps.length < 40; i++)
        for (let j = i + 1; j < rr.length && laps.length < 40; j++) {
          const A = rr[i].bbox, B = rr[j].bbox
          const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x)
          const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y)
          if (ox > 1 && oy > 1) laps.push(`${rr[i].id} "${rr[i].text}" ⇄ ${rr[j].id} "${rr[j].text}" (${c1(ox)}x${c1(oy)}pt)`)
        }
      out.push(laps.length ? `  ⚠ OVERLAPPING TEXTS (fix with pdfMove/pdfDelete, then re-check): ${laps.join('; ')}` : '  overlaps: none — texts are cleanly placed')
      // near-duplicates: the SAME text sitting almost in the same spot (a leftover after a botched
      // replace — inserted the new value without deleting the old pieces). Even without box overlap.
      const dups = []
      const normT = (s) => String(s || '').replace(/\s+/g, '').toLowerCase()
      for (let i = 0; i < rr.length && dups.length < 20; i++)
        for (let j = i + 1; j < rr.length && dups.length < 20; j++) {
          const a = rr[i], b = rr[j]
          const t = normT(a.text)
          if (t.length < 2 || t !== normT(b.text)) continue
          const em = Math.max(a.size || 10, b.size || 10) * 2
          if (Math.abs(a.bbox.x - b.bbox.x) < em && Math.abs(a.y - b.y) < em) dups.push(`${a.id} & ${b.id} "${a.text}" (Δx=${c1(Math.abs(a.bbox.x - b.bbox.x))}, Δy=${c1(Math.abs(a.y - b.y))})`)
        }
      if (dups.length) out.push(`  ⚠ POSSIBLE DUPLICATES — same text twice almost in one place (delete the stale copy): ${dups.join('; ')}`)
    }
    out.push(AI_PDF_MANUAL)
    return out.join('\n')
  }

  // execute ONE AI action against the open document. Returns { ok } / { ok:false, error } — errors
  // are worded so the model can SELF-CORRECT (stale ids → re-run pdfInfo; bad font → pick another).
  const aiDispatch = async (a) => {
    const page = Number(a.page) || 0
    const pg = modelRef.current.find((p) => p.pageIndex === page)
    if (!pg) return { ok: false, error: `page ${page} is not loaded` }
    const pick = (ids) => {
      const want = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String)
      return allOf(pg).filter((o) => want.includes(String(o.id)))
    }
    const staleErr = 'no object with those ids on that page — ids change after every edit; call {"action":"pdfInfo"} again and use the fresh ids'
    try {
      switch (a.action) {
        case 'pdfEditText': {
          const objs = pick(a.id ?? a.ids).filter((o) => o.type === 'text')
          if (!objs.length) return { ok: false, error: staleErr }
          await restyleRuns(page, [objs[0]], { text: String(a.text ?? '') })
          return { ok: true }
        }
        case 'pdfRestyle': {
          const objs = pick(a.ids ?? a.id).filter((o) => o.type === 'text')
          if (!objs.length) return { ok: false, error: staleErr }
          await restyleRuns(page, objs, { family: a.family, size: a.size ? Number(a.size) : undefined, color: a.color, bold: a.bold, italic: a.italic, ls: a.ls !== undefined ? Number(a.ls) : undefined })
          return { ok: true }
        }
        case 'pdfInsert': {
          const text = String(a.text ?? '')
          if (!text.trim()) return { ok: false, error: 'pdfInsert needs text' }
          const family = a.family || 'Arial'
          const bold = !!a.bold, italic = !!a.italic
          const size = Number(a.size) || 12
          const k = `${family}|${bold ? 'b' : ''}${italic ? 'i' : ''}`
          const src = await fontSourceFor(family, bold, italic, true)
          if (!src) return { ok: false, error: `font "${family}" is not available — use a DOCUMENT FONT from pdfInfo or an installed family (Arial, Times New Roman, …)` }
          const x = Number(a.x) || 50
          const baseline = Number(a.baseline ?? a.y) || 50
          const lh = size * (Number(a.lineHeight) || 1.3)
          const lines = text.split('\n').map((line, i) => [{ text: line, size, color: a.color || '#000000', fontKey: k, x, baseline: baseline + i * lh, ls: Number(a.ls) || 0 }]).filter((l) => l[0].text !== '')
          const fonts = { [k]: src }
          const before = new Set(allOf(pg).map(sigOf))
          await engineRef.current.insertText(page, { lines }, fonts, await getFallbacksFor(fonts))
          const m = await refreshPage(page)
          // report the EXACT landed geometry so the model lays out the next elements with real
          // numbers (right-aligned amounts, no overlaps) instead of width guesses
          const fresh = allOf(m).filter((o) => o.type === 'text' && !before.has(sigOf(o)))
          const landed = fresh.map((o) => `"${o.text}" x=${Math.round(o.bbox.x * 10) / 10} base=${Math.round(o.y * 10) / 10} w=${Math.round(o.bbox.w * 10) / 10} h=${Math.round(o.bbox.h * 10) / 10}`)
          // instant collision report: the new text landing ON an existing piece almost always means
          // a replacement where the OLD pieces were not deleted — tell the model right away
          const freshSet = new Set(fresh)
          const hit = []
          for (const o of fresh)
            for (const r2 of m.runs) {
              if (freshSet.has(r2)) continue
              const ox = Math.min(o.bbox.x + o.bbox.w, r2.bbox.x + r2.bbox.w) - Math.max(o.bbox.x, r2.bbox.x)
              const oy = Math.min(o.bbox.y + o.bbox.h, r2.bbox.y + r2.bbox.h) - Math.max(o.bbox.y, r2.bbox.y)
              if (ox > 1 && oy > 1 && hit.length < 6) hit.push(`${r2.id} "${r2.text}"`)
            }
          const warn = hit.length ? ` ⚠ the new text OVERLAPS existing ${hit.join(', ')} — if this was a replacement you forgot to delete the old pieces: pdfDelete them now` : ''
          return { ok: true, result: { info: (landed.length ? `inserted: ${landed.join('; ')}` : 'inserted') + warn } }
        }
        case 'pdfDelete': {
          const objs = pick(a.ids ?? a.id)
          if (!objs.length) return { ok: false, error: staleErr }
          const deletedTexts = objs.filter((o) => o.type === 'text').map((o) => ({ x: o.x, y: o.y }))
          await engineRef.current.deleteObjects(page, objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })))
          await refreshPage(page)
          // a deleted text drops out of every variable that referenced it (same as the UI delete)
          if (deletedTexts.length)
            setVariables((vs) => vs
              .map((v) => ({ ...v, occurrences: v.occurrences.filter((o) => !(o.page === page && occParts(o).some((p2) => deletedTexts.some((d) => Math.abs(d.x - p2.x) < 1.5 && Math.abs(d.y - p2.baseline) < 1.5)))) }))
              .filter((v) => v.occurrences.length))
          return { ok: true }
        }
        case 'pdfMove': {
          const objs = pick(a.ids ?? a.id)
          if (!objs.length) return { ok: false, error: staleErr }
          await moveSelected(page, objs, Number(a.dx) || 0, Number(a.dy) || 0)
          return { ok: true }
        }
        case 'pdfReorder':
        case 'pdfRestack': {
          const objs = pick(a.ids ?? a.id)
          if (!objs.length) return { ok: false, error: staleErr }
          const mode = ['front', 'back', 'forward', 'backward'].includes(a.mode) ? a.mode : 'back'
          await engineRef.current.restackObjects(page, objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })), mode)
          await refreshPage(page)
          return { ok: true, result: { info: `moved ${objs.length} object(s) ${mode}` } }
        }
        case 'pdfAlign': {
          const objs = pick(a.ids)
          if (objs.length < 2) return { ok: false, error: 'pdfAlign needs 2+ ids' }
          const edge = ['left', 'right', 'top', 'bottom'].includes(a.edge) ? a.edge : 'left'
          const minX = Math.min(...objs.map((o) => o.bbox.x)), minY = Math.min(...objs.map((o) => o.bbox.y))
          const maxX = Math.max(...objs.map((o) => o.bbox.x + o.bbox.w)), maxY = Math.max(...objs.map((o) => o.bbox.y + o.bbox.h))
          const items = objs.map((o) => ({
            type: o.type, bbox: o.bbox, x: o.x, y: o.y,
            dx: edge === 'left' ? minX - o.bbox.x : edge === 'right' ? maxX - (o.bbox.x + o.bbox.w) : 0,
            dy: edge === 'top' ? minY - o.bbox.y : edge === 'bottom' ? maxY - (o.bbox.y + o.bbox.h) : 0
          })).filter((it) => Math.abs(it.dx) > 0.01 || Math.abs(it.dy) > 0.01)
          if (items.length) { await engineRef.current.moveObjects(page, items); await refreshPage(page) }
          return { ok: true, result: { info: `aligned ${objs.length} object(s) to ${edge}` } }
        }
        case 'pdfStyleShape': {
          // edit an EXISTING shape/box IN PLACE — background (fill), border (stroke) colour, border
          // width, corner radius, opacity. So the model changes a box instead of drawing a new one
          // over it. ("none" clears a fill/stroke.)
          const objs = pick(a.ids ?? a.id).filter((o) => o.type === 'vector')
          if (!objs.length) return { ok: false, error: 'no shape/box with those ids (vectors only) — check pdfInfo' }
          for (const o of objs) {
            const it = { type: o.type, bbox: o.bbox, x: o.x, y: o.y }
            if (a.fill !== undefined || a.stroke !== undefined || a.color !== undefined)
              await engineRef.current.recolorVector(page, it, { fill: a.fill, stroke: a.stroke ?? a.color })
            if (a.strokeW !== undefined) await engineRef.current.setStrokeWidth(page, it, Number(a.strokeW))
            if (a.radius !== undefined) await engineRef.current.setVectorRadius(page, it, Number(a.radius))
            if (a.opacity !== undefined || a.fillOpacity !== undefined || a.strokeOpacity !== undefined) {
              const ca = Math.max(0, Math.min(1, Number(a.fillOpacity ?? a.opacity ?? 1)))
              const CA = Math.max(0, Math.min(1, Number(a.strokeOpacity ?? a.opacity ?? 1)))
              await engineRef.current.setOpacity(page, it, ca, CA)
            }
          }
          await refreshPage(page)
          return { ok: true, result: { info: `restyled ${objs.length} shape(s)` } }
        }
        case 'pdfShape': {
          const kind = ['rect', 'line', 'ellipse', 'arrow'].includes(a.kind) ? a.kind : 'rect'
          const geo = kind === 'line' || kind === 'arrow'
            ? { x1: Number(a.x1) || 0, y1: Number(a.y1) || 0, x2: Number(a.x2) || 0, y2: Number(a.y2) || 0 }
            : { x: Number(a.x) || 0, y: Number(a.y) || 0, w: Number(a.w) || 10, h: Number(a.h) || 10 }
          await engineRef.current.insertShape(page, kind, geo, { color: a.color || '#000000', strokeW: a.strokeW !== undefined ? Number(a.strokeW) : 1, radius: Number(a.radius) || 0, dash: a.dash || 'solid', head: a.head, fill: a.fill, stroke: a.stroke })
          const m = await refreshPage(page)
          const pgm = (m || []).find((p) => p.pageIndex === page)
          const rr = Math.round
          // report where the shape ACTUALLY landed (the new vector's real bbox, pt top-left) so the
          // model can self-check placement — if this isn't where it meant, it used a wrong coordinate
          // (e.g. a grid/% value instead of pt) and can redo it
          const nv = pgm?.vectors?.[pgm.vectors.length - 1]?.bbox
          const where = nv ? ` — landed at pt [${rr(nv.x)},${rr(nv.y)},${rr(nv.w)},${rr(nv.h)}] (top-left; confirm this is where you intended)` : ''
          // for a FRAME/box (rect/ellipse) also report which texts fall inside it and their padding
          // from each edge — so the model sees if the frame wraps the text cleanly (even paddings) or
          // cuts through it (a negative padding = the frame edge crosses that text)
          if (kind === 'rect' || kind === 'ellipse') {
            const R = geo
            const inside = []
            for (const o of (pgm?.runs || [])) {
              const b = o.bbox
              const ox = Math.min(R.x + R.w, b.x + b.w) - Math.max(R.x, b.x)
              const oy = Math.min(R.y + R.h, b.y + b.h) - Math.max(R.y, b.y)
              if (ox <= 0 || oy <= 0) continue // no overlap with the frame
              const pL = rr(b.x - R.x), pR = rr(R.x + R.w - (b.x + b.w)), pT = rr(b.y - R.y), pB = rr(R.y + R.h - (b.y + b.h))
              const cut = pL < 0 || pR < 0 || pT < 0 || pB < 0
              inside.push(`${o.id} "${o.text}" pad L=${pL} R=${pR} T=${pT} B=${pB}${cut ? ' ⚠CUTS through this text (frame edge crosses it)' : ''}`)
              if (inside.length >= 12) break
            }
            const info = `frame [${rr(R.x)},${rr(R.y)},${rr(R.w)},${rr(R.h)}] drawn${where}. ${inside.length ? `Texts overlapping it (padding from L/R/T/B edges in pt; negative = the frame cuts that text): ${inside.join('; ')}` : 'no text overlaps it (clear area).'}`
            return { ok: true, result: { info } }
          }
          return { ok: true, result: { info: `${kind} drawn${where}.` } }
        }
        case 'createVariable': {
          const value = String(a.value ?? '').trim()
          const nm = String(a.name ?? value).trim() || value
          if (!value) return { ok: false, error: 'createVariable needs value — the exact text as it appears in the document' }
          const chains = findChains(value)
          if (!chains.length) return { ok: false, error: `text "${value}" not found in the document — check pdfInfo (the value must match the visible text)` }
          const occurrences = chains.map((c) => occFromRuns(c.page, c.runs))
          setVariables((vs) => {
            const existing = vs.find((v) => v.name.toLowerCase() === nm.toLowerCase())
            if (existing) {
              const key = (o) => `${o.page}|${Math.round(o.x)}|${Math.round(o.baseline)}`
              const have = new Set(existing.occurrences.map(key))
              return vs.map((v) => (v === existing ? { ...v, occurrences: [...existing.occurrences, ...occurrences.filter((o) => !have.has(key(o)))] } : v))
            }
            const id = crypto.randomUUID?.() || 'v' + Math.random().toString(36).slice(2)
            return [...vs, { id, name: nm, value, occurrences }]
          })
          setVarsCollapsed(false)
          return { ok: true, result: { info: `variable "${nm}" bound to ${occurrences.length} place(s)` } }
        }
        case 'pdfSetVariable': {
          const nm = String(a.name ?? '').trim().toLowerCase()
          const v = variablesRef.current.find((x) => x.name.toLowerCase() === nm)
          if (!v) return { ok: false, error: `no variable "${a.name}" — existing: ${variablesRef.current.map((x) => x.name).join(', ') || '(none)'}` }
          const val = String(a.value ?? '')
          setVariables((vs) => vs.map((x) => (x.id === v.id ? { ...x, value: val } : x)))
          await applyVariable(v.occurrences, val)
          return { ok: true }
        }
        case 'pdfSave': {
          // OVERWRITE GUARD: the user's original file on disk is sacred — an in-place save without
          // their explicit request once silently destroyed a source invoice. Copies the AI itself
          // created this session are fair game.
          if (!a.as && a.overwrite !== true && !AI_CREATED_PATHS.has(path))
            return { ok: false, error: 'refusing to OVERWRITE the user\'s original file. Save a copy instead: pdfSave {"as":"name.pdf"} — or use pdfWorkOnCopy to continue editing on a copy. Only if the USER explicitly asked to overwrite THIS file, retry with {"overwrite":true}.' }
          // bake the variables into the document BEFORE saving (the UI path does it debounced —
          // a save right after createVariable raced it and produced a template with no variables)
          try { await engineRef.current.writeVariables(variablesRef.current.length ? JSON.stringify(variablesRef.current) : '') } catch { /* best effort */ }
          const r = await engineRef.current.save()
          let out = path
          if (a.as) {
            const dir = String(path || '').replace(/[\\/][^\\/]*$/, '')
            // the model may pass a FULL path in "as" — keep only the file name (a full path put
            // through the char-sanitizer became one mangled "C__Users_..." file name)
            let nm = String(a.as).split(/[\\/]/).pop().replace(/[:*?"<>|]/g, '_')
            if (!/\.pdf$/i.test(nm)) nm += '.pdf'
            out = dir ? `${dir}\\${nm}` : nm
          }
          const w = await api.pdf.write(out, new Uint8Array(r.bytes))
          if (!w?.ok) return { ok: false, error: w?.error || 'write failed' }
          if (a.as) AI_CREATED_PATHS.add(out)
          return { ok: true, result: { info: `saved to ${out}` } }
        }
        case 'pdfWorkOnCopy':
        case 'pdfCopy': {
          // serious edits to a user's document happen on a COPY: current in-memory state → a new
          // file next to the original, opened as the active tab — every further action hits the
          // copy, the original file on disk stays untouched
          const r = await engineRef.current.save()
          const dir = String(path || '').replace(/[\\/][^\\/]*$/, '')
          let nm = String(a.as || (path || 'document.pdf').split(/[\\/]/).pop().replace(/\.pdf$/i, '') + '-copy.pdf').split(/[\\/]/).pop().replace(/[:*?"<>|]/g, '_')
          if (!/\.pdf$/i.test(nm)) nm += '.pdf'
          const out = dir ? `${dir}\\${nm}` : nm
          const w = await api.pdf.write(out, new Uint8Array(r.bytes))
          if (!w?.ok) return { ok: false, error: w?.error || 'write failed' }
          AI_CREATED_PATHS.add(out)
          const op = await ui('openPdf', { path: out })
          if (!op?.ok) return { ok: false, error: `copy saved to ${out} but could not open it: ${op?.error || '?'}` }
          return { ok: true, result: { info: `working copy created and opened: ${out} — the original is untouched; ALL further actions target the copy. Call pdfInfo next (give it a moment to load).` } }
        }
        default:
          return { ok: false, error: `unknown PDF action "${a.action}"` }
      }
    } catch (e) {
      const fe = fontErrText(e)
      return { ok: false, error: fe ? `${fe} (this family cannot render that text — choose another and retry)` : e?.message || String(e) }
    }
  }

  // registration: latest closures ride in a ref (so one registration survives re-renders), and only
  // the ACTIVE tab publishes the pdfOpen app-state + answers the AI
  const aiRef = useRef({})
  aiRef.current = { buildAiInfo, aiDispatch }
  useEffect(() => {
    if (!active) return
    const name = (path || '').split(/[\\/]/).pop()
    updateUiState({ pdfOpen: { name, pages: model.length || 1 } })
    const off = registerUi((n, arg) => {
      if (n === 'pdfAiInfo') return aiRef.current.buildAiInfo()
      if (n === 'pdfAiAct') return aiRef.current.aiDispatch(arg)
      return undefined
    })
    return () => { off(); updateUiState({ pdfOpen: null }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, path, model.length])

  // right-click "Duplicate": a text chain becomes ONE new piece (its joined text, the first piece's
  // style, a WORKING full font face) dropped at +12/+12; graphics/images are stream-copied as-is
  // Z-ORDER (stacking): move the selected objects forward/back in the paint order. Reselect the
  // same objects by their unchanged bbox/text (z changed, geometry didn't).
  const restackSelected = async (mode) => {
    if (!selected || busyRef.current) return
    busyRef.current = true
    try {
      const page = selected.page
      const items = selected.objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y }))
      await engineRef.current.restackObjects(page, items, mode)
      const m = await refreshPage(page)
      // re-find each object by a geometry/type signature (its z moved, its box did NOT). Step-by-
      // step (forward/backward) failed because on an invoice boxes and text overlap: a loose bbox
      // match grabbed a DIFFERENT overlapping object, so the next click moved the wrong one. Match
      // tightly (type + kind/text + full bbox) and pick the NEAREST by centre so stepping stays on
      // the same object.
      const keep = selected.objs.map((o) => {
        const cx = o.bbox.x + o.bbox.w / 2, cy = o.bbox.y + o.bbox.h / 2
        const cands = allOf(m)
          .filter((r) => r.type === o.type
            && Math.abs(r.bbox.x - o.bbox.x) < 2 && Math.abs(r.bbox.y - o.bbox.y) < 2
            && Math.abs(r.bbox.w - o.bbox.w) < 2 && Math.abs(r.bbox.h - o.bbox.h) < 2
            && (o.type !== 'text' || (r.text || '') === (o.text || ''))
            && (o.type !== 'vector' || (r.kind || '') === (o.kind || '')))
          .sort((a, b) => Math.hypot(a.bbox.x + a.bbox.w / 2 - cx, a.bbox.y + a.bbox.h / 2 - cy) - Math.hypot(b.bbox.x + b.bbox.w / 2 - cx, b.bbox.y + b.bbox.h / 2 - cy))
        return cands[0]
      }).filter(Boolean)
      console.log(`[pdf][restack] ${items.length} obj(s) → ${mode}`)
      onSelect(page, keep)
    } catch (err) { console.error('[pdf] restack failed:', err) } finally { busyRef.current = false }
  }

  const duplicateSelected = async () => {
    if (!selected || busyRef.current) return
    busyRef.current = true
    try {
      const page = selected.page
      const pg = modelRef.current.find((p) => p.pageIndex === page)
      // UNROTATED text is re-inserted as fresh, re-editable text (full embedded font). ROTATED text
      // can't be reproduced by insertText (it places axis-aligned → the copy would lose its rotation
      // and its frame would snap to the big axis-aligned box), so it goes through the stream-copy path
      // like shapes/images — that preserves the rotation and the tight oriented frame.
      const texts = selected.objs.filter((o) => o.type === 'text' && !o.rot)
      const rest = selected.objs.filter((o) => o.type !== 'text' || o.rot)
      const before = new Set(allOf(pg).map(sigOf))
      if (texts.length) {
        const first = [...texts].sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))[0]
        const f = pg.fonts?.[first.f] || {}
        const family = baseFamily(f.name || 'Arial')
        const k = `${family}|${f.bold ? 'b' : ''}${f.italic ? 'i' : ''}`
        const src = await fontSourceFor(family, !!f.bold, !!f.italic, true) // a FULL loadable face — the copy must be re-editable
        if (!src) throw new Error(`FONT_UNAVAILABLE|${family}`)
        const fonts = { [k]: src }
        const lines = joinRuns(texts).split('\n')
          .map((line, i) => [{ text: line, size: first.size, color: pg.colors?.[first.c] || '#000000', fontKey: k, x: first.x + 12, baseline: first.y + 12 + i * (first.size || 12) * 1.25, ls: first.ls || 0 }])
          .filter((l) => l[0].text !== '')
        await engineRef.current.insertText(page, { lines }, fonts, await getFallbacksFor(fonts))
      }
      if (rest.length) await engineRef.current.copyObjects(page, rest.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })), 12, 12)
      const m = await refreshPage(page)
      const fresh = allOf(m).filter((o) => !before.has(sigOf(o)))
      console.log(`[pdf][duplicate] ${texts.length} text piece(s) → 1 copy, ${rest.length} object(s) stream-copied`)
      onSelect(page, fresh)
    } catch (err) {
      const fe = fontErrText(err)
      if (fe) setEditErr(`Копия: ${fe}.`)
      console.error('[pdf] duplicate failed:', err)
    } finally { busyRef.current = false }
  }

  // ---- copy / paste: duplicate the selected objects straight into the PDF stream ----
  const copySelected = () => {
    if (!selected) return
    const items = selected.objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })) // x/y = exact text anchor
    console.log(`[pdf][copy] page ${selected.page}, ${items.length} items to clipboard:\n` + selected.objs.map(dbg).join('\n'))
    if (items.length) setClip({ page: selected.page, items })
  }
  const doPaste = async (dx, dy) => {
    if (!clip) return
    try {
      const before = new Set(allOf(model.find((p) => p.pageIndex === clip.page) || { runs: [] }).map(sigOf))
      await engineRef.current.copyObjects(clip.page, clip.items, dx, dy)
      const m = await refreshPage(clip.page)
      // the pasted copies are EXACTLY the objects that didn't exist before the paste — no
      // geometric guessing, so the selection can't grab neighbouring originals
      const pasted = allOf(m).filter((o) => !before.has(sigOf(o)))
      console.log(`[pdf][paste] page ${clip.page}, d=(${dx.toFixed(1)},${dy.toFixed(1)}), pasted ${pasted.length} of ${clip.items.length}`)
      // the paste re-numbers/re-parses everything, so the clipboard's stored geometry is stale —
      // clear it (copy again to paste again); the pasted objects themselves come out selected
      setClip(null)
      onSelect(clip.page, pasted) // re-select through the ONE selection entry point — as if just selected by hand
    } catch (err) { console.error('[pdf] paste failed:', err) }
  }
  // Ctrl+V / toolbar: 24 screen pixels down-right — always visibly offset from the original
  const pasteClip = () => doPaste(24 / scale, 24 / scale)
  // context menu on empty space: paste AT the clicked point (the copies' top-left corner lands there)
  const pasteClipAt = (x, y) => {
    if (!clip) return
    const x0 = Math.min(...clip.items.map((it) => it.bbox.x))
    const y0 = Math.min(...clip.items.map((it) => it.bbox.y))
    return doPaste(x - x0, y - y0)
  }

  // copy the TEXT of every selected text object to the OS clipboard (reading order: top-to-bottom,
  // then left-to-right; a new line when the baseline drops, a space within a line)
  const copyTextSelected = () => {
    if (!selected) return
    const texts = selected.objs.filter((o) => o.type === 'text')
    if (!texts.length) return
    const sorted = [...texts].sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))
    let out = ''
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0) out += Math.abs(sorted[i].y - sorted[i - 1].y) > 3 ? '\n' : ' '
      out += sorted[i].text || ''
    }
    api.writeClipboard?.(out) // native Electron clipboard (navigator.clipboard is blocked in Electron)
  }

  // double-click on the selection → physically remove the selected objects from the PDF stream.
  // (The file on disk is untouched; reopening the tab restores everything.)
  const deleteSelected = async () => {
    if (!selected) return
    const items = selected.objs.map((o) => ({ type: o.type, bbox: o.bbox, x: o.x, y: o.y })) // anchors → surgical text delete
    if (!items.length) return
    const page = selected.page
    const deletedTexts = selected.objs.filter((o) => o.type === 'text').map((o) => ({ x: o.x, y: o.y }))
    onSelect(selected.page, null) // selection (and any pending nudge) is gone with the objects
    try {
      await engineRef.current.deleteObjects(page, items)
      await refreshPage(page)
      // a deleted text object drops out of every variable that referenced it (empty variables go too)
      if (deletedTexts.length) {
        setVariables((vs) => vs
          .map((v) => ({
            ...v,
            occurrences: v.occurrences.filter((o) => !(o.page === page && occParts(o).some((p) => deletedTexts.some((d) => Math.abs(d.x - p.x) < 1.5 && Math.abs(d.y - p.baseline) < 1.5))))
          }))
          .filter((v) => v.occurrences.length))
      }
    } catch (err) { console.error('[pdf] delete failed:', err) }
  }

  // what the second (contextual) toolbar row edits: text controls, the selected object's panel,
  // or just a hint when nothing is selected (no confusing default font controls)
  const selKind = textEdit
    ? 'text'
    : !selected
      ? 'none'
      : selected.objs.every((o) => o.type === 'text')
        ? 'text'
        : selected.objs.length === 1
          ? selected.objs[0].type
          : 'mixed'
  const selObj1 = selected?.objs.length === 1 ? selected.objs[0] : null
  // is the current selection already part of some variable? (drives the "Remove from variable" item)
  const selInVar = !!selected && variables.some((v) => v.occurrences.some((o) => occMatches(o, selected.page, selected.objs)))
  // read-only geometry readout at the end of the panel; live during drag/resize/endpoint-drag.
  // Whole numbers — the readout is orientation, not a measuring tool.
  const r1 = (n) => Math.round(n)
  const geoText = () => {
    if (liveGeo?.line) {
      const L = liveGeo.line
      return `X ${r1(Math.min(L.x1, L.x2))} · Y ${r1(Math.min(L.y1, L.y2))} · L ${r1(Math.hypot(L.x2 - L.x1, L.y2 - L.y1))}`
    }
    if (liveGeo) return `X ${r1(liveGeo.x)} · Y ${r1(liveGeo.y)} · W ${r1(liveGeo.w)} · H ${r1(liveGeo.h)}`
    if (!selected?.objs.length) return ''
    const ndx = nudge?.page === selected.page ? nudge.dx : 0
    const ndy = nudge?.page === selected.page ? nudge.dy : 0
    if (selObj1?.line) {
      const L = selObj1.line
      return `X ${r1(Math.min(L.x1, L.x2) + ndx)} · Y ${r1(Math.min(L.y1, L.y2) + ndy)} · L ${r1(Math.hypot(L.x2 - L.x1, L.y2 - L.y1))}`
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const o of selected.objs) { x0 = Math.min(x0, o.bbox.x); y0 = Math.min(y0, o.bbox.y); x1 = Math.max(x1, o.bbox.x + o.bbox.w); y1 = Math.max(y1, o.bbox.y + o.bbox.h) }
    // a single rotated object: show its screen angle (∠, clockwise-positive) and its OWN w×h
    const rot = selected.objs.length === 1 ? selected.objs[0].rot || 0 : 0
    if (rot) {
      const o = selected.objs[0]
      const w = o.obw > 0 ? o.obw : x1 - x0, h = o.obh > 0 ? o.obh : y1 - y0
      return `X ${r1((o.ox ?? x0) + ndx)} · Y ${r1((o.oy ?? y0) + ndy)} · W ${r1(w)} · H ${r1(h)} · ∠ ${(-rot).toFixed(1)}°`
    }
    return `X ${r1(x0 + ndx)} · Y ${r1(y0 + ndy)} · W ${r1(x1 - x0)} · H ${r1(y1 - y0)}`
  }

  return (
    <div className="pdfed">
      <div className="pdfed__toolbar">
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.max(0.3, s / 1.15))} title="Zoom out"><ZoomOutIcon /></button>
        <span className="pdfed__zoom">{Math.round(scale * 100)}%</span>
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.min(10, s * 1.15))} title="Zoom in"><ZoomInIcon /></button>
        <span className="pdfed__sep" />
        {/* selection mode: exactly one of the two is always on */}
        <button className={'pdfed__btn' + (selMode === 'single' ? ' is-active' : '')} onClick={() => setSelMode('single')} title="Select single elements (lines)"><CursorOneIcon /></button>
        <button className={'pdfed__btn' + (selMode === 'block' ? ' is-active' : '')} onClick={() => setSelMode('block')} title="Select whole text blocks"><CursorBlockIcon /></button>
        <span className="pdfed__sep" />
        {/* insert section: arm a mode (text / image; shapes coming), then click the page */}
        <button
          className={'pdfed__btn' + (insertMode === 'text' ? ' is-active' : '')}
          onClick={() => setInsertMode((m) => (m === 'text' ? false : 'text'))}
          title="Insert text — click the page where it should go"
        >
          <InsertTextIcon />
        </button>
        <button
          className={'pdfed__btn' + (insertMode?.image ? ' is-active' : '')}
          onClick={pickImageFile}
          title="Insert image (PNG/JPEG) — pick a file, then click the page"
        >
          <InsertImageIcon />
        </button>
        <button
          className={'pdfed__btn' + (insertMode?.shape ? ' is-active' : '')}
          onClick={(e) => {
            if (insertMode?.shape) { setInsertMode(false); return }
            const r = e.currentTarget.getBoundingClientRect()
            setShapeMenu({ x: r.left, y: r.bottom + 4 })
          }}
          title="Insert shape — pick a kind, then click or drag on the page"
        >
          <InsertShapeIcon />
        </button>
        <span className="pdfed__sep" />
        <button className="pdfed__btn" onClick={copySelected} disabled={!selected} title="Copy (Ctrl+C)"><CopyIcon /></button>
        <button className="pdfed__btn" onClick={pasteClip} disabled={!clip} title="Paste (Ctrl+V)"><PasteIcon /></button>
        <button className="pdfed__btn" onClick={deleteSelected} disabled={!selected} title="Delete"><TrashIcon /></button>
        <span className="pdfed__sep" />
        <button className="pdfed__btn" onClick={doUndo} disabled={!undoState.canUndo} title="Undo (Ctrl+Z)"><UndoIcon /></button>
        <button className="pdfed__btn" onClick={doRedo} disabled={!undoState.canRedo} title="Redo (Ctrl+Y)"><RedoIcon /></button>
        <span className="pdfed__sep" />
        <button className="pdfed__btn pdfed__btn--txt pdfed__btn--save" onClick={handleSave} disabled={saving || !path} title="Save">{saving ? '…' : 'Save'}</button>
        <button className="pdfed__btn" onClick={() => setShowInfo(true)} title={t('pdfed.info')}><InfoIcon /></button>
        <span className="pdfed__spacer" />
        <label className="pdfed__check" title="Outline every element on the page (faint grey), so you can see where everything is">
          <input type="checkbox" checked={showAll} onChange={(e) => { setShowAll(e.target.checked); localStorage.setItem('pdfedShowAll', e.target.checked ? '1' : '0') }} />
          All
        </label>
        <span className="pdfed__status">{status === 'loading' ? '…' : `${pageCount} p.`}</span>
      </div>

      {/* second row — contextual: text style controls, shape parameters, or the object's panel */}
      <div className="pdfed__stylebar">
        {!insertMode?.shape && selected?.objs.length > 1 && (
          /* 2+ objects → align tools: everything to the leftmost / the topmost of the selection */
          <>
            <button className="pdfed__btn" onClick={() => alignSelected('left')} title="Align left edges (to the leftmost object)"><AlignLeftIcon /></button>
            <button className="pdfed__btn" onClick={() => alignSelected('right')} title="Align right edges (to the rightmost object)"><AlignRightIcon /></button>
            <button className="pdfed__btn" onClick={() => alignSelected('top')} title="Align top edges (to the topmost object)"><AlignTopIcon /></button>
            <button className="pdfed__btn" onClick={() => alignSelected('bottom')} title="Align bottom edges (to the lowest object)"><AlignBottomIcon /></button>
            <button className="pdfed__btn" disabled={(selected?.objs.length || 0) < 3} onClick={distributeRows} title="Distribute into rows at equal spacing (the gap between the first two)"><DistributeRowsIcon /></button>
            <span className="pdfed__sep" />
          </>
        )}
        {insertMode?.shape && (
          <>
            <span className="pdfed__sblabel">Shape · {insertMode.shape.kind}</span>
            {insertMode.shape.kind === 'rect' && (
              <label className="pdfed__mini" title="Corner radius, pt">
                R
                <ComboNum value={cornerR} onPick={(v) => setCornerR(Math.max(0, v || 0))} opts={[0, 2, 4, 6, 8, 12, 16, 24]} step={1} min={0} max={200} width={64} />
              </label>
            )}
            <label className="pdfed__mini" title="Stroke width, pt">
              W
              <ComboNum value={strokeW} onPick={(v) => setStrokeW(Math.max(0.2, v || 1))} opts={[0.5, 1, 1.5, 2, 3, 4, 6]} step={0.5} min={0.2} max={40} width={64} />
            </label>
            <select className="pdfed__fontsel pdfed__dashsel" value={dashSel} onChange={(e) => setDashSel(e.target.value)} title="Line type">
              <option value="solid">— Solid</option>
              <option value="dashed">– – Dashed</option>
              <option value="dotted">· · Dotted</option>
              <option value="dashdot">–·– Dash-dot</option>
            </select>
            <span className="pdfed__sbinfo">
              stroke <span className="pdfed__swatch" style={{ background: colorSel, display: 'inline-block', verticalAlign: '-3px' }} /> — click or drag on the page
            </span>
          </>
        )}
        {!insertMode?.shape && selKind === 'text' && (
          <>
        <select
          className="pdfed__fontsel"
          value={fontSel}
          disabled={styleLocked}
          onMouseDown={() => rteRef.current?.grabSel()}
          onChange={(e) => pickFont(e.target.value)}
          title={styleLocked ? 'Select a single text object to change its style' : 'Font'}
        >
          {/* the actually-selected font MUST be a present option or the <select> shows the wrong row */}
          {fontSel && !docFonts.some((f) => f.name === fontSel) && !sysFonts.includes(fontSel) && !docFonts.some((f) => f.match === fontSel) && (
            <option value={fontSel}>{fontSel}</option>
          )}
          {docFonts.length > 0 && (
            <optgroup label="PDF">
              {docFonts.map((f) => {
                // disabled when it can't be embedded at all OR lacks glyphs for the current text —
                // no silent substitution, so a font you can't pick simply isn't selectable.
                const st = covNonce >= 0 ? fontState(f.name, f.bytes) : 'ok'
                const tag = st === 'unavailable' ? ' — недоступен' : st === 'nocover' ? ' — нет символов' : ''
                return (
                  <option key={f.name} value={f.name} disabled={st !== 'ok'} style={st === 'ok' ? undefined : { color: '#c8c8cc', background: '#f2f2f4' }}>
                    {(st === 'ok' ? '' : '⊘ ') + f.name + (f.subst ? ` ≈ ${f.subst}` : f.match ? ` → ${f.match}` : '') + tag}
                  </option>
                )
              })}
            </optgroup>
          )}
          {/* Similar = substitutes that AREN'T plain system fonts (a Google clone etc.); the common
              ones (Arial/Times/Courier) live once in System with a clean label — no value dupes */}
          {docFonts.some((f) => f.match && !sysFonts.includes(f.match)) && (
            <optgroup label="Similar (≈ PDF)">
              {[...new Map(docFonts.filter((f) => f.match && !sysFonts.includes(f.match)).map((f) => [f.match, f])).entries()].map(([m, f]) => {
                const ok = covNonce >= 0 && fontCanRender(m)
                return <option key={'sim:' + m} value={m} disabled={!ok} style={ok ? { fontFamily: m } : { color: '#c8c8cc', background: '#f2f2f4' }}>{(ok ? '' : '⊘ ') + `${m} ≈ ${f.name}` + (ok ? '' : ' — нет символов')}</option>
              })}
            </optgroup>
          )}
          <optgroup label="System">
            {sysFonts.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </optgroup>
        </select>
        <ComboNum value={fontSize} onPick={pickSize} opts={SIZES} step={0.5} min={4} max={200} width={72} title="Font size (pt)" onGrab={() => rteRef.current?.grabSel()} disabled={styleLocked} />
        <button
          className={'pdfed__btn pdfed__btn--txt' + ((singleText ? selPg?.fonts?.[singleText.f]?.bold : boldSel) ? ' is-active' : '')}
          disabled={styleLocked}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleBold}
          title="Bold"
        ><b>B</b></button>
        <button
          className={'pdfed__btn pdfed__btn--txt' + ((singleText ? selPg?.fonts?.[singleText.f]?.italic : italicSel) ? ' is-active' : '')}
          disabled={styleLocked}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleItalic}
          title="Italic"
        ><i>I</i></button>
        <label className="pdfed__mini" title="Line height — select TWO OR MORE text lines to respace their baselines (top one stays); also the insert editor's spacing">
          LH
          <ComboNum
            value={lineH}
            onPick={pickLH}
            opts={LH_OPTS}
            step={0.05}
            min={0.8}
            max={3}
            width={64}
            disabled={!textEdit && !!selected && selected.objs.filter((o) => o.type === 'text').length < 2}
          />
        </label>
        <label className="pdfed__mini" title="Letter spacing: − / + nudge the selected text's spacing from its CURRENT value (there is no single stored value in PDF — this adjusts relative to what's there)">
          LS
          <span className="pdfed__ls">
            <button className="pdfed__lsbtn" disabled={styleLocked && !selected?.objs.some((o) => o.type === 'text')} onMouseDown={(e) => e.preventDefault()} onClick={() => pickLS(+(letterS - 0.1).toFixed(2))} title="Tighter (−0.1)">−</button>
            {lsEdit != null ? (
              <input
                className="pdfed__lsinput"
                autoFocus
                value={lsEdit}
                onChange={(e) => setLsEdit(e.target.value)}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') { const v = parseFloat(lsEdit.replace(',', '.')); pickLS(isNaN(v) ? 0 : Math.max(-10, Math.min(20, v))); setLsEdit(null) }
                  else if (e.key === 'Escape') setLsEdit(null)
                }}
                onBlur={() => { const v = parseFloat(lsEdit.replace(',', '.')); if (!isNaN(v)) pickLS(Math.max(-10, Math.min(20, v))); setLsEdit(null) }}
              />
            ) : (
              <span className="pdfed__lsval" style={{ cursor: 'pointer' }} title="Click = type a value" onMouseDown={(e) => e.preventDefault()} onClick={() => setLsEdit(String(+letterS.toFixed(2)))}>{letterS ? (letterS > 0 ? '+' : '') + +letterS.toFixed(2) : '0'}</span>
            )}
            <button className="pdfed__lsbtn" disabled={styleLocked && !selected?.objs.some((o) => o.type === 'text')} onMouseDown={(e) => e.preventDefault()} onClick={() => pickLS(+(letterS + 0.1).toFixed(2))} title="Wider (+0.1)">+</button>
            <select className="pdfed__lssel" title="Letter spacing presets" value={LS_PRESETS.includes(+letterS.toFixed(1)) ? +letterS.toFixed(1) : ''} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => pickLS(parseFloat(e.target.value))}>
              {!LS_PRESETS.includes(+letterS.toFixed(1)) && <option value="" disabled>{+letterS.toFixed(2)}</option>}
              {LS_PRESETS.map((v) => <option key={v} value={v}>{v > 0 ? '+' + v : v}</option>)}
            </select>
          </span>
        </label>
        <div className="pdfed__colorwrap">
          <button
            className="pdfed__btn"
            disabled={styleLocked}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setColorOpen((v) => (v ? null : { x: r.left, y: r.bottom + 4 })) // fixed coords — the toolbar's overflow can't clip it
            }}
            title={styleLocked ? 'Select a single text object to change its style' : 'Color'}
          >
            <span className="pdfed__swatch" style={{ background: colorSel }} />
          </button>
          {colorOpen && (
            <div className="pdfed__colorpanel" style={{ left: colorOpen.x, top: colorOpen.y }}>
              <div className="pdfed__swatches">
                {docColors.map((c) => (
                  <button
                    key={c}
                    className={'pdfed__swatchbtn' + (c === colorSel ? ' is-on' : '')}
                    style={{ background: c }}
                    title={c}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { pickColor(c); setColorOpen(null) }}
                  />
                ))}
              </div>
              {/* any colour beyond the document palette — the native picker */}
              <label className="pdfed__custom">
                Custom
                <input type="color" value={colorSel} onChange={(e) => pickColor(e.target.value)} />
              </label>
              {/* text transparency — 0 % = fully transparent (invisible), 100 % = solid. Disabled in the
                  text editor (opacity applies to the committed run, not per-caret) */}
              <label className="pdfed__custom pdfed__opacity" title="Text opacity — 0% fully transparent, 100% solid">
                Opacity
                <input type="range" min="0" max="100" step="5" value={textOpacity} disabled={textEdit} onChange={(e) => pickTextOpacity(+e.target.value)} />
                <span className="pdfed__opval">{textOpacity}%</span>
              </label>
            </div>
          )}
        </div>
        <button
          className={'pdfed__btn' + (pipette ? ' is-active' : '')}
          disabled={!textEdit && !selected}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPipette((v) => !v)}
          title="Pick style from any text — applies to the selection or the open editor"
        >
          <PipetteIcon />
        </button>
        {selected?.objs.length > 0 && (
          <>
            <span className="pdfed__spacer" />
            <span className="pdfed__sbinfo">{geoText()}</span>
          </>
        )}
          </>
        )}
        {!insertMode?.shape && (selKind === 'image' || selKind === 'vector') && selObj1 && (
          /* object panel — position is editable now; resize, fill/stroke colours and corner
             radius land here next */
          <>
            <span className="pdfed__sblabel">{selKind === 'image' ? 'Image' : 'Vector'}</span>
            {/* images have no colour picker → keep a plain opacity box here; vectors set opacity INSIDE
                the Stroke/Fill colour pickers, independently per channel */}
            {selKind === 'image' && (
              <label className="pdfed__mini" title="Opacity, % (PDF ExtGState alpha)">
                Op
                <ComboNum value={selObj1.opacity ?? 100} onPick={(v) => deferMutation(() => opacitySelected(v ?? 100))} opts={[10, 25, 50, 75, 100]} step={5} min={0} max={100} width={60} />
              </label>
            )}
            {selKind === 'vector' && (
              <>
                <label className="pdfed__mini" title="Stroke colour + its opacity">
                  Stroke
                  <ColorDrop
                    value={selObj1.kind === 'stroke' ? selPg?.colors?.[selObj1.c] || '#000000' : '#000000'}
                    colors={docColors}
                    onPick={(c) => recolorSelected(selObj1.line?.head === 'filled' ? { stroke: c, fill: c } : { stroke: c })}
                    title="Stroke colour (incl. Transparent)"
                    opacity={selObj1.strokeOpacity ?? 100}
                    onOpacity={(v) => deferMutation(() => opacitySelected(selObj1.opacity ?? 100, v ?? 100))}
                  />
                </label>
                {!selObj1.line && ( /* fill makes no sense for a line/arrow (a filled head follows Stroke) */
                  <label className="pdfed__mini" title="Fill colour + its opacity">
                    Fill
                    <ColorDrop
                      value={selObj1.kind === 'fill' ? selPg?.colors?.[selObj1.c] || '#000000' : selObj1.fc !== undefined ? selPg?.colors?.[selObj1.fc] || '#ffffff' : '#ffffff'}
                      colors={docColors}
                      onPick={(c) => recolorSelected({ fill: c })}
                      title="Fill colour (incl. Transparent)"
                      opacity={selObj1.opacity ?? 100}
                      onOpacity={(v) => deferMutation(() => opacitySelected(v ?? 100, selObj1.strokeOpacity ?? 100))}
                    />
                  </label>
                )}
                <label className="pdfed__mini" title="Stroke width, pt — any vector">
                  W
                  <ComboNum value={selObj1.strokeW ?? 1} onPick={(v) => deferMutation(() => strokeWidthSelected(Math.max(0.2, v || 1)))} opts={[0.5, 1, 1.5, 2, 3, 4, 6]} step={0.5} min={0.2} max={40} width={60} />
                </label>
                {!selObj1.line && ( /* corner radius makes no sense for a line/arrow */
                  <label className="pdfed__mini" title="Corner radius, pt — rebuilds the path as a rounded rectangle over the same bounds">
                    R
                    <ComboNum value={selObj1.radius ?? 0} onPick={(v) => deferMutation(() => radiusSelected(Math.max(0, v || 0)))} opts={[0, 2, 4, 6, 8, 12, 16, 24]} step={1} min={0} max={200} width={60} />
                  </label>
                )}
                <select className="pdfed__fontsel pdfed__dashsel" value={selObj1.dash || 'solid'} onChange={(e) => dashSelected(e.target.value)} title="Line type">
                  <option value="solid">— Solid</option>
                  <option value="dashed">– – Dashed</option>
                  <option value="dotted">· · Dotted</option>
                  <option value="dashdot">–·– Dash-dot</option>
                </select>
              </>
            )}
            {/* read-only geometry at the very end — the frame/handles are the editing tools */}
            <span className="pdfed__spacer" />
            <span className="pdfed__sbinfo">{geoText()}</span>
          </>
        )}
        {!insertMode?.shape && selKind === 'mixed' && <span className="pdfed__sbinfo">{selected.objs.length} objects selected</span>}
        {!insertMode?.shape && selKind === 'none' && <span className="pdfed__sbinfo">Select an element on the page — its properties appear here</span>}
      </div>

      {showInfo && (
        <div className="pdfed__infowrap" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowInfo(false) }}>
          <div className="pdfed__infobox">
            <div className="pdfed__infohead">
              <b>{t('pdfed.helpTitle')}</b>
              <button className="pdfed__btn" onClick={() => setShowInfo(false)} title="Close">✕</button>
            </div>
            <div className="pdfed__infobody">
              {t('pdfed.help').split('\n').map((line, i) => {
                const dash = line.indexOf('—')
                return (
                  <p key={i}>
                    {dash > 0 ? <><b>{line.slice(0, dash)}</b>{line.slice(dash)}</> : line}
                  </p>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {shapeMenu && (
        <ContextMenu
          x={shapeMenu.x}
          y={shapeMenu.y}
          items={[
            { label: 'Rectangle', onClick: () => setInsertMode({ shape: { kind: 'rect' } }) },
            { label: 'Ellipse', onClick: () => setInsertMode({ shape: { kind: 'ellipse' } }) },
            { label: 'Check ✓', onClick: () => setInsertMode({ shape: { kind: 'check' } }) },
            { label: 'Cross ✕', onClick: () => setInsertMode({ shape: { kind: 'cross' } }) },
            {
              label: 'Line',
              children: [
                { label: 'Line —', onClick: () => setInsertMode({ shape: { kind: 'line' } }) },
                { label: 'Arrow →', onClick: () => setInsertMode({ shape: { kind: 'arrow', head: 'open' } }) },
                { label: 'Arrow ▶', onClick: () => setInsertMode({ shape: { kind: 'arrow', head: 'filled' } }) },
                { label: 'Arrow ↔', onClick: () => setInsertMode({ shape: { kind: 'arrow', head: 'double' } }) },
                { label: 'Arrow ⊸', onClick: () => setInsertMode({ shape: { kind: 'arrow', head: 'bar' } }) }
              ]
            }
          ]}
          onClose={() => setShapeMenu(null)}
        />
      )}

      {editErr && (
        <div className="pdfed__editerr">
          {editErr}
          <button className="pdfed__editerr-x" onClick={() => setEditErr(null)} title="Скрыть">×</button>
        </div>
      )}
      <div className="pdfed__body">
        <div
          className="pdfed__viewport"
          ref={viewportRef}
          style={{ cursor: spaceHeld ? (panning ? 'grabbing' : 'grab') : undefined }}
          onMouseDown={onPanMouseDown}
        >
          <div className="pdfed__pages" style={{ pointerEvents: spaceHeld ? 'none' : undefined }}>
            {model.map((p) => (
              <PdfPage
                key={p.pageIndex}
                page={p}
                image={imgOf(p.pageIndex)}
                scale={scale}
                selected={selected}
                selMode={selMode}
                showAll={showAll}
                nudge={nudge && nudge.page === p.pageIndex ? nudge : null}
                insertMode={insertMode}
                textEdit={textEdit}
                pipette={pipette}
                rte={{
                  ref: rteRef,
                  font: cssFontFor(fontSel),
                  color: colorSel,
                  size: fontSize,
                  bold: boldSel,
                  italic: italicSel,
                  lineHeight: lineH,
                  letterSpacing: letterS,
                  pipette,
                  onPipette: () => setPipette((v) => !v),
                  onText: setEditText // live plain text → drives coverage-aware font dropdown
                }}
                onSelect={onSelect}
                onMove={moveSelected}
                onRotate={rotateSelected}
                onRestack={restackSelected}
                onResize={resizeSelected}
                onResizeRot={resizeRotSelected}
                onLineGeo={lineGeoSelected}
                onLiveGeo={setLiveGeo}
                onSprite={spriteFor}
                onMenu={setMenu}
                onInsertAt={startInsertAt}
                onEditText={startEditSelected}
                onPipettePick={pipettePick}
                onTextCommit={commitText}
                onTextCancel={() => setTextEdit(null)}
              />
            ))}
          </div>
        </div>

        {/* right panel: the document's variables (template fields) — collapsible + resizable */}
        {varsCollapsed ? (
          <button className="pdfed__vars-open" title="Variables" onClick={toggleVarsCollapsed}>
            <ChevronLeftIcon />
          </button>
        ) : (
          <aside className="pdfed__vars" style={{ width: varsWidth }}>
            <div className="pdfed__vars-resize" onMouseDown={startVarsResize} title="Drag to resize" />
            <div className="pdfed__vars-head">
              <b><VariableIcon /> Variables</b>
              <button className="pdfed__collapse" title="Collapse" onClick={toggleVarsCollapsed}><ChevronRightIcon /></button>
            </div>
            <div className="pdfed__vars-body">
              {variables.length === 0 ? (
                <div className="pdfed__vars-empty">Select text on the page, right-click → <b>Create variable</b>. Editing a variable's value updates every linked place in the document.</div>
              ) : (
                variables.map((v) => {
                  const open = expandedVars.has(v.id)
                  return (
                    <div key={v.id} className="pdfed__var">
                      <div className="pdfed__var-row">
                        <button className="pdfed__var-toggle" onClick={() => toggleVarExpand(v.id)} title={open ? 'Hide places' : 'Show places'}>
                          <span className="pdfed__var-exp">{open ? '▾' : '▸'}</span>
                          <span className="pdfed__var-name" title={v.name}>{v.name}</span>
                        </button>
                        <span className="pdfed__var-count" title="linked places">{v.occurrences.filter((o) => o.enabled !== false).length}</span>
                        <button className="pdfed__btn pdfed__var-del" title="Remove variable" onClick={() => removeVariable(v.id)}>✕</button>
                      </div>
                      <input className="pdfed__var-value" value={v.value} onChange={(e) => changeVarValue(v.id, e.target.value)} placeholder="value…" />
                      {open && (
                        <div className="pdfed__var-occs">
                          {v.occurrences.map((o, i) => (
                            <label key={i} className="pdfed__occ">
                              <input type="checkbox" checked={o.enabled !== false} onChange={() => toggleOcc(v.id, i)} />
                              <button className="pdfed__occ-go" onClick={() => highlightOcc(o)} title="Show on page">p.{o.page + 1} · {Math.round(o.x)},{Math.round(o.baseline)}</button>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </aside>
        )}
      </div>

      {varDraft && (
        <div className="pdfed__infowrap" onMouseDown={(e) => { if (e.target === e.currentTarget) setVarDraft(null) }}>
          <div className="pdfed__varpop">
            <div className="pdfed__infohead"><b>Create variable</b><button className="pdfed__btn" onClick={() => setVarDraft(null)}>✕</button></div>
            {variables.length > 0 && (
              <label className="pdfed__varpop-lbl">Add to an existing variable
                <select className="pdfed__var-value" value={varDraft.existing || ''} onChange={(e) => setVarDraft({ ...varDraft, existing: e.target.value })}>
                  <option value="">— new variable —</option>
                  {variables.map((v) => <option key={v.id} value={v.name}>{v.name} ({v.occurrences.length})</option>)}
                </select>
              </label>
            )}
            <label className="pdfed__varpop-lbl">Name (for a new variable)
              <input className="pdfed__var-value" autoFocus disabled={!!varDraft.existing}
                value={varDraft.existing || varDraft.name}
                onChange={(e) => setVarDraft({ ...varDraft, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') finishCreate(false); if (e.key === 'Escape') setVarDraft(null) }} />
            </label>
            <div className="pdfed__varpop-btns">
              <button className="pdfed__btn pdfed__btn--txt" onClick={() => finishCreate(false)}>Add this</button>
              <button className="pdfed__btn pdfed__btn--txt pdfed__btn--save" onClick={() => finishCreate(true)}>Find identical &amp; add</button>
            </div>
          </div>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.sx}
          y={menu.sy}
          items={
            menu.kind === 'sel'
              ? [
                  { label: <span className="pdfed__mi"><CopyIcon /> Copy</span>, onClick: copySelected },
                  { label: <span className="pdfed__mi"><PasteIcon /> Duplicate</span>, onClick: duplicateSelected },
                  ...(selected?.objs.some((o) => o.type === 'text') ? [{ label: <span className="pdfed__mi"><CopyIcon /> Copy text</span>, onClick: copyTextSelected }] : []),
                  ...(selected?.objs.some((o) => o.type === 'text') ? [{ label: <span className="pdfed__mi"><VariableIcon /> Create variable</span>, onClick: startCreateVariable }] : []),
                  ...(selInVar ? [{ label: <span className="pdfed__mi"><VariableIcon /> Remove from variable</span>, onClick: removeSelectionFromVars }] : []),
                  { label: <span className="pdfed__mi"><TrashIcon /> Delete</span>, onClick: deleteSelected }
                ]
              : [
                  ...(clip ? [{ label: <span className="pdfed__mi"><PasteIcon /> Paste</span>, onClick: () => pasteClipAt(menu.x, menu.y) }] : []),
                  { label: <span className="pdfed__mi"><InsertTextIcon /> Insert text</span>, onClick: () => startTextEdit(menu.page, menu.x, menu.y) }
                ]
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
