import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import api from '../lib/api'
import { CloseIcon } from './icons'
import './ReminderToasts.css'

// Lives in the separate notification window. Stacks toasts (newest at the
// bottom), auto-dismisses by the configured duration, and reports its height
// so the host window can size itself to the content.
export default function ReminderToasts({ onOpen }) {
  const [toasts, setToasts] = useState([])
  const durationRef = useRef(0)
  const wrapRef = useRef(null)

  useEffect(() => {
    Promise.resolve(api.getReminderDuration?.()).then((d) => {
      durationRef.current = d || 0
    })
    api.onReminderFire?.((p) => {
      const toast = { ...p, key: `${p.id}:${Date.now()}` }
      setToasts((prev) => [...prev, toast])
      if (durationRef.current > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.key !== toast.key))
        }, durationRef.current * 1000)
      }
    })
  }, [])

  // size the host window to fit
  useLayoutEffect(() => {
    api.notifyResize?.(toasts.length ? wrapRef.current?.scrollHeight || 0 : 0)
  }, [toasts])

  const dismiss = (key) => setToasts((prev) => prev.filter((t) => t.key !== key))

  return (
    <div className="toasts" ref={wrapRef}>
      {toasts.map((t) => (
        <div
          key={t.key}
          className="toast"
          onClick={() => {
            if (t.dayKey) onOpen(t.dayKey)
            dismiss(t.key)
          }}
        >
          <div className="toast__body">
            <div className="toast__title">{t.title || t.body || 'Reminder'}</div>
            {t.body && t.title && <div className="toast__text">{t.body}</div>}
          </div>
          <button
            className="toast__close"
            onClick={(e) => {
              e.stopPropagation()
              dismiss(t.key)
            }}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  )
}
