import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n/I18nContext'
import { weekdayShort } from '../../lib/dates'
import TimePicker from './TimePicker'
import './ReminderPopover.css'

const ORDER = [1, 2, 3, 4, 5, 6, 0] // Mon … Sun (0 = Sunday)

// Portal popover with a custom 24h time picker. The reminder is just a time —
// the date is the note's own day (or recurring for the "every day" board). For
// the everyday board it also shows weekday squares (which days it fires on).
export default function ReminderPopover({ anchorRef, value, onChange, onClear, onClose, showDays, days, onDays }) {
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
    // attach on the next tick so the mousedown that OPENED the popover doesn't
    // immediately get caught and close it again
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  if (!pos) return null

  return createPortal(
    <div className="reminder-pop" ref={ref} style={{ top: pos.top, left: pos.left }}>
      <TimePicker value={value} onChange={onChange} />
      {showDays && (
        <div className="reminder-pop__days">
          {[ORDER.slice(0, 3), ORDER.slice(3)].map((row, ri) => (
            <div className="reminder-pop__days-row" key={ri}>
              {row.map((idx) => (
                <button
                  key={idx}
                  className={'reminder-pop__day' + ((days || []).includes(idx) ? ' reminder-pop__day--on' : '')}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    onDays?.(
                      (days || []).includes(idx)
                        ? (days || []).filter((d) => d !== idx)
                        : [...(days || []), idx].sort((a, b) => a - b)
                    )
                  }
                >
                  {weekdayShort(idx)}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
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
