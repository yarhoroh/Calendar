import { useEffect, useState } from 'react'
import api from '../lib/api'

// Tracks whether the selected AI CLI has been warmed up and is ready to take
// prompts. The main process warms it on startup / engine switch and pushes
// status updates; we also fetch the current value once on mount.
export function useAiStatus() {
  const [status, setStatus] = useState({ state: 'warming', cli: 'gemini' })

  useEffect(() => {
    let alive = true
    Promise.resolve(api.getAiStatus?.()).then((s) => {
      if (alive && s) setStatus(s)
    })
    const off = api.onAiStatus?.((s) => setStatus(s))
    return () => {
      alive = false
      off?.()
    }
  }, [])

  return status
}
