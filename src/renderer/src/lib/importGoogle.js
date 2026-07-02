import api from './api'
import { newItem } from '../hooks/useDayItems'

// Turn a normalized Google event (from api.google.listEvents) into a note on its
// day. Reuses the exact addNote pattern (getItems → newItem → saveItems →
// setReminder) and records the import so it is never duplicated. Shared by the
// Appointments tab's Import button and the AI's importGoogleEvents action.

const esc = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')

function buildHtml(ev) {
  const parts = []
  if (ev.description) parts.push(`<p>${esc(ev.description)}</p>`)
  if (ev.location) parts.push(`<p>📍 ${esc(ev.location)}</p>`)
  return parts.join('')
}

// import a single occurrence onto its date (one-time event, or "this day only"
// of a recurring one)
export async function importGoogleEvent(ev, extra = null) {
  const day = ev.day
  const time = ev.allDay ? null : ev.time
  const html = buildHtml(ev)
  const text = [ev.description, ev.location].filter(Boolean).join('\n')
  const arr = (await api.getItems?.(day)) || []
  const item = {
    ...newItem(text),
    title: ev.title || null,
    time: time || null,
    html,
    collapsed: true, // imported notes arrive folded — click the title to expand
    googleEventId: ev.googleEventId, // email:calendarId:eventId — exact match key
    googleCalendar: ev.calendarName, // source calendar name (display)
    googleAccount: ev.account, // source Google account email
    ...(extra || {})
  }
  await api.saveItems?.(day, [...arr, item])
  if (time)
    api.setReminder?.({ id: item.id, when: time, dayKey: day, title: ev.title || 'Calendar', body: text })
  await api.google?.markImported?.({ gid: ev.googleEventId, noteId: item.id, day })
  return { ok: true, day }
}

// import a recurring series as ONE note on the "everyday" board (with its weekly
// or monthly repeat + time). Returns { ok:false, unsupported:true } for
// recurrences our everyday board can't express (yearly / every N weeks).
export async function importGoogleEventEveryday(ev) {
  if (!ev.recurringEventId) return importGoogleEvent(ev) // not actually recurring
  const rec = await api.google?.eventRecurrence?.(ev.account, ev.calendarId, ev.recurringEventId)
  if (!rec || !rec.supported) return { ok: false, unsupported: true }
  const seriesGid = `${ev.account}:${ev.calendarId}:${ev.recurringEventId}`
  const time = ev.allDay ? null : rec.time || ev.time
  const monthDays = Array.isArray(rec.monthDays) && rec.monthDays.length ? rec.monthDays : null
  const days = monthDays ? null : Array.isArray(rec.days) ? rec.days : []
  const html = buildHtml(ev)
  const text = [ev.description, ev.location].filter(Boolean).join('\n')
  const arr = (await api.getItems?.('everyday')) || []
  const item = {
    ...newItem(text),
    title: ev.title || null,
    time: time || null,
    days,
    monthDays,
    html,
    collapsed: true, // imported notes arrive folded — click the title to expand
    googleEventId: seriesGid, // the series id (not a single instance)
    googleCalendar: ev.calendarName,
    googleAccount: ev.account
  }
  await api.saveItems?.('everyday', [...arr, item])
  if (time)
    api.setReminder?.({ id: item.id, when: time, dayKey: 'everyday', title: ev.title || 'Calendar', body: text, days, monthDays })
  await api.google?.markImported?.({ gid: seriesGid, noteId: item.id, day: 'everyday' })
  return { ok: true, day: 'everyday' }
}

// compare two recurrence arrays ([] and null are the same "no explicit set")
const sameList = (a, b) =>
  (Array.isArray(a) && a.length ? a.join(',') : '') === (Array.isArray(b) && b.length ? b.join(',') : '')

// auto-sync a recurring series imported as ONE "everyday" note: pull the master's
// current time + recurrence (weekly days / monthly monthDays) and title/description,
// so a change made by anyone on the shared calendar propagates to this subscriber.
async function syncEverydaySeries(ev) {
  const seriesGid = `${ev.account}:${ev.calendarId}:${ev.recurringEventId}`
  const arr = (await api.getItems?.('everyday')) || []
  const idx = arr.findIndex((i) => i.googleEventId === seriesGid)
  if (idx < 0) return false
  const it = arr[idx]
  const rec = await api.google?.eventRecurrence?.(ev.account, ev.calendarId, ev.recurringEventId)
  if (!rec || !rec.supported) return false // recurrence no longer expressible as everyday → leave as-is
  const time = ev.allDay ? null : rec.time || ev.time
  const monthDays = Array.isArray(rec.monthDays) && rec.monthDays.length ? rec.monthDays : null
  const days = monthDays ? null : Array.isArray(rec.days) ? rec.days : []
  const text = [ev.description, ev.location].filter(Boolean).join('\n')
  const title = ev.title || null
  const curTime = it.time ? String(it.time).split('T')[1] || it.time : null
  if (
    it.title === title &&
    curTime === (time || null) &&
    (it.text || '') === text &&
    sameList(it.days, days) &&
    sameList(it.monthDays, monthDays)
  )
    return false
  arr[idx] = { ...it, title, time: time || null, days, monthDays, html: buildHtml(ev), text }
  await api.saveItems?.('everyday', arr)
  if (time)
    api.setReminder?.({ id: it.id, when: time, dayKey: 'everyday', title: title || 'Calendar', body: text, days, monthDays })
  else api.clearReminder?.(it.id)
  return true
}

// auto-sync: reflect a Google event's change onto the linked local note (Google is
// the source of truth). Handles a periodic "everyday" note (time + recurrence) and
// a dated note (title/time/text) — and, for a dated note, MOVES it to the new day
// when the event's date was changed. So edits by any subscriber propagate to all.
export async function syncImportedNote(ev) {
  const day = ev.importedDay
  if (!day) return false
  if (day === 'everyday') return syncEverydaySeries(ev)
  const arr = (await api.getItems?.(day)) || []
  const idx = arr.findIndex((i) => i.googleEventId === ev.googleEventId)
  if (idx < 0) return false
  const it = arr[idx]
  const time = ev.allDay ? null : ev.time // 'HH:mm' | null
  const text = [ev.description, ev.location].filter(Boolean).join('\n')
  const title = ev.title || null
  // compare meaningful fields; normalise the note's time to HH:mm so a Google
  // time change is detected regardless of how it's stored locally
  const curTime = it.time ? String(it.time).split('T')[1] || it.time : null
  const moved = !!ev.day && ev.day !== day // the event was moved to another date on Google
  if (!moved && it.title === title && curTime === (time || null) && (it.text || '') === text) return false
  const patched = { ...it, title, time: time || null, html: buildHtml(ev), text }
  if (moved) {
    // pull the note out of its old day and drop it onto the event's new day
    await api.saveItems?.(day, arr.filter((_, i) => i !== idx))
    const dst = (await api.getItems?.(ev.day)) || []
    await api.saveItems?.(ev.day, [...dst, patched])
    await api.google?.markImported?.({ gid: ev.googleEventId, noteId: it.id, day: ev.day }) // keep the import mark's day in sync
  } else {
    arr[idx] = patched
    await api.saveItems?.(day, arr)
  }
  const dayKey = moved ? ev.day : day
  if (time) api.setReminder?.({ id: it.id, when: time, dayKey, title: title || 'Calendar', body: text })
  else api.clearReminder?.(it.id)
  return true
}
