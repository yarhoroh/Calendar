import { useEffect } from 'react'
import api from './lib/api'
import ReminderToasts from './components/ReminderToasts'

// Root for the separate notification window (#toast). It doesn't use the theme
// hook (that lives in the main App), so apply the saved theme here and follow
// live theme changes.
export default function ToastApp() {
  useEffect(() => {
    Promise.resolve(api.getTheme?.()).then((t) => {
      if (t) document.documentElement.dataset.theme = t
    })
    const off = api.onThemeChange?.((t) => {
      if (t) document.documentElement.dataset.theme = t
    })
    return () => off?.()
  }, [])

  return <ReminderToasts onOpen={(dayKey) => api.notifyOpen?.(dayKey)} />
}
