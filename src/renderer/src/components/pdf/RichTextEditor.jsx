import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style'
import { PipetteIcon } from '../icons'

// Floating rich-text editor for INSERTING new text into the PDF — the app's own Tiptap engine
// (same as notes/mail), headless: the PDF toolbar drives it through ref.exec(). Grows with its
// content; the box corner is resizable. On commit every text node's REAL on-screen rect becomes
// the exact PDF coordinates, so the text lands precisely where it was typed.
const rgbToHex = (rgb) => {
  const m = String(rgb).match(/\d+/g)
  if (!m) return '#000000'
  return '#' + m.slice(0, 3).map((v) => (+v).toString(16).padStart(2, '0')).join('')
}
// REAL ascent of the font as the browser renders it (px): the DOM text rect's top is
// baseline − thisAscent. A fixed 0.8 approximation displaced the visual text during editing
// (Arial's true ascent is ~0.905) even though the maths cancelled out on commit.
let measureCtx = null
const domAscentPx = (style) => {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  try {
    measureCtx.font = `${style.fontStyle || 'normal'} ${style.fontWeight || 400} ${parseFloat(style.fontSize)}px ${style.fontFamily}`
    const m = measureCtx.measureText('Hg')
    if (m.fontBoundingBoxAscent > 0) return m.fontBoundingBoxAscent
  } catch (_) {}
  return parseFloat(style.fontSize) * 0.8
}

// DOM → visual lines of styled runs with EXACT page coordinates (pt). Adjacent identically-formatted
// contiguous text merges into ONE run; a formatting change starts a new run; lines group by rect top.
function parseRuns(root, pageEl, scale) {
  const pr = pageEl.getBoundingClientRect()
  const runs = []
  const walk = (el) => {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent
        if (!text || !text.trim()) continue
        const st = getComputedStyle(node.parentElement)
        const range = document.createRange()
        range.selectNodeContents(node)
        const r = range.getClientRects()[0]
        if (!r) continue
        const size = +(parseFloat(st.fontSize) / scale).toFixed(2)
        runs.push({
          text,
          size,
          fontName: (st.fontFamily.split(',')[0] || '').replace(/["']/g, '').trim(),
          color: rgbToHex(st.color),
          bold: (parseInt(st.fontWeight, 10) || 400) >= 600,
          italic: st.fontStyle === 'italic',
          ls: +((parseFloat(st.letterSpacing) || 0) / scale).toFixed(2), // letter-spacing → Tc
          x: +((r.left - pr.left) / scale).toFixed(2),
          baseline: +((r.top - pr.top + domAscentPx(st)) / scale).toFixed(2) // the REAL visual baseline
        })
      } else walk(node)
    }
  }
  walk(root)
  runs.sort((a, b) => a.baseline - b.baseline || a.x - b.x)
  const lines = []
  for (const run of runs) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last[0].baseline - run.baseline) < 2) {
      const p = last[last.length - 1]
      if (p.fontName === run.fontName && p.size === run.size && p.color === run.color && p.bold === run.bold && p.italic === run.italic && p.ls === run.ls) p.text += run.text
      else last.push(run)
    } else lines.push([run])
  }
  return lines
}

