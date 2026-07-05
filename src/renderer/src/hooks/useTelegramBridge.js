import { useEffect } from 'react'
import api from '../lib/api'
import { extractActions, runActions, BAD_JSON_HINT } from '../lib/aiActions'
import { pushChat } from '../lib/chatBridge'

// Routes incoming Telegram messages through the same AI pipeline as the chat:
// run the message, execute any calendar actions, and send the reply back to
// Telegram. Reuses the live AI session (same assistant the app uses).
export function useTelegramBridge({ onCommand }) {
  useEffect(() => {
    const off = api.onTelegramMessage?.(async ({ chatId, text, from, images, files }) => {
      if (!text && !images?.length && !files?.length) return
      const body = text || (images?.length ? '(sent an image)' : files?.length ? '(sent a file)' : '')
      // an incoming file is already saved on disk — tell the AI its exact path so it can attach it
      // to a note with attachFile (noteId + this path). It must find/confirm which note they mean.
      const fileNote = files?.length
        ? `\n\n[The user attached ${files.length} file(s): ${files.map((f) => `"${f.name}" saved at ${f.path}`).join('; ')}. To KEEP a file, attach it to a note with attachFile (its noteId + that EXACT path). If they didn't say which note, ask which one.]`
        : ''
      // mirror the Telegram exchange into the in-app chat so it's one shared
      // conversation on screen (the AI session is already shared across channels)
      pushChat(`📨 ${from || 'Telegram'}: ${body}`, 'user')
      const content = `[Incoming Telegram message${from ? ` from ${from}` : ''}] ${body}${fileNote}\n\n(This arrived from Telegram; your text reply is sent back to them there. Do what they ask — read any attached image, save/attach any file, add notes/reminders, answer, etc. — and reply briefly.)`
      const res = await api.aiSend?.({ messages: [{ role: 'user', content, images }] })
      if (!res?.ok) {
        api.telegramReply?.(chatId, `⚠ ${res?.error || 'no reply'}`)
        return
      }
      let { text: clean, actions, parseError } = extractActions(res.text)
      // malformed action block from the model → re-request valid JSON before giving up
      if (parseError && !actions.length) {
        const fix = await api.aiSend?.({ messages: [{ role: 'user', content: BAD_JSON_HINT.replace('%E', parseError) }] })
        if (fix?.ok) { const r2 = extractActions(fix.text); actions = r2.actions; if (r2.text) clean = r2.text }
      }
      const channel = `telegram:${chatId}`
      // a clarifying question (ask) must NOT pop the desktop dialog for a Telegram chat — the
      // user isn't at the computer. Deliver the question AS the Telegram reply (use the ask
      // text if the model put it only there), and the user's next Telegram message is the answer.
      const askText = actions.find((a) => a.action === 'ask')?.text
      const reply = clean || askText || '✓'
      api.telegramReply?.(chatId, reply)
      pushChat(reply, 'assistant')
      // no voice for a Telegram request, and no desktop ask/closeAsk popups; report failures back
      const acts = actions.filter((a) => a.action !== 'speak' && a.action !== 'ask' && a.action !== 'closeAsk')
      const fb = await runActions(acts, onCommand, channel)
      if (fb) api.telegramReply?.(chatId, fb)
    })
    return () => off?.()
  }, [onCommand])
}
