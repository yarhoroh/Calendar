import { useEffect } from 'react'
import api from '../lib/api'
import { extractActions, runActions } from '../lib/aiActions'
import { pushChat } from '../lib/chatBridge'

// Routes incoming Telegram messages through the same AI pipeline as the chat:
// run the message, execute any calendar actions, and send the reply back to
// Telegram. Reuses the live AI session (same assistant the app uses).
export function useTelegramBridge({ onCommand }) {
  useEffect(() => {
    const off = api.onTelegramMessage?.(async ({ chatId, text, from, images }) => {
      if (!text && !images?.length) return
      const body = text || (images?.length ? '(sent an image)' : '')
      // mirror the Telegram exchange into the in-app chat so it's one shared
      // conversation on screen (the AI session is already shared across channels)
      pushChat(`📨 ${from || 'Telegram'}: ${body}`, 'user')
      const content = `[Incoming Telegram message${from ? ` from ${from}` : ''}] ${body}\n\n(This arrived from Telegram; your text reply is sent back to them there. Do what they ask — read any attached image, add notes/reminders, answer, etc. — and reply briefly.)`
      const res = await api.aiSend?.({ messages: [{ role: 'user', content, images }] })
      if (!res?.ok) {
        api.telegramReply?.(chatId, `⚠ ${res?.error || 'no reply'}`)
        return
      }
      const { text: clean, actions } = extractActions(res.text)
      const channel = `telegram:${chatId}`
      api.telegramReply?.(chatId, clean || '✓')
      pushChat(clean || '✓', 'assistant')
      // no voice for a Telegram request; report any action failure back to chat
      const acts = actions.filter((a) => a.action !== 'speak')
      const fb = await runActions(acts, onCommand, channel)
      if (fb) api.telegramReply?.(chatId, fb)
    })
    return () => off?.()
  }, [onCommand])
}
