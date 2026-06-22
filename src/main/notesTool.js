import { getItems, getItemsRange, allAttachments, importedEventIds } from './db'
import { formatNotes } from './prompt'
import { listEventsAllSelected } from './google'

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

// Pull inline base64 images out of notes' HTML so the model can actually SEE
// them (not just the text). Capped in count and size to keep the prompt sane.
const IMG_RE = /<img[^>]+src="data:([^";]+);base64,([^"]+)"/gi
function extractImages(rows, max = 4) {
  const out = []
  for (const r of rows) {
    if (out.length >= max) break
    IMG_RE.lastIndex = 0
    let m
    while ((m = IMG_RE.exec(r.html || '')) && out.length < max) {
      if (m[2].length < 2_000_000) out.push({ media_type: m[1], data: m[2] })
    }
  }
  return out
}

// ---- Google Calendar read tool (mirrors getNotes) -------------------------
export function extractGetGoogleEvents(text) {
  const m = (text || '').match(/```calendar\s*([\s\S]*?)```/i)
  if (!m) return null
  let actions = []
  try {
    const p = JSON.parse(m[1].trim())
    actions = Array.isArray(p) ? p : [p]
  } catch {
    return null
  }
  const g = actions.find((a) => a && a.action === 'listGoogleEvents')
  if (!g || !g.from) return null
  return { from: g.from, to: g.to || g.from }
}

// fetch selected-calendar events for a range and format them (with imported flag
// + composite id) so the model can answer or import without duplicates
export async function fetchGoogleEvents(req) {
  let events = []
  try {
    events = await listEventsAllSelected('all', req.from, `${req.to}T23:59:59`)
  } catch (e) {
    return `(could not read Google Calendar: ${e?.message || 'error'})`
  }
  if (!events.length) return '(no events in this range, or no Google account/calendars connected)'
  // an instance counts as imported by its own id OR its series id (a recurring
  // event imported once onto the "everyday" board), matching the Appointments tab
  const seriesGid = (e) => (e.recurringEventId ? `${e.account}:${e.calendarId}:${e.recurringEventId}` : null)
  const gids = []
  for (const e of events) {
    gids.push(e.googleEventId)
    const s = seriesGid(e)
    if (s) gids.push(s)
  }
  const imported = importedEventIds(gids)
  const byDay = {}
  for (const e of events) (byDay[e.day] = byDay[e.day] || []).push(e)
  return Object.keys(byDay)
    .sort()
    .map((day) => {
      const lines = byDay[day]
        .map((e) => {
          const when = e.allDay ? 'all-day' : e.time
          const s = seriesGid(e)
          const tag = imported.has(e.googleEventId) || (s && imported.has(s)) ? ' [already imported]' : ''
          const loc = e.location ? ` @ ${e.location}` : ''
          // source = calendar name · account email, so the model knows exactly
          // where each event comes from (and can import a specific one by gid)
          return `  - ${when} ${e.title}${loc} [${e.calendarName} · ${e.account}]${e.recurring ? ' (recurring)' : ''} <gid:${e.googleEventId}>${tag}`
        })
        .join('\n')
      return `${day}:\n${lines}`
    })
    .join('\n')
}

// Fetch the requested notes (with attachments). Returns the formatted text plus
// any inline images, so the caller can show the images to the model.
export function fetchNotes(req) {
  const rows = req.board
    ? (getItems(req.board) || []).map((r) => ({ ...r, day: req.board }))
    : getItemsRange(req.from, req.to || req.from) || []
  const byNote = {}
  for (const a of allAttachments()) (byNote[a.note_id] = byNote[a.note_id] || []).push({ id: a.id, name: a.name })
  for (const r of rows) r.files = byNote[r.id] || []
  return { text: formatNotes(rows), images: extractImages(rows) }
}
