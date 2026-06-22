import { useEffect, useState } from 'react'
import api from '../lib/api'

// Owns window-chrome state (maximized, pinned, the close prompt) and exposes
// the actions the titlebar / close dialog call.
export function useWindowControls() {
  const [maximized, setMaximized] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  useEffect(() => {
    const offMax = api.onMaximized?.((value) => setMaximized(value))
    const offClose = api.onConfirmClose?.(() => setConfirmClose(true))
    Promise.resolve(api.getWindowState?.()).then((state) => {
      if (state) setPinned(state.pinned)
    })
    return () => {
      offMax?.()
      offClose?.()
    }
  }, [])

  const togglePin = () => {
    setPinned((prev) => {
      const next = !prev
      api.setAlwaysOnTop?.(next)
      return next
    })
  }

  return {
    maximized,
    pinned,
    confirmClose,
    minimize: () => api.minimize?.(),
    toggleMaximize: () => api.toggleMaximize?.(),
    close: () => api.close?.(),
    togglePin,
    hideToTray: (remember) => {
      api.hideToTray?.(remember)
      setConfirmClose(false)
    },
    quit: (remember) => api.quit?.(remember),
    cancelClose: () => setConfirmClose(false)
  }
}
