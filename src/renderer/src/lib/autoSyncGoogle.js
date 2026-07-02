import api from './api'
import { startOfToday, addDays, dateKey } from './dates'
import { importGoogleEvent, importGoogleEventEveryday, syncImportedNote } from './importGoogle'

// Pull the auto-sync calendars (set per-calendar in Settings) into local notes:
// import events we don't have yet, and update linked notes whose Google event
// changed. One-way (Google → local); window = today … +60 days. Driven by the
// main-process timer (google:autosync) — interval is configurable in Settings.
const WINDOW_DAYS = 60
let running = false

export async function runGoogleAutoSync() {
  if (running) return
  running = true
  try {
    const cals = (await api.google?.autoSyncCalendars?.()) || []
    if (!cals.length) return
    const wanted = new Set(cals.map((c) => `${c.account}|${c.id}`))
    const from = dateKey(startOfToday())
    const to = dateKey(addDays(startOfToday(), WINDOW_DAYS))
    const events = ((await api.google?.listEvents?.(from, to)) || []).filter((e) =>
      wanted.has(`${e.account}|${e.calendarId}`)
    )
    const doneSeries = new Set()
    const liveGids = new Set() // every event id currently present on Google (incl. series ids)
    for (const ev of events) {
      liveGids.add(ev.googleEventId)
      if (ev.recurringEventId) liveGids.add(`${ev.account}:${ev.calendarId}:${ev.recurringEventId}`)
      if (ev.imported) {
        // a recurring series imported as ONE "everyday" note appears here once per
        // instance — sync it a single time (its recurrence covers all occurrences)
        if (ev.importedDay === 'everyday' && ev.recurringEventId) {
          if (doneSeries.has(ev.recurringEventId)) continue
          doneSeries.add(ev.recurringEventId)
        }
        await syncImportedNote(ev) // reflect Google changes onto the linked note
      } else if (ev.recurring) {
        if (doneSeries.has(ev.recurringEventId)) continue
        doneSeries.add(ev.recurringEventId)
        const r = await importGoogleEventEveryday(ev)
        if (r?.unsupported) await importGoogleEvent(ev) // complex repeat → single day
      } else {
        await importGoogleEvent(ev)
      }
    }

    // deletion sync: an imported note whose Google event has vanished is removed too.
    // SAFE by design: only notes with an import mark from an auto-sync calendar (never
    // locally-authored ones), only dated notes inside the window (or everyday series),
    // and only after eventExists confirms a real 404/cancelled (transient errors keep it).
    const prefixes = cals.map((c) => `${c.account}:${c.id}:`)
    const marks = (await api.google?.imports?.()) || []
    for (const im of marks) {
      if (!im.gid || liveGids.has(im.gid) || !prefixes.some((p) => im.gid.startsWith(p))) continue
      if (im.day !== 'everyday' && (im.day < from || im.day > to)) continue // outside the window → can't judge
      if (await api.google?.eventExists?.(im.gid)) continue // still there (moved out of window / series ended)
      await api.google?.unimport?.({ googleEventId: im.gid }) // removes the note, clears its reminder, unmarks
    }
  } finally {
    running = false
  }
}
