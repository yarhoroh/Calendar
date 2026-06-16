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
        return r ? { ok: true, result: { id: r.id } } : { ok: false, error: 'task was not created' }
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
        const item = { ...newItem(a.text || ''), title: a.title || null, time: a.time || null, folderId: a.folder || null }
        api.saveItems?.(a.date, [...arr, item])
        if (a.time)
          api.setReminder?.({ id: item.id, when: a.time, dayKey: a.date, title: a.title || 'Calendar', body: a.text || '' })
        navTo(onCommand, a.date)
        return { ok: true, result: { id: item.id } }
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
          status: a.status !== undefined ? a.status : it.status,
          folderId: a.folder !== undefined ? a.folder || null : it.folderId
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
      case 'addFolder': {
        if (!a.board || !a.name) return { ok: false, error: 'addFolder needs board (today/everyday/general) and name' }
        const r = await api.addFolder?.({ board: a.board, name: a.name, parentId: a.parent || null })
        return r ? { ok: true, result: { id: r.id } } : { ok: false, error: 'folder was not created' }
      }
      case 'renameFolder': {
        if (!a.id || !a.name) return { ok: false, error: 'renameFolder needs id and name' }
        const r = await api.renameFolder?.(a.id, a.name)
        return r?.ok ? { ok: true } : { ok: false, error: r?.error || 'rename failed' }
      }
      case 'moveFolder': {
        if (!a.id) return { ok: false, error: 'moveFolder needs id' }
        const r = await api.moveFolder?.(a.id, a.parent || null)
        return r?.ok ? { ok: true } : { ok: false, error: r?.error || 'move failed' }
      }
      case 'deleteFolder': {
        if (!a.id) return { ok: false, error: 'deleteFolder needs id' }
        const r = await api.deleteFolder?.(a.id)
        return r?.ok ? { ok: true } : { ok: false, error: r?.error || 'delete failed (not empty?)' }
      }
      case 'setNoteFolder': {
        if (!a.date || !Array.isArray(a.ids)) return { ok: false, error: 'setNoteFolder needs date and ids' }
        const arr = (await api.getItems?.(a.date)) || []
        const folderId = a.folder || null
        api.saveItems?.(
          a.date,
          arr.map((it) => (a.ids.includes(it.id) ? { ...it, folderId } : it))
        )
        navTo(onCommand, a.date)
        return { ok: true }
      }
      case 'addStatus': {
        if (!a.name) return { ok: false, error: 'addStatus needs a name' }
        const r = await api.addStatus?.({ name: a.name, color: a.color })
        return r ? { ok: true, result: { id: r.id } } : { ok: false, error: 'status was not created' }
      }
      case 'renameStatus': {
        if (!a.id || (!a.name && !a.color)) return { ok: false, error: 'renameStatus needs id and name and/or color' }
        const r = await api.updateStatus?.(a.id, { name: a.name, color: a.color })
        return r?.ok ? { ok: true } : { ok: false, error: r?.error || 'rename failed' }
      }
      case 'deleteStatus': {
        if (!a.id) return { ok: false, error: 'deleteStatus needs id' }
        const r = await api.deleteStatus?.(a.id)
        return r?.ok ? { ok: true } : { ok: false, error: 'delete failed' }
      }
      case 'setNoteStatus': {
        if (!a.date || !Array.isArray(a.ids) || !a.status) return { ok: false, error: 'setNoteStatus needs date, ids and status' }
        const arr = (await api.getItems?.(a.date)) || []
        api.saveItems?.(
          a.date,
          arr.map((it) => (a.ids.includes(it.id) ? { ...it, status: a.status } : it))
        )
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

const MAX_ROUNDS = 5
// actions that don't change data — no need to report their success back to the
// model (navigation, voice/toast, reads, model switch). Everything else (note &
// folder mutations, tasks, memory, attachments) is reported so the model knows
// it's done/failed and can run the next step of a multi-step task.
const NO_REPORT = new Set(['goto', 'today', 'everyday', 'general', 'expand', 'speak', 'notify', 'getNotes', 'openFile', 'setModel'])

// Run the actions the model emitted, then feed the OUTCOME back so it can either
// continue a multi-step task (e.g. it just created a folder and now needs the new
// id to file a note into it) or report a failure truthfully. Loops until the model
// stops emitting actions or we hit MAX_ROUNDS. Returns the model's follow-up text
// to show the user (or null if nothing more to say).
export async function runActions(actions, onCommand, channel) {
  const isTelegram = typeof channel === 'string' && channel.startsWith('telegram:')
  let pending = actions || []
  const texts = []

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (isTelegram) pending = pending.filter((a) => a.action !== 'speak') // never speak for a messenger
    if (!pending.length) break

    const results = []
    for (const a of pending) results.push({ a, r: await execAction(a, onCommand, channel) })

    const lines = results.map(({ a, r }) => {
      if (r && r.ok === false) return `${a.action}: FAILED — ${r.error || 'failed'}`
      const id = r && r.result && r.result.id
      const label = a.name ? ` name "${a.name}"` : ''
      return id ? `${a.action}: ok (new id: ${id}${label})` : `${a.action}: ok`
    })

    // report back whenever a data-changing action ran (so the model knows it's
    // done and can do the next step) or anything failed — but not for pure
    // navigation / voice / reads.
    const needsFollowUp = results.some(({ a, r }) => (r && r.ok === false) || !NO_REPORT.has(a.action))
    if (!needsFollowUp) break

    const fb = await api.aiSend?.({
      messages: [
        {
          role: 'user',
          content:
            `[action results] Outcome of the actions you just ran:\n${lines.join('\n')}\n\n` +
            'If you still need to act now — e.g. you just created a folder/note and need its new id to do the next step — emit the next ```calendar block USING these ids. ' +
            'If a step FAILED, tell the user briefly why and do NOT repeat the same failing action. ' +
            'If everything is done, just confirm briefly to the user with NO action block.'
        }
      ]
    })
    if (!fb?.ok) {
      const fails = lines.filter((l) => l.includes('FAILED'))
      if (fails.length) texts.push(`⚠ ${fails.join('; ')}`)
      break
    }
    const parsed = extractActions(fb.text)
    if (parsed.text) texts.push(parsed.text)
    pending = parsed.actions
  }

  return texts.length ? texts.join('\n\n') : null
}
