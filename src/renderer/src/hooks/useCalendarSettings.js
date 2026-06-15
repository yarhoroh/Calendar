import { useCallback, useEffect, useState } from 'react'
import api from '../lib/api'

const DEFAULTS = { colWidth: 240, expanded: false }

// Loads persisted calendar settings (column width, expanded mode) and persists
// every change back through the IPC bridge.
export function useCalendarSettings() {
  const [settings, setSettings] = useState(DEFAULTS)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    Promise.resolve(api.getCalendar?.()).then((saved) => {
      setSettings({ ...DEFAULTS, ...(saved || {}) })
      setLoaded(true)
    })
  }, [])

  const update = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, ...patch }))
    api.setCalendar?.(patch)
  }, [])

  return { settings, loaded, update }
}
