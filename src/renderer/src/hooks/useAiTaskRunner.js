import { useEffect } from 'react'
import api from '../lib/api'
import { extractActions, runActions } from '../lib/aiActions'

// When a scheduled AI self-task fires, run its text through the AI and act.
// A task remembers the channel it was created from: tasks from Telegram reply
// back to that Telegram chat (text). Telegram tasks stay silent BY DEFAULT, but
// honour notify:"voice" — a reminder the user explicitly asked to ALSO hear speaks
// aloud on the PC on top of the Telegram text. In-app tasks act normally.
export function useAiTaskRunner({ onCommand }) {
  useEffect(() => {
    const off = api.onAiTaskFire?.(async ({ text, channel, notify }) => {
      if (!text) return
      const tg = channel && channel.startsWith('telegram:') ? channel.slice('telegram:'.length) : null
      // how the task should announce its result — the user's choice when creating it
      // ('voice','tray', both, or empty = AI default). Honoured for Telegram tasks too.
      const m = String(notify || '').split(',').map((s) => s.trim()).filter(Boolean)
      const voice = m.includes('voice')
      const tray = m.includes('tray')
      const deliver =
        voice && tray
          ? 'When you tell the user something, BOTH say it aloud with the speak action AND show it with the notify action.'
          : tray
            ? 'When you tell the user something, use the notify action to show a tray message (do NOT use voice).'
            : voice
              ? 'When you tell the user something, use the speak action to say it aloud.'
              : 'If it should tell/remind the user something, use the speak action to say it aloud.'
      const prompt = tg
        ? voice
          ? `[Your scheduled task fired] ${text}\nThis task came from Telegram — reply with a short text message for that chat, AND ALSO emit a speak action to say it aloud on the computer (the user asked to be reminded by voice too). Set "lang".`
          : `[Your scheduled task fired] ${text}\nThis task came from Telegram — reply with a short text message; it will be sent to that Telegram chat (do NOT use voice).`
        : `[Your scheduled task fired] ${text}\nDo it now. ${deliver}`
      const res = await api.aiSend?.({ messages: [{ role: 'user', content: prompt }] })
      if (!res?.ok) return
      const { text: clean, actions } = extractActions(res.text)
      // Telegram tasks drop speak UNLESS the user asked to hear it (notify includes voice)
      const acts = tg && !voice ? actions.filter((a) => a.action !== 'speak') : actions
      const fb = await runActions(acts, onCommand, channel, voice)
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
