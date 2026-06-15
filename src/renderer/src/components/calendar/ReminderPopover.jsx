import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n/I18nContext'
import TimePicker from './TimePicker'
import './ReminderPopover.css'

// Portal popover with a custom 24h time picker. The reminder is just a time —
// the date is the note's own day (or recurring for the "every day" board).
export default function ReminderPopover({ anchorRef, value, onChange, onClear, onClose }) {
  const { t } = useI18n()
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    const a = anchorRef?.current?.getBoundingClientRect()
    const width = 170
    if (a) {
      let left = a.left
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8
      setPos({ top: a.bottom + 4, left: Math.max(8, left) })
    } else {
      setPos({ top: 60, left: 60 })
    }
  }, [anchorRef])

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  if (!pos) return null

  return createPortal(
    <div className="reminder-pop" ref={ref} style={{ top: pos.top, left: pos.left }}>
      <TimePicker value={value} onChange={onChange} />
      {value && (
        <button
          className="reminder-pop__clear"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClear}
        >
          {t('items.clearReminder')}
        </button>
      )}
    </div>,
    document.body
  )
}
