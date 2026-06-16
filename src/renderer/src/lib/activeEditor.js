// Bridge to the note editor that's currently open, so the AI can be "live" in
// it: read what the user is editing / has selected, and apply edits straight
// into the open Tiptap editor. A single editor is active at a time.

let editor = null
let meta = {} // { id, day }

export function setActiveEditor(ed, m) {
  editor = ed
  meta = m || {}
}
export function clearActiveEditor(ed) {
  if (editor === ed) {
    editor = null
    meta = {}
  }
}
export const getActiveEditor = () => editor
export const getActiveMeta = () => meta

// current full content + selected fragment (plain) of the open note
export function activeContext() {
  if (!editor) return null
  const { from, to } = editor.state.selection
  const selection = from === to ? '' : editor.state.doc.textBetween(from, to, '\n')
  return { html: editor.getHTML(), text: editor.getText(), selection, ...meta }
}

// edit operations applied to the open editor (html or plain text)
export function replaceSelection(content) {
  return !!editor && editor.chain().focus().insertContent(content).run()
}
export function appendToNote(content) {
  return !!editor && editor.chain().focus('end').insertContent(content).run()
}
export function setNoteContent(content) {
  return !!editor && editor.chain().focus().setContent(content).run()
}
