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

// Execute one action the AI emitted; returns { ok, error } so the caller can
// tell the model whether it worked. `onCommand` drives the calendar UI.
export async function execAction(a, onCommand, channel) {
  if (!a || !a.action) return { ok: true }
  try {
    switch (a.action) {
      case 'goto':
        if (a.date) onCommand?.({ kind: 'goto', date: a.date })
        return { ok: true }
      case 'today':
        onCommand?.({ kind: 'today' })
        return { ok: true }
      case 'everyday':
        onCommand?.({ kind: 'everyday' })
        return { ok: true }
      case 'general':
        onCommand?.({ kind: 'general' })
        return { ok: true }
      case 'expand':
        onCommand?.({ kind: 'expand', date: a.date })
        return { ok: true }
      case 'speak':
        if (a.text) await api.ttsSpeak?.({ text: a.text, lang: a.lang || 'uk' })
        return { ok: true }
      case 'notify':
        if (a.text) api.notify?.(a.text)
        return { ok: true }
      case 'remember':
        if (a.text) await api.addMemory?.(a.text)
        return { ok: true }
      case 'forget':
        if (a.id) await api.deleteMemory?.(a.id)
        return { ok: true }
      case 'addAiTask': {
        if (!a.text || (!a.at && !a.every))
          return { ok: false, error: 'addAiTask needs text and either a time (at) or an interval (every)' }
        const r = await api.addAiTask?.({ at: a.at, text: a.text, every: a.every, from: a.from, to: a.to, channel })
        return r ? { ok: true } : { ok: false, error: 'task was not created' }
      }
      case 'deleteAiTask':
        if (a.id) await api.deleteAiTask?.(a.id)
        return { ok: true }
      case 'setModel':
        if (a.model) await api.setModel?.(a.model, a.reasoning)
        return { ok: true }
      case 'openFile':
        if (a.id) await api.openAttachment?.(a.id)
        return { ok: true }
      case 'attachFile': {
        if (!a.noteId || !a.path) return { ok: false, error: 'attachFile needs noteId and an absolute path' }
        const r = await api.addAttachmentPath?.(a.noteId, a.path)
        return r ? { ok: true } : { ok: false, error: 'attach failed (file not found?)' }
      }
      case 'addNote':
      case 'addReminder': {
        if (!a.date) return { ok: false, error: 'addNote needs a date' }
        const arr = (await api.getItems?.(a.date)) || []
        const item = { ...newItem(a.text || ''), title: a.title || null, time: a.time || null }
        api.saveItems?.(a.date, [...arr, item])
        if (a.time)
          api.setReminder?.({ id: item.id, when: a.time, dayKey: a.date, title: a.title || 'Calendar', body: a.text || '' })
        navTo(onCommand, a.date)
        return { ok: true }
      }
      case 'edit':
      case 'editNote':
      case 'updateNote': {
        if (!a.date || !a.id) return { ok: false, error: 'editNote needs date and id' }
        const arr = (await api.getItems?.(a.date)) || []
        const idx = arr.findIndex((it) => it.id === a.id)
        if (idx < 0) return { ok: false, error: 'note not found on that date' }
        const it = arr[idx]
        // patch only the fields the model actually sent; keep the rest
        const patched = {
          ...it,
          title: a.title !== undefined ? a.title : it.title,
          text: a.text !== undefined ? a.text : it.text,
          time: a.time !== undefined ? a.time : it.time,
          status: a.status !== undefined ? a.status : it.status
        }
        arr[idx] = patched
        api.saveItems?.(a.date, arr)
        if (a.time !== undefined) {
          if (a.time)
            api.setReminder?.({ id: it.id, when: a.time, dayKey: a.date, title: patched.title || 'Calendar', body: patched.text || '' })
          else api.clearReminder?.(it.id)
        }
        navTo(onCommand, a.date)
        return { ok: true }
      }
      case 'reorder': {
        if (!a.date || !Array.isArray(a.ids)) return { ok: false, error: 'reorder needs date and ids' }
        const arr = (await api.getItems?.(a.date)) || []
        const byId = new Map(arr.map((it) => [it.id, it]))
        const ordered = a.ids.map((id) => byId.get(id)).filter(Boolean)
        const rest = arr.filter((it) => !a.ids.includes(it.id))
        api.saveItems?.(a.date, [...ordered, ...rest])
        navTo(onCommand, a.date)
        return { ok: true }
      }
      case 'delete': {
        if (!a.date || !Array.isArray(a.ids)) return { ok: false, error: 'delete needs date and ids' }
        const arr = (await api.getItems?.(a.date)) || []
        const kept = arr.filter((it) => !a.ids.includes(it.id))
        a.ids.forEach((id) => api.clearReminder?.(id))
        api.saveItems?.(a.date, kept)
        navTo(onCommand, a.date)
        return { ok: true }
      }
      default:
        return { ok: true } // getNotes etc. are handled elsewhere
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// Run all actions; if any failed, tell the model so it reports the truth to the
// user (returns the model's honest reply text, or a plain ⚠ summary, or null).
export async function runActions(actions, onCommand, channel) {
  const fails = []
  for (const a of actions) {
    const r = await execAction(a, onCommand, channel)
    if (r && r.ok === false) fails.push(`${a.action}: ${r.error || 'failed'}`)
  }
  if (!fails.length) return null
  const fb = await api.aiSend?.({
    messages: [
      {
        role: 'user',
        content: `[action result] These actions FAILED:\n${fails.join('\n')}\nTell the user briefly it didn't work (and why if useful). Do NOT claim success and do NOT repeat the same failing action.`
      }
    ]
  })
  if (!fb?.ok) return `⚠ ${fails.join('; ')}`
  return extractActions(fb.text).text || `⚠ ${fails.join('; ')}`
}
