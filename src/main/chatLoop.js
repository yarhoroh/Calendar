import { buildSystem, buildRefresh } from './prompt'
import { extractGetNotes, fetchNotesText } from './notesTool'

const MAX_STEPS = 4
// the reply "promised" to do something (so it should have emitted an action)
const PROMISES = /напомн|нагад|remind|постав|добав|add(ed|ing)?\b|schedul|заплан|буду|will |готов|done|видал|удал|delet|створ|create/i
const hasBlock = (t) => /```calendar/i.test(t || '')

// Run one user turn against an engine, resolving getNotes tool requests by
// fetching from the DB and feeding them back, until the engine gives a real
// answer. `sendOne(text)` sends one message to the live session and resolves
// { ok, text }. `isFresh` = first turn of the session (full preamble vs refresh).
export async function chatLoop({ sendOne, isFresh, ctx, userMsg, images }) {
  let text = `${isFresh ? buildSystem(ctx) : buildRefresh(ctx)}\n\n${userMsg}`
  for (let i = 0; i < MAX_STEPS; i++) {
    // images ride along only with the first turn (the one carrying the user msg)
    const reply = await sendOne(text, i === 0 ? images : null)
    if (!reply?.ok) return reply
    const req = extractGetNotes(reply.text)
    if (!req) {
      // weak models sometimes "agree" in words but forget the action block —
      // if the reply promised something yet emitted no block, force it once
      if (!hasBlock(reply.text) && PROMISES.test(`${userMsg} ${reply.text}`)) {
        const forced = await sendOne(
          'If the user\'s request needs a calendar action (addNote / addAiTask / delete / etc.), output ONLY the ```calendar [...] block for it now — no other text. If nothing is truly needed, output ```calendar []```.'
        )
        const m = forced?.ok && forced.text.match(/```calendar[\s\S]*?```/i)
        if (m) return { ok: true, text: `${reply.text}\n${m[0]}` }
      }
      return reply
    }
    text = `Notes for ${req.label}:\n${fetchNotesText(req)}\n\nNow answer the user's request using these notes. Do not call getNotes again for the same range.`
  }
  return sendOne('Answer the user now without requesting more notes.')
}
