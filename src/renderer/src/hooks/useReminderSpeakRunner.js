import { useEffect } from 'react'
import api from '../lib/api'
import { extractActions, runActions } from '../lib/aiActions'

// When a reminder fires AND the user's "read reminders aloud" toggle is on, the
// main process hands us the note's title + body. We pinch the AI to read it out
// briefly by voice — it decides what's worth saying. Mirrors useAiTaskRunner.
export function useReminderSpeakRunner({ onCommand }) {
  useEffect(() => {
    const off = api.onReminderSpeak?.(async ({ title, body } = {}) => {
      const note = [title, body].filter(Boolean).join('\n').trim()
      if (!note) return
      const prompt =
        `[A reminder just fired] Read it out to the user by VOICE — briefly and naturally: ` +
        `summarize if it is long, drop clutter, keep it to a sentence or two. Use the speak ` +
        `action in the user's language. Do not add anything else.\n\nReminder title + note:\n${note}`
      const res = await api.aiSend?.({ messages: [{ role: 'user', content: prompt }] })
      if (!res?.ok) return
      const { actions } = extractActions(res.text)
      await runActions(actions, onCommand)
    })
    return () => off?.()
  }, [onCommand])
}
