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
const ASCENT = 0.8 // baseline ≈ rect.top + fontSize * ASCENT (CSS font box approximation)

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
          baseline: +((r.top - pr.top) / scale + size * ASCENT).toFixed(2)
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

const RichTextEditor = forwardRef(function RichTextEditor({ x, y, scale, font, color, size = 12, bold = false, italic = false, lineHeight = 1.25, letterSpacing = 0, pipette = false, initialHTML, anchorLeft, anchorTop, onPipette, onCommit, onCancel }, ref) {
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
      let r = null
      const walk = (el) => {
        for (const n of el.childNodes) {
          if (r) return
          if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) {
            const rg = document.createRange()
            rg.selectNodeContents(n)
            r = rg.getClientRects()[0] || null
          } else if (n.childNodes) walk(n)
        }
      }
      walk(prose)
      const pr = pageEl.getBoundingClientRect()
      const cur = r || prose.getBoundingClientRect() // empty editor → align the prose box itself
      setAdj({ dx: anchorLeft * scale - (cur.left - pr.left), dy: anchorTop * scale - (cur.top - pr.top) })
    })
    return () => cancelAnimationFrame(id)
  }, [editor, adj, anchorLeft, anchorTop, scale])

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
