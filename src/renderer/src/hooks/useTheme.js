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

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark'
      document.documentElement.dataset.theme = next
      api.setTheme?.(next)
      return next
    })
  }

  return { theme, toggleTheme }
}
