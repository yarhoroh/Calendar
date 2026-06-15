import { useEffect, useRef } from 'react'
import './TimePicker.css'

// Custom 24h time picker: two scrollable columns (hours / minutes). Value is
// 'HH:mm'. onMouseDown is used (not click) so it doesn't blur the editor.
const pad = (n) => String(n).padStart(2, '0')
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

export default function TimePicker({ value, onChange }) {
  const now = new Date()
  const parts =
    value && value.includes(':')
      ? value.split(':')
      : [String(now.getHours()), String(now.getMinutes())]
  const h = Number(parts[0]) || 0
  const m = Number(parts[1]) || 0
  const hRef = useRef(null)
  const mRef = useRef(null)

  useEffect(() => {
    hRef.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'center' })
    mRef.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'center' })
  }, [])

  return (
    <div className="timepicker">
      <div className="timepicker__col" ref={hRef}>
        {HOURS.map((hh) => (
          <button
            key={hh}
            className={'timepicker__cell' + (hh === h ? ' is-sel' : '')}
            onMouseDown={(e) => {
              e.preventDefault()
              onChange(`${pad(hh)}:${pad(m)}`)
            }}
          >
            {pad(hh)}
          </button>
        ))}
      </div>
      <span className="timepicker__sep">:</span>
      <div className="timepicker__col" ref={mRef}>
        {MINUTES.map((mm) => (
          <button
            key={mm}
            className={'timepicker__cell' + (mm === m ? ' is-sel' : '')}
            onMouseDown={(e) => {
              e.preventDefault()
              onChange(`${pad(h)}:${pad(mm)}`)
            }}
          >
            {pad(mm)}
          </button>
        ))}
      </div>
    </div>
  )
}
