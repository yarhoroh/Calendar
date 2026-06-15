import { useState } from 'react'
import api from '../lib/api'
import { startOfToday, dateKey } from '../lib/dates'
import { extractActions, execAction } from '../lib/aiActions'

// Conversation with the chosen local AI. With gemini the context lives in the
// persistent ACP session; clearing wipes it on both sides.
export function useChat({ onCommand }) {
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)

  const send = async (text) => {
    const t = text.trim()
    if (!t || busy) return
    const next = [...messages, { role: 'user', content: t }]
    setMessages(next)
    setBusy(true)
    const res = await api.aiSend?.({ messages: next, todayKey: dateKey(startOfToday()) })
    setBusy(false)

    if (!res?.ok) {
      setMessages((m) => [...m, { role: 'assistant', content: `⚠ ${res?.error || 'нет ответа от CLI'}` }])
      return
    }
    const { text: clean, actions } = extractActions(res.text)
    setMessages((m) => [...m, { role: 'assistant', content: clean || '✓' }])
    for (const a of actions) await execAction(a, onCommand)
  }

  const clear = () => {
    setMessages([])
    api.aiClear?.() // also wipe the AI's own (server-side) context
  }

  return { messages, busy, send, clear }
}
