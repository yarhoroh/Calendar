import { buildSystem, buildRefresh } from './prompt'
import { extractGetNotes, fetchNotesText } from './notesTool'

const MAX_STEPS = 4

// Run one user turn against an engine, resolving getNotes tool requests by
// fetching from the DB and feeding them back, until the engine gives a real
// answer. `sendOne(text)` sends one message to the live session and resolves
// { ok, text }. `isFresh` = first turn of the session (full preamble vs refresh).
export async function chatLoop({ sendOne, isFresh, ctx, userMsg }) {
  let text = `${isFresh ? buildSystem(ctx) : buildRefresh(ctx)}\n\n${userMsg}`
  for (let i = 0; i < MAX_STEPS; i++) {
    const reply = await sendOne(text)
    if (!reply?.ok) return reply
    const req = extractGetNotes(reply.text)
    if (!req) return reply
    text = `Notes for ${req.label}:\n${fetchNotesText(req)}\n\nNow answer the user's request using these notes. Do not call getNotes again for the same range.`
  }
  return sendOne('Answer the user now without requesting more notes.')
}
