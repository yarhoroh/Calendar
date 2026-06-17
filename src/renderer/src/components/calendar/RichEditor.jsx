import { useEffect, useReducer, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import RichImage from '../../lib/richImage'
import { setActiveEditor, clearActiveEditor } from '../../lib/activeEditor'
import './RichEditor.css'

// Modern rich-text note editor (Tiptap). Headless, so the toolbar is ours.
// Images are stored inline as base64 and can be resized by dragging their
// handles. `onReady(editor)` hands the instance to the parent to read HTML/text.
export default function RichEditor({ initialHtml, onReady, meta }) {
  const editorRef = useRef(null)
  const [, force] = useReducer((x) => x + 1, 0) // re-render the toolbar on selection change

  // Insert an image, downscaled so a huge phone photo doesn't freeze the editor
  // (and doesn't bloat the note in the DB). Small images / transparent PNGs are
  // kept untouched so screenshots stay crisp.
  const MAX_SIDE = 1280
  const insertSrc = (src) => editorRef.current?.chain().focus().setImage({ src }).run()
  const addImageFile = (file) => {
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      const src = reader.result
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height))
        // already small enough → keep the original (preserves PNG transparency)
        if (scale === 1 && file.size < 600_000) return insertSrc(src)
        const w = Math.round(img.width * scale)
        const h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        insertSrc(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.onerror = () => insertSrc(src) // not decodable here? fall back to raw
      img.src = src
    }
    reader.readAsDataURL(file)
  }

  const editor = useEditor({
    extensions: [StarterKit, RichImage],
    content: initialHtml || '',
    autofocus: 'end',
    editorProps: {
      handlePaste: (_view, event) => {
        const item = [...(event.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'))
        if (item) {
          addImageFile(item.getAsFile())
          return true
        }
        return false
      },
      handleDrop: (view, event) => {
        // internal node move (dragging an image to a new spot) → let ProseMirror
        // reposition it natively
        if (view.dragging) return false
        const files = [...(event.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'))
        if (files.length) {
          event.preventDefault()
          files.forEach(addImageFile)
          return true
        }
        return false
      }
    }
  })

  useEffect(() => {
    editorRef.current = editor
    if (!editor) return
    onReady?.(editor)
    setActiveEditor(editor, meta) // the AI can read/edit the open note live
    // coalesce toolbar re-renders into one per frame — resizing an image fires a
    // flood of transactions, and re-rendering on each made dragging janky
    let raf = 0
    const onTx = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        force()
      })
    }
    editor.on('transaction', onTx)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      editor.off('transaction', onTx)
      clearActiveEditor(editor)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  const pickImage = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => input.files?.[0] && addImageFile(input.files[0])
    input.click()
  }

  const run = (fn) => (e) => {
    e.preventDefault() // keep the editor selection/focus
    if (editor) fn(editor.chain().focus())
  }
  const active = (name, attrs) => (editor?.isActive(name, attrs) ? ' is-active' : '')

  return (
    <div className="rich-editor">
      <div className="rich-editor__toolbar">
        <button className={'re-btn' + active('heading', { level: 1 })} title="H1" onMouseDown={run((c) => c.toggleHeading({ level: 1 }).run())}>H1</button>
        <button className={'re-btn' + active('heading', { level: 2 })} title="H2" onMouseDown={run((c) => c.toggleHeading({ level: 2 }).run())}>H2</button>
        <span className="re-sep" />
        <button className={'re-btn' + active('bold')} title="Bold" onMouseDown={run((c) => c.toggleBold().run())}><b>B</b></button>
        <button className={'re-btn' + active('italic')} title="Italic" onMouseDown={run((c) => c.toggleItalic().run())}><i>I</i></button>
        <button className={'re-btn' + active('underline')} title="Underline" onMouseDown={run((c) => c.toggleUnderline().run())}><u>U</u></button>
        <span className="re-sep" />
        <button className={'re-btn' + active('bulletList')} title="Bullet list" onMouseDown={run((c) => c.toggleBulletList().run())}>•</button>
        <button className={'re-btn' + active('orderedList')} title="Numbered list" onMouseDown={run((c) => c.toggleOrderedList().run())}>1.</button>
        <span className="re-sep" />
        <button className="re-btn" title="Image" onMouseDown={(e) => { e.preventDefault(); pickImage() }}>🖼</button>
      </div>
      <EditorContent className="rich-editor__content" editor={editor} />
    </div>
  )
}
