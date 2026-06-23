import api from './api'
import { newItem } from '../hooks/useDayItems'
import { getActiveEditor, replaceSelection, appendToNote, setNoteContent } from './activeEditor'
import { ui } from './uiBridge'
import { pushChat, hasChat } from './chatBridge'
import { openAsk, closeAsk } from './askBridge'
import { importGoogleEvent, importGoogleEventEveryday } from './importGoogle'
import { startOfToday, dateKey } from './dates'

// plain text from an HTML string (for the searchable/AI `text` field)
const stripHtml = (html) => {
  const d = document.createElement('div')
  d.innerHTML = html || ''
  return (d.textContent || '').trim()
}

// plain text → safe HTML (escape, keep line breaks) so a text edit updates the view
const escapeHtml = (text) => {
  const d = document.createElement('div')
  d.textContent = text || ''
  return d.innerHTML.replace(/\n/g, '<br>')
}

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
      case 'telegram':
      case 'sendTelegram': {
        if (!a.text) return { ok: false, error: 'telegram needs text' }
        const r = await api.sendTelegram?.(a.text)
        return r?.ok ? { ok: true } : { ok: false, error: r?.error || 'telegram send failed' }
      }
      case 'chat':
      case 'message': {
        // proactively post a message into the in-app chat (for background tasks /
        // notifications — not your normal reply, which already shows)
        if (!a.text) return { ok: false, error: 'chat needs text' }
        return hasChat() ? (pushChat(a.text), { ok: true }) : { ok: false, error: 'in-app chat is not open' }
      }
      case 'ask': {
        // pop a question to the user and wait — their answer comes back as a new
        // message that quotes this question, so keep it short and specific
        if (!a.text) return { ok: false, error: 'ask needs text' }
        openAsk(a.text)
        return { ok: true }
      }
      case 'closeAsk':
        closeAsk()
        return { ok: true }
      case 'importGoogleEvents': {
        // pull Google Calendar events in a date range into notes (skips already
        // imported ones). Recurring events go to the "everyday" board (once per
        // series); one-time events onto their date. mode:"day" forces single-day.
        if (!a.from) return { ok: false, error: 'importGoogleEvents needs a from date (YYYY-MM-DD)' }
        const evs = (await api.google?.listEvents?.(a.from, a.to || a.from)) || []
        // optional targeting: gid (exact) or title (substring) — without either,
        // EVERY event in the range is imported
        const q = a.title ? String(a.title).toLowerCase() : null
        const fresh = evs
          .filter((e) => !e.imported)
          .filter((e) => (a.gid ? e.googleEventId === a.gid : true))
          .filter((e) => (q ? (e.title || '').toLowerCase().includes(q) : true))
        const doneSeries = new Set()
        let count = 0
        for (const ev of fresh) {
          if (ev.recurring && a.mode !== 'day') {
            if (doneSeries.has(ev.recurringEventId)) continue
            doneSeries.add(ev.recurringEventId)
            const res = await importGoogleEventEveryday(ev)
            if (res?.unsupported) await importGoogleEvent(ev) // complex repeat → single day
          } else {
            await importGoogleEvent(ev)
          }
          count++
        }
        return { ok: true, result: { count, skipped: evs.length - fresh.length } }
      }
      case 'addGoogleEvent': {
        // create an event on a SHARED (writable) Google calendar, then import it
        // locally — so it shows up for everyone who has that calendar connected
        if (!a.title) return { ok: false, error: 'addGoogleEvent needs a title' }
        const day = a.date || dateKey(startOfToday()) // no date given → today, so it's visible
        const accs = (await api.google?.listAccounts?.()) || []
        const writable = []
        for (const acc of accs)
          for (const c of acc.calendars || [])
            if (c.selected && c.writable) writable.push({ account: acc.email, id: c.id, summary: c.summary })
        if (!writable.length)
          return { ok: false, error: 'no writable shared calendar connected — connect one you can edit and reconnect the account (grant calendar edit)' }
        let target = null
        if (a.calendar) {
          const q = String(a.calendar).toLowerCase()
          target = writable.find((c) => c.id === a.calendar) || writable.find((c) => c.summary.toLowerCase().includes(q))
        }
        if (!target && writable.length === 1) target = writable[0]
        if (!target)
          return { ok: false, error: `which calendar? writable: ${writable.map((c) => c.summary).join(', ')}` }
        const r = await api.google?.createEvent?.(target.account, target.id, {
          title: a.title,
          day,
          time: a.time || null,
          durationMin: a.durationMin,
          description: a.text || a.description || '',
          location: a.location || ''
        })
        if (!r?.ok) return { ok: false, error: r?.error || 'create failed' }
        // mark the local note as shared (we created it on Google), so it can later
        // be edited/deleted on Google too — same as the editor's share button
        const imp = await importGoogleEvent(r.event, { googleShared: true })
        return { ok: true, result: { calendar: target.summary, day: imp?.day } }
      }
      case 'remember':
        if (a.text) await api.addMemory?.(a.text)
        return { ok: true }
      case 'forget':
        if (a.id) await api.deleteMemory?.(a.id)
        return { ok: true }
      case 'addAiTask': {
        if (!a.text || (!a.at && !a.every))
          return { ok: false, error: 'addAiTask needs text and either a time (at) or an interval (every)' }
        const r = await api.addAiTask?.({ at: a.at, text: a.text, every: a.every, from: a.from, to: a.to, notify: a.notify, channel })
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
        const days = Array.isArray(a.days) ? a.days : null // weekdays for everyday notes
        const html = a.html || '' // optional rich (formatted) content
        const text = html ? stripHtml(html) : a.text || ''
        const item = { ...newItem(text), title: a.title || null, time: a.time || null, folderId: a.folder || null, days, html }
        api.saveItems?.(a.date, [...arr, item])
        if (a.time)
          api.setReminder?.({ id: item.id, when: a.time, dayKey: a.date, title: a.title || 'Calendar', body: text, days })
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
        // patch only the fields the model actually sent; keep the rest. If it
        // sends html, that's the new rich content (text becomes its plain form).
        const patched = {
          ...it,
          title: a.title !== undefined ? a.title : it.title,
          text: a.html !== undefined ? stripHtml(a.html) : a.text !== undefined ? a.text : it.text,
          // editing text (without html) regenerates html so the view updates;
          // a rich note edited via plain text becomes plain
          html: a.html !== undefined ? a.html || '' : a.text !== undefined ? escapeHtml(a.text) : it.html,
          time: a.time !== undefined ? a.time : it.time,
          status: a.status !== undefined ? a.status : it.status,
          folderId: a.folder !== undefined ? a.folder || null : it.folderId,
          days: a.days !== undefined ? (Array.isArray(a.days) ? a.days : null) : it.days
        }
        arr[idx] = patched
        api.saveItems?.(a.date, arr)
        if (patched.time)
          api.setReminder?.({ id: it.id, when: patched.time, dayKey: a.date, title: patched.title || 'Calendar', body: patched.text || '', days: patched.days })
        else if (a.time !== undefined) api.clearReminder?.(it.id)
        // editing a Google-linked note on a real date → push the change up to
        // Google too (main skips read-only calendars). Same as the UI editor.
        if (it.googleEventId && /^\d{4}-\d{2}-\d{2}$/.test(a.date)) {
          const hhmm = patched.time ? String(patched.time).split('T')[1] || patched.time : null
          api.google?.updateEvent?.(it.googleEventId, {
            title: patched.title || '(no title)',
            day: a.date,
            time: hhmm,
            description: patched.text || ''
          })
        }
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
      case 'enterEdit': {
        // open a note in the editor: pass its id (+date) to target it, or omit
        // the id to edit the note that is currently fullscreen
        const ok = ui('enterEdit', { id: a.id, day: a.date })
        return ok ? { ok: true } : { ok: false, error: 'could not enter edit — make sure the note is on screen; pass its id and date' }
      }
      case 'enterFullscreen': {
        const ok = ui('enterFullscreen', { id: a.id, day: a.date })
        return ok ? { ok: true } : { ok: false, error: 'could not fullscreen — pass the note id (and date), and make sure it is on screen' }
      }
      case 'exitFullscreen':
        ui('exitFullscreen')
        return { ok: true }
      case 'closeEditor':
        ui('closeEditor')
        return { ok: true }
      case 'setSetting': {
        if (!a.key) return { ok: false, error: 'setSetting needs key and value' }
        const ok = ui('setSetting', { key: a.key, value: a.value })
        return ok ? { ok: true } : { ok: false, error: `unknown/unsupported setting "${a.key}" or bad value` }
      }
      case 'openPanel':
        ui('openPanel', { value: a.value !== false })
        return { ok: true }
      case 'selectFolder': {
        const ok = ui('selectFolder', { id: a.id ?? null })
        return ok ? { ok: true } : { ok: false, error: 'could not select folder — is the calendar view open?' }
      }
      case 'replaceSelection':
      case 'appendNote':
      case 'setNoteContent': {
        if (!getActiveEditor()) return { ok: false, error: 'no note is open in the editor' }
        const content = a.html || (a.text != null ? escapeHtml(a.text) : '')
        if (!content) return { ok: false, error: 'needs html or text' }
        if (a.action === 'replaceSelection') replaceSelection(content)
        else if (a.action === 'appendNote') appendToNote(content)
        else setNoteContent(content)
        return { ok: true }
      }
      case 'setNoteFolder': {
        if (!a.date || !Array.isArray(a.ids)) return { ok: false, error: 'setNoteFolder needs date and ids' }
        const arr = (await api.getItems?.(a.date)) || []
        const folderId = a.folder || null
        api.saveItems?.(
          a.date,
          arr.map((it) => (a.ids.includes(it.id) ? { ...it, folderId } : it))
        )
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
        return { ok: true }
      }
      case 'reorder': {
        if (!a.date || !Array.isArray(a.ids)) return { ok: false, error: 'reorder needs date and ids' }
        const arr = (await api.getItems?.(a.date)) || []
        const byId = new Map(arr.map((it) => [it.id, it]))
        const ordered = a.ids.map((id) => byId.get(id)).filter(Boolean)
        const rest = arr.filter((it) => !a.ids.includes(it.id))
        api.saveItems?.(a.date, [...ordered, ...rest])
        return { ok: true }
      }
      case 'delete': {
        if (!a.date || !Array.isArray(a.ids)) return { ok: false, error: 'delete needs date and ids' }
        const arr = (await api.getItems?.(a.date)) || []
        const kept = arr.filter((it) => !a.ids.includes(it.id))
        a.ids.forEach((id) => api.clearReminder?.(id))
        api.saveItems?.(a.date, kept)
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
const NO_REPORT = new Set([
  'goto', 'today', 'everyday', 'general', 'expand', 'speak', 'notify', 'getNotes', 'openFile', 'setModel',
  'replaceSelection', 'appendNote', 'setNoteContent', // live edits are visible in the editor already
  'exitFullscreen', 'closeEditor', 'openPanel', // UI control; failures are still reported (see needsFollowUp)
  'chat', 'message', // the posted message IS the output
  'ask', 'closeAsk' // ask waits for the user's answer (arrives later as a new message); no immediate follow-up
])

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
