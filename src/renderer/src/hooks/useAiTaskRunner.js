import { useEffect } from 'react'
import api from '../lib/api'
import { extractActions, runActions } from '../lib/aiActions'

// When a scheduled AI self-task fires, run its text through the AI and act.
// A task remembers the channel it was created from: tasks from Telegram reply
// back to that Telegram chat (text, no voice); in-app tasks act normally.
export function useAiTaskRunner({ onCommand }) {
  useEffect(() => {
    const off = api.onAiTaskFire?.(async ({ text, channel }) => {
      if (!text) return
      const tg = channel && channel.startsWith('telegram:') ? channel.slice('telegram:'.length) : null
      const prompt = tg
        ? `[Your scheduled task fired] ${text}\nThis task came from Telegram — reply with a short text message; it will be sent to that Telegram chat (do NOT use voice).`
        : `[Your scheduled task fired] ${text}\nDo it now. If it should tell/remind the user something, use the speak action to say it aloud.`
      const res = await api.aiSend?.({ messages: [{ role: 'user', content: prompt }] })
      if (!res?.ok) return
      const { text: clean, actions } = extractActions(res.text)
      const acts = tg ? actions.filter((a) => a.action !== 'speak') : actions
      const fb = await runActions(acts, onCommand, channel)
      if (tg) {
        api.telegramReply?.(tg, clean || '✓')
        if (fb) api.telegramReply?.(tg, fb)
      } else if (fb) {
        api.notify?.(fb) // surface an in-app task failure as a toast
      }
    })
    return () => off?.()
  }, [onCommand])
}