const RichTextEditor = forwardRef(function RichTextEditor({ x, y, scale, font, color, size = 12, bold = false, italic = false, lineHeight = 1.25, letterSpacing = 0, pipette = false, initialHTML, anchorLeft, anchorBaseline, onPipette, onCommit, onCancel }, ref) {
  const boxRef = useRef(null)
  const savedSel = useRef(null) // selection captured before a toolbar <select> steals focus
  const commitRef = useRef(() => {})
  const pipetteRef = useRef(pipette)
  pipetteRef.current = pipette

  const editor = useEditor({
    extensions: [StarterKit, TextStyle, Color, FontFamily, FontSize],
    content: initialHTML || '', // EDIT mode arrives pre-filled with the block's original styled text
    autofocus: 'end'
  })

  // ZOOM while the editor is open: every explicit fontSize mark is in PX at the zoom it was typed
  // at — rescale them by the ratio and re-run the anchor alignment, or the editor detaches from
  // the page (stays huge at 10% zoom) and the commit lands at garbage coordinates
  const prevScaleRef = useRef(scale)
  useEffect(() => {
    const prev = prevScaleRef.current
    if (!editor || scale === prev) return
    prevScaleRef.current = scale
    const ratio = scale / prev
    const { state, view } = editor
    const tr = state.tr
    state.doc.descendants((node, pos) => {
      if (!node.isText) return
      node.marks.forEach((m) => {
        if (m.type.name === 'textStyle' && m.attrs.fontSize) {
          const px2 = parseFloat(m.attrs.fontSize)
          if (px2 > 0) tr.addMark(pos, pos + node.nodeSize, m.type.create({ ...m.attrs, fontSize: `${+(px2 * ratio).toFixed(3)}px` }))
        }
      })
    })
    if (tr.steps.length) view.dispatch(tr)
    setAdj(null) // re-measure the alignment at the new zoom
  }, [scale, editor])

  // EDIT mode: the committed coordinates come from the REAL DOM rects of the text (parseRuns), so
  // the alignment must use the SAME measurement — the first text node's client rect (which already
  // includes every toolbar/padding/margin/half-leading offset) is shifted onto the anchor. The
  // delta lives in state: a re-render with the prop position would otherwise wipe an imperative
  // style tweak and the text would land displaced even on an untouched commit.
  const [adj, setAdj] = useState(null)
  useEffect(() => {
    if (anchorLeft === undefined || adj || !editor) return
    const id = requestAnimationFrame(() => {
      const box = boxRef.current
      const pageEl = box?.closest('.pdfed__page')
      const prose = box?.querySelector('.ProseMirror')
      if (!box || !pageEl || !prose) return
      let r = null, node = null
      const walk = (el) => {
        for (const n of el.childNodes) {
          if (r) return
          if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) {
            const rg = document.createRange()
            rg.selectNodeContents(n)
            r = rg.getClientRects()[0] || null
            node = n
          } else if (n.childNodes) walk(n)
        }
      }
      walk(prose)
      const pr = pageEl.getBoundingClientRect()
      if (r && node) {
        // align the first text node's VISUAL baseline (rect.top + real DOM ascent) onto the
        // original baseline — the same measurement the commit uses, so what you see while editing
        // is exactly where the text lands
        const asc = domAscentPx(getComputedStyle(node.parentElement))
        setAdj({ dx: anchorLeft * scale - (r.left - pr.left), dy: anchorBaseline * scale - asc - (r.top - pr.top) })
      } else {
        const pb = prose.getBoundingClientRect() // empty editor → align the prose box itself
        setAdj({ dx: anchorLeft * scale - (pb.left - pr.left), dy: anchorBaseline * scale - size * scale * 0.8 - (pb.top - pr.top) })
      }
    })
    return () => cancelAnimationFrame(id)
  }, [editor, adj, anchorLeft, anchorBaseline, scale, size])

  // The PDF toolbar drives the editor through this handle. grabSel() is called on the toolbar
  // select's mousedown (a native select collapses the DOM selection on blur — same trick as the
  // notes editor). exec() deliberately does NOT focus the editor: commands apply to the stored
  // selection anyway, and the toolbar input the user is typing in keeps its focus.
  useImperativeHandle(ref, () => ({
    grabSel: () => { if (editor) savedSel.current = { from: editor.state.selection.from, to: editor.state.selection.to } },
    exec: (cmd, val) => {
      if (!editor) return
      const sel = savedSel.current || { from: editor.state.selection.from, to: editor.state.selection.to }
      const empty = sel.from === sel.to // nothing highlighted
      const c = editor.chain()
      if (savedSel.current) { c.setTextSelection(savedSel.current); savedSel.current = null }
      if (cmd === 'fontName') c.setFontFamily(val).run()
      else if (cmd === 'foreColor') c.setColor(val).run()
      else if (cmd === 'size') c.setFontSize(`${val * scale}px`).run()
      else if (cmd === 'bold') c.toggleBold().run()
      else if (cmd === 'italic') c.toggleItalic().run()
      else if (cmd === 'applyStyle') {
        // eyedropper: the picked text's complete style in one transaction — with NOTHING selected,
        // apply it to the whole editor (no need to select the text first)
        let ch = empty ? c.selectAll() : c
        ch = ch.setFontFamily(val.family).setFontSize(`${val.sizePx * scale}px`).setColor(val.color)
        ch = val.bold ? ch.setBold() : ch.unsetBold()
        ch = val.italic ? ch.setItalic() : ch.unsetItalic()
        ch.run()
      }
    }
  }), [editor, scale])

  commitRef.current = () => {
    const root = boxRef.current?.querySelector('.ProseMirror')
    const pageEl = boxRef.current?.closest('.pdfed__page')
    const lines = root && pageEl ? parseRuns(root, pageEl, scale) : []
    if (lines.length) onCommit(lines)
    else onCancel() // nothing typed → just close
  }

  // commit ONLY when clicking inside the PDF page area (the viewport), never on the toolbars/panels:
  // clicking the top toolbar (font, B/I, size, colour) must RESTYLE the selected text, not close the
  // editor. Editing ends only by clicking on the page itself (or Escape to cancel).
  useEffect(() => {
    const down = (e) => {
      if (pipetteRef.current) return
      const t = e.target
      if (!(t instanceof Element)) return
      if (t.closest('.pdfed__rte')) return // inside the editor
      if (t.closest('.pdfed__viewport')) commitRef.current() // a click on the page → commit
    }
    window.addEventListener('mousedown', down, true)
    return () => window.removeEventListener('mousedown', down, true)
  }, [])

  return (
    <div
      ref={boxRef}
      className="pdfed__rte"
      style={{
        left: x * scale + (adj?.dx || 0),
        top: y * scale + (adj?.dy || 0),
        // edit mode: invisible for the one frame before the alignment measure lands (no jump flash)
        visibility: anchorLeft !== undefined && !adj ? 'hidden' : undefined
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel() } e.stopPropagation() }}
    >
      {/* the editor's own mini-bar — a home for style tools (first: the eyedropper) */}
      <div className="pdfed__rte-bar">
        <button
          className={'pdfed__rte-btn' + (pipette ? ' is-active' : '')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onPipette}
          title="Pick style from any text on the page"
        >
          <PipetteIcon />
        </button>
      </div>
      <EditorContent
        className="pdfed__rte-ed"
        editor={editor}
        style={{
          fontFamily: font, // ready-made CSS list: "PdfFont", "SystemLookalike"
          color,
          fontSize: size * scale,
          fontWeight: bold ? 'bold' : 'normal',
          fontStyle: italic ? 'italic' : 'normal',
          lineHeight,
          letterSpacing: letterSpacing * scale
        }}
      />
    </div>
  )
})

export default RichTextEditor
