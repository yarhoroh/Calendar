import { useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style'

// Inline rich-text editor for a VARIABLE's value — the app's Tiptap engine (same as the add-text
// editor), but living in the side panel instead of on the page. Its content is seeded from the
// occurrence's own runs (styles + line breaks), edited freely (multi-line, bold/italic per span),
// and read back as structured lines: [[{ text, bold, italic, family, size, color }, …], …].
// Position is NOT taken from DOM here — the caller re-flows these lines from each occurrence's anchor.

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// lines[] → HTML (one <p> per line, a styled <span> per run) that Tiptap parses back into marks
export function linesToHtml(lines) {
  const ls = lines && lines.length ? lines : [[]]
  return ls.map((runs) => {
    if (!runs || !runs.length) return '<p></p>'
    return '<p>' + runs.map((r) => {
      const style = [r.family && `font-family:'${r.family}'`, r.size && `font-size:${r.size}px`, r.color && `color:${r.color}`].filter(Boolean).join(';')
      let t = `<span style="${style}">${escapeHtml(r.text || '')}</span>`
      if (r.italic) t = `<em>${t}</em>`
      if (r.bold) t = `<strong>${t}</strong>`
      return t
    }).join('') + '</p>'
  }).join('')
}

// editor doc → lines of styled runs (each block/paragraph is a line; empty blocks = blank lines)
function extractLines(editor) {
  const lines = []
  editor.state.doc.forEach((block) => {
    const runs = []
    block.forEach((node) => {
      if (!node.isText) return
      const marks = node.marks || []
      const has = (n) => marks.some((m) => m.type.name === n)
      const ts = marks.find((m) => m.type.name === 'textStyle')?.attrs || {}
      runs.push({
        text: node.text || '',
        bold: has('bold'),
        italic: has('italic'),
        color: ts.color || undefined,
        family: ts.fontFamily ? String(ts.fontFamily).split(',')[0].replace(/["']/g, '').trim() : undefined,
        size: ts.fontSize ? parseFloat(ts.fontSize) : undefined
      })
    })
    lines.push(runs)
  })
  return lines
}

export default function VariableEditor({ content, onChange }) {
  const editor = useEditor({ extensions: [StarterKit, TextStyle, Color, FontFamily, FontSize], content: linesToHtml(content) })
  useEffect(() => {
    if (!editor) return
    const h = () => onChange(extractLines(editor))
    editor.on('update', h)
    return () => editor.off('update', h)
  }, [editor, onChange])
  return (
    <div className="pdfed__var-rte">
      <EditorContent editor={editor} />
    </div>
  )
}
