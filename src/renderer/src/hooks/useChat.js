import { useEffect, useState } from 'react'
import api from '../lib/api'
import { startOfToday, dateKey } from '../lib/dates'
import { extractActions, runActions } from '../lib/aiActions'
import { activeContext } from '../lib/activeEditor'
import { getUiState, ui } from '../lib/uiBridge'
import { registerChatSink } from '../lib/chatBridge'

// Tell the AI where the user is (tab / fullscreen / editing / selected folder)
// and, if a note is open, its content + selection — so it can act on "this note"
// and drive the UI. The user only sees their own message.
function withEditorContext(t) {
  const st = getUiState()
  const s = st.settings || {}
  const onoff = (v) => (v ? 'on' : 'off')
  // which top-level tab the user is actually on (calendar / appointments / mail / settings)
  const view = st.view || 'calendar'
  const om = st.openMail
  // when the user is in mail, tell the AI the mailbox and (if open) the exact message it can
  // act on — so "this email" / "the article in this email" needs no search or asking
  const mailState =
    view === 'mail'
      ? `; mailbox=${om?.account || st.mailAccount || 'all'}/${st.mailFolder || 'INBOX'}` +
        (om
          ? `; OPEN MAIL (the email the user is reading right now — use these ids directly for mailOpen): from="${om.from || ''}" subject="${om.subject || ''}" acct:${om.account} thread:${om.threadId || ''} id:${om.id || ''}`
          : '; OPEN MAIL: none (list/search to pick one)')
      : ''
  let ctx =
    `[APP STATE: view=${view}; tab=${st.board}; fullscreen=${st.fullscreen ? 'yes' : 'no'}; ` +
    `editing=${st.editing ? 'yes' : 'no'}; selected folder=${st.folder || 'General (all)'}; ` +
    `side panel=${onoff(s.panelOpen)}; theme=${st.theme || '?'}; language=${st.language || '?'}; ` +
    `chat=${onoff(st.showChat)}; everyday-in-calendar=${onoff(s.everydayInCal)}; ` +
    `day-expanded=${onoff(s.expanded)}; focus-blur=${onoff(s.focusBlur)}` +
    mailState +
    (st.ask?.open ? `; OPEN QUESTION awaiting answer: "${st.ask.question}"` : '') +
    `]`
  // if the New-email composer is open, give the AI its live content so it can fill/fix it
  // ("write the subject", "translate the body") and act on "this email I'm composing"
  const comp = ui('getCompose')
  if (comp?.open) {
    ctx +=
      `\n[COMPOSE OPEN — the user is writing a new email RIGHT NOW. from=${comp.from || '?'}; to=${comp.to || '(empty)'}; ` +
      `subject="${comp.subject || ''}". Current body text:\n${comp.text || '(empty)'}\n` +
      `Fill or edit it with composeMail (set "to" by looking a contact up with mailContacts, "subject", and "html" for the body — only the fields you pass change).]`
  }
  const ed = activeContext()
  if (ed) {
    ctx +=
      `\n[EDITOR CONTEXT — a note is open RIGHT NOW. Current HTML:\n${ed.html}\n` +
      (ed.selection ? `Selected fragment: "${ed.selection}"\n` : '(nothing selected)\n') +
      `Edit it LIVE with replaceSelection / appendNote / setNoteContent (no re-save). ` +
      `Leave with closeEditor or exitFullscreen.]`
  }
  // The metadata below is in English on purpose — it is NOT the user's language.
  // Keep it clearly separated from the user's message so the model never mirrors
  // its language and always answers in whatever language the user wrote in.
  return (
    `${t}\n\n` +
    `--- system metadata (English; ignore for language detection — ALWAYS reply in the user's language above) ---\n` +
    ctx
  )
}

// Conversation with the chosen local AI engine. Clearing wipes both the on-screen
// chat and the engine's own (server-side or in-prompt) context.
export function useChat({ onCommand }) {
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)

  // single entry point for anything posting into the chat (the assistant
  // proactively, background tasks, action outcomes) — see lib/chatBridge
  useEffect(() => registerChatSink((m) => setMessages((prev) => [...prev, m])), [])

  const send = async (text, images) => {
    const t = text.trim()
    if ((!t && !images?.length) || busy) return
    const imgs = images?.length ? images : undefined
    const next = [...messages, { role: 'user', content: t, images: imgs }] // UI shows just the user's text
    setMessages(next)
    setBusy(true)
    // the message the AI actually receives carries the open-editor context
    const forAi = [...messages, { role: 'user', content: withEditorContext(t), images: imgs }]
    const res = await api.aiSend?.({ messages: forAi, todayKey: dateKey(startOfToday()) })
    setBusy(false)

    if (!res?.ok) {
      setMessages((m) => [...m, { role: 'assistant', content: `⚠ ${res?.error || 'нет ответа от CLI'}` }])
      return
    }
    console.warn('[ai-reply]', JSON.stringify(res.text))
    const { text: clean, actions } = extractActions(res.text)
    console.warn('[ai-actions]', actions.length, JSON.stringify(actions))
    setMessages((m) => [...m, { role: 'assistant', content: clean || '✓' }])
    // drop a chat/message action that just repeats the reply we already posted (some models
    // confirm twice — once as text, once as a chat action) so the user doesn't see a duplicate
    const replyLc = (clean || '').trim().toLowerCase()
    const acts = actions.filter((a) => {
      if (!['chat', 'message'].includes(a.action) || !a.text) return true
      const tl = a.text.trim().toLowerCase()
      return !(replyLc && (replyLc.includes(tl) || tl.includes(replyLc)))
    })
    const fb = await runActions(acts, onCommand)
    if (fb) setMessages((m) => [...m, { role: 'assistant', content: fb }])
  }

  const clear = () => {
    setMessages([])
    api.aiClear?.() // also wipe the AI's own (server-side) context
  }

  return { messages, busy, send, clear }
}
