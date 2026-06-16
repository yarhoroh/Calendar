import { getItems, getItemsRange, allAttachments } from './db'
import { formatNotes } from './prompt'

// Find a getNotes request inside a model reply's ```calendar block. Returns a
// normalized { board, label } | { from, to, label } or null.
export function extractGetNotes(text) {
  const m = (text || '').match(/```calendar\s*([\s\S]*?)```/i)
  if (!m) return null
  let actions = []
  try {
    const p = JSON.parse(m[1].trim())
    actions = Array.isArray(p) ? p : [p]
  } catch {
    return null
  }
  const g = actions.find((a) => a && a.action === 'getNotes')
  if (!g) return null
  if (g.board === 'everyday' || g.board === 'general') return { board: g.board, label: g.board }
  const from = g.from || g.date
  const to = g.to || g.from || g.date
  if (!from) return null
  return { from, to, label: from === to ? from : `${from}..${to}` }
}

// Fetch + format the requested notes (with attachments) to feed back to the model.
export function fetchNotesText(req) {
  const rows = req.board
    ? (getItems(req.board) || []).map((r) => ({ ...r, day: req.board }))
    : getItemsRange(req.from, req.to || req.from) || []
  const byNote = {}
  for (const a of allAttachments()) (byNote[a.note_id] = byNote[a.note_id] || []).push({ id: a.id, name: a.name })
  for (const r of rows) r.files = byNote[r.id] || []
  return formatNotes(rows)
}
