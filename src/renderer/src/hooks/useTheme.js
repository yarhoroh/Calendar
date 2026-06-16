import { useEffect, useState } from 'react'
import api from '../lib/api'

// Owns the light/dark theme: loads the saved value on mount, applies it to
// <html data-theme> and persists every change through the IPC bridge.
export function useTheme() {
  const [theme, setTheme] = useState('dark')

  useEffect(() => {
    Promise.resolve(api.getTheme?.()).then((saved) => {
      if (!saved) return
      setTheme(saved)
      document.documentElement.dataset.theme = saved
    })
  }, [])

  const applyTheme = (next) => {
    if (next !== 'dark' && next !== 'light') return
    document.documentElement.dataset.theme = next
    api.setTheme?.(next)
    setTheme(next)
  }

  const toggleTheme = () => applyTheme(theme === 'dark' ? 'light' : 'dark')

  return { theme, toggleTheme, applyTheme }
}
