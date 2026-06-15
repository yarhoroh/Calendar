import api from './api'
import { newItem } from '../hooks/useDayItems'

// Show the board/day a mutated note lives on.
const navTo = (onCommand, date) =>
  date === 'everyday'
    ? onCommand?.({ kind: 'everyday' })
    : date === 'general'
      ? onCommand?.({ kind: 'general' })
      : onCommand?.({ kind: 'goto', date })

// Pull a ```calendar [...] ``` action block out of the model's reply.
export function extractActions(text) {
  const m = text.match(/```calendar\s*([\s\S]*?)```/i)
  if (!m) return { text: text.trim(), actions: [] }
  let actions = []
  try {
    const parsed = JSON.parse(m[1].trim())
    actions = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    // ignore malformed action block
  }
  return { text: text.replace(m[0], '').trim(), actions }
}

// Execute one action the AI emitted. `onCommand` drives the calendar UI
// (goto/today/everyday/expand); the rest mutate notes, voice, memory or tasks.
export async function execAction(a, onCommand) {
  if (!a || !a.action) return
  if (a.action === 'goto' && a.date) return onCommand?.({ kind: 'goto', date: a.date })
  if (a.action === 'today') return onCommand?.({ kind: 'today' })
  if (a.action === 'everyday') return onCommand?.({ kind: 'everyday' })
  if (a.action === 'general') return onCommand?.({ kind: 'general' })
  if (a.action === 'expand') return onCommand?.({ kind: 'expand', date: a.date })
  if (a.action === 'speak' && a.text) return api.ttsSpeak?.({ text: a.text, lang: a.lang || 'uk' })
  if (a.action === 'remember' && a.text) return api.addMemory?.(a.text)
  if (a.action === 'forget' && a.id) return api.deleteMemory?.(a.id)
  if (a.action === 'addAiTask' && a.at && a.text) return api.addAiTask?.({ at: a.at, text: a.text })
  if (a.action === 'deleteAiTask' && a.id) return api.deleteAiTask?.(a.id)
  if (a.action === 'openFile' && a.id) return api.openAttachment?.(a.id)
  if (a.action === 'attachFile' && a.noteId && a.path) return api.addAttachmentPath?.(a.noteId, a.path)

  if ((a.action === 'addNote' || a.action === 'addReminder') && a.date) {
    const arr = (await api.getItems?.(a.date)) || []
    const item = { ...newItem(a.text || ''), title: a.title || null, time: a.time || null }
    api.saveItems?.(a.date, [...arr, item])
    if (a.time) {
      api.setReminder?.({
        id: item.id,
        when: a.time,
        dayKey: a.date,
        title: a.title || 'Calendar',
        body: a.text || ''
      })
    }
    navTo(onCommand, a.date)
  }
  if (a.action === 'reorder' && a.date && Array.isArray(a.ids)) {
    const arr = (await api.getItems?.(a.date)) || []
    const byId = new Map(arr.map((it) => [it.id, it]))
    const ordered = a.ids.map((id) => byId.get(id)).filter(Boolean)
    const rest = arr.filter((it) => !a.ids.includes(it.id))
    api.saveItems?.(a.date, [...ordered, ...rest])
    navTo(onCommand, a.date)
  }
  if (a.action === 'delete' && a.date && Array.isArray(a.ids)) {
    const arr = (await api.getItems?.(a.date)) || []
    const kept = arr.filter((it) => !a.ids.includes(it.id))
    a.ids.forEach((id) => api.clearReminder?.(id))
    api.saveItems?.(a.date, kept)
    navTo(onCommand, a.date)
  }
}
