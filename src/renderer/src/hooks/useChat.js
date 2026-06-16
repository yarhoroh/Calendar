import { useState } from 'react'
import api from '../lib/api'
import { startOfToday, dateKey } from '../lib/dates'
import { extractActions, runActions } from '../lib/aiActions'

// Conversation with the chosen local AI. With gemini the context lives in the
// persistent ACP session; clearing wipes it on both sides.
export function useChat({ onCommand }) {
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)

  const send = async (text, images) => {
    const t = text.trim()
    if ((!t && !images?.length) || busy) return
    const next = [...messages, { role: 'user', content: t, images: images?.length ? images : undefined }]
    setMessages(next)
    setBusy(true)
    const res = await api.aiSend?.({ messages: next, todayKey: dateKey(startOfToday()) })
    setBusy(false)

    if (!res?.ok) {
      setMessages((m) => [...m, { role: 'assistant', content: `⚠ ${res?.error || 'нет ответа от CLI'}` }])
      return
    }
    console.warn('[ai-reply]', JSON.stringify(res.text))
    const { text: clean, actions } = extractActions(res.text)
    console.warn('[ai-actions]', actions.length, JSON.stringify(actions))
    setMessages((m) => [...m, { role: 'assistant', content: clean || '✓' }])
    const fb = await runActions(actions, onCommand)
    if (fb) setMessages((m) => [...m, { role: 'assistant', content: fb }])
  }

  const clear = () => {
    setMessages([])
    api.aiClear?.() // also wipe the AI's own (server-side) context
  }

  return { messages, busy, send, clear }
}
