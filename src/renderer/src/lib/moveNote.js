import api from './api'

// Move a note (drag payload {id, fromDay, item}) to a target day key, which can
// be a board ('everyday' / 'general') or a date ('YYYY-MM-DD'). Source removal
// happens first because the note id is a global primary key and must not live
// in two places at once.
export async function moveNote(payload, target) {
  if (!payload || payload.fromDay === target) return

  const src = (await api.getItems?.(payload.fromDay)) || []
  api.saveItems?.(payload.fromDay, src.filter((i) => i.id !== payload.id))

  const dest = (await api.getItems?.(target)) || []
  const it = { ...payload.item }
  if (target === 'general') it.time = null // the general board has no reminders
  if (!dest.some((i) => i.id === it.id)) api.saveItems?.(target, [...dest, it])

  // reschedule the reminder for its new home
  if (target === 'general') {
    api.clearReminder?.(payload.id)
  } else if (it.time) {
    api.setReminder?.({
      id: it.id,
      when: it.time,
      dayKey: target,
      title: it.title || 'Calendar',
      body: it.text || ''
    })
  }
}
