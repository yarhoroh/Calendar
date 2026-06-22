import { buildSystem, buildRefresh } from './prompt'
import { extractGetNotes, fetchNotes, extractGetGoogleEvents, fetchGoogleEvents } from './notesTool'

// Hard backstop only — NOT a functional cap. Real chains need just a few read
// steps; this guards against a runaway model. The real loop-breaker is the
// duplicate-request guard below (stop feeding the same data twice).
const MAX_STEPS = 16
// the reply "promised" to do something (so it should have emitted an action)
const PROMISES = /напомн|нагад|remind|постав|добав|add(ed|ing)?\b|schedul|заплан|буду|will |готов|done|видал|удал|delet|створ|create/i
const hasBlock = (t) => /```calendar/i.test(t || '')

// Run one user turn against an engine, resolving getNotes tool requests by
// fetching from the DB and feeding them back, until the engine gives a real
// answer. `sendOne(text)` sends one message to the live session and resolves
// { ok, text }. `isFresh` = first turn of the session (full preamble vs refresh).
export async function chatLoop({ sendOne, isFresh, ctx, userMsg, images }) {
  let text = `${isFresh ? buildSystem(ctx) : buildRefresh(ctx)}\n\n${userMsg}`
  let pendingImages = images // images for the next sendOne (user's first, then note images)
  const seen = new Set() // data requests already answered — stops same-call loops
  for (let i = 0; i < MAX_STEPS; i++) {
    const reply = await sendOne(text, pendingImages)
    pendingImages = null
    if (!reply?.ok) return reply
    const req = extractGetNotes(reply.text)
    const gReq = req ? null : extractGetGoogleEvents(reply.text)
    if (!req && !gReq) {
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
    // duplicate-request guard: if the model re-asks for data it has already been
    // given, stop feeding it and force an answer — this is the real loop-breaker
    // (MAX_STEPS is just a backstop). Distinct ranges still chain freely.
    const sig = (req ? 'n:' : 'g:') + JSON.stringify(req || gReq)
    if (seen.has(sig)) {
      return sendOne('You already have that data above. Answer the user now without requesting it again.')
    }
    seen.add(sig)
    if (gReq) {
      // Google Calendar read tool — feed events back so the model can answer or import
      const gtext = await fetchGoogleEvents(gReq)
      text = `Google Calendar events for ${gReq.from}..${gReq.to}:\n${gtext}\n\nNow answer the user's request, or import what they asked with importGoogleEvents. Do not call listGoogleEvents again for the same range.`
      pendingImages = null
    } else {
      // feed the notes back — including any inline images, so the model can SEE
      // pictures inside notes, not just their text
      const { text: notesText, images: notesImages } = fetchNotes(req)
      text = `Notes for ${req.label}:\n${notesText}\n\nNow answer the user's request using these notes${notesImages.length ? ' (images from the notes are attached — look at them)' : ''}. Do not call getNotes again for the same range.`
      pendingImages = notesImages.length ? notesImages : null
    }
  }
  return sendOne('Answer the user now without requesting more notes.')
}
