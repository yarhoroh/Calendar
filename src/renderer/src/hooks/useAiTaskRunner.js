import { useEffect } from 'react'
import api from '../lib/api'
import { startOfToday, dateKey } from '../lib/dates'
import { extractActions, execAction } from '../lib/aiActions'

// When a scheduled AI self-task fires (from main), run its text through the AI
// and execute whatever actions it returns (speak a reminder, add notes, etc.).
export function useAiTaskRunner({ onCommand }) {
  useEffect(() => {
    const off = api.onAiTaskFire?.(async ({ text }) => {
      if (!text) return
      const prompt = `[Your scheduled task just fired] ${text}\nDo it now. If it asks you to tell or remind the user something, use the speak action to say it out loud.`
      const res = await api.aiSend?.({ messages: [{ role: 'user', content: prompt }], todayKey: dateKey(startOfToday()) })
      if (!res?.ok) return
      const { actions } = extractActions(res.text)
      for (const a of actions) await execAction(a, onCommand)
    })
    return () => off?.()
  }, [onCommand])
}
