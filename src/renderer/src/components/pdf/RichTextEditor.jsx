import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
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

const RichTextEditor = forwardRef(function RichTextEditor({ x, y, scale, font, color, size = 12, bold = false, italic = false, lineHeight = 1.25, letterSpacing = 0, pipette = false, onPipette, onCommit, onCancel }, ref) {
  const boxRef = useRef(null)
  const savedSel = useRef(null) // selection captured before a toolbar <select> steals focus
  const commitRef = useRef(() => {})
  const pipetteRef = useRef(pipette)
  pipetteRef.current = pipette

  const editor = useEditor({
    extensions: [StarterKit, TextStyle, Color, FontFamily, FontSize],
    content: '',
    autofocus: 'end'
  })

  // The PDF toolbar drives the editor through this handle. grabSel() is called on the toolbar
  // select's mousedown (a native select collapses the DOM selection on blur — same trick as the
  // notes editor). exec() deliberately does NOT focus the editor: commands apply to the stored
  // selection anyway, and the toolbar input the user is typing in keeps its focus.
  useImperativeHandle(ref, () => ({
    grabSel: () => { if (editor) savedSel.current = { from: editor.state.selection.from, to: editor.state.selection.to } },
    exec: (cmd, val) => {
      if (!editor) return
      const c = editor.chain()
      if (savedSel.current) { c.setTextSelection(savedSel.current); savedSel.current = null }
      if (cmd === 'fontName') c.setFontFamily(val).run()
      else if (cmd === 'foreColor') c.setColor(val).run()
      else if (cmd === 'size') c.setFontSize(`${val * scale}px`).run()
      else if (cmd === 'bold') c.toggleBold().run()
      else if (cmd === 'italic') c.toggleItalic().run()
      else if (cmd === 'applyStyle') {
        // eyedropper: the picked text's complete style in one transaction
        let ch = c.setFontFamily(val.family).setFontSize(`${val.sizePx * scale}px`).setColor(val.color)
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

  // click anywhere outside the editor — except the toolbar and its popups — commits.
  // While the eyedropper is armed, page clicks PICK a style instead of committing.
  useEffect(() => {
    const down = (e) => {
      if (pipetteRef.current) return
      const t = e.target
      if (!(t instanceof Element)) return
      if (t.closest('.pdfed__rte') || t.closest('.pdfed__toolbar') || t.closest('.pdfed__colorpanel') || t.closest('.ctx-menu')) return
      commitRef.current()
    }
    window.addEventListener('mousedown', down, true)
    return () => window.removeEventListener('mousedown', down, true)
  }, [])

  return (
    <div
      ref={boxRef}
      className="pdfed__rte"
      style={{ left: x * scale, top: y * scale }}
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
