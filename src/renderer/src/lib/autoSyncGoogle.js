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
    for (const ev of events) {
      if (ev.imported) {
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
  } finally {
    running = false
  }
}
