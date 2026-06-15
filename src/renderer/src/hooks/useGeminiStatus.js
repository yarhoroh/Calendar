import { useCallback, useEffect, useState } from 'react'
import api from '../lib/api'

// Tracks the Gemini CLI: detects on mount, and exposes detect()/install().
// status: 'checking' | 'found' | 'missing' | 'installing' | 'error'
export function useGeminiStatus() {
  const [state, setState] = useState({ status: 'checking', version: '', path: '', error: '' })

  const detect = useCallback(() => {
    setState((s) => ({ ...s, status: 'checking', error: '' }))
    Promise.resolve(api.gemini?.detect?.()).then((res) => {
      if (!res) {
        setState({ status: 'error', version: '', path: '', error: 'IPC недоступен' })
        return
      }
      setState(
        res.found
          ? { status: 'found', version: res.version, path: res.path, error: '' }
          : { status: 'missing', version: '', path: '', error: '' }
      )
    })
  }, [])

  const install = useCallback(() => {
    setState((s) => ({ ...s, status: 'installing', error: '' }))
    Promise.resolve(api.gemini?.install?.()).then((res) => {
      if (res?.ok) detect()
      else setState({ status: 'error', version: '', path: '', error: res?.error || 'Не удалось установить' })
    })
  }, [detect])

  useEffect(() => {
    detect()
  }, [detect])

  return { ...state, detect, install }
}
