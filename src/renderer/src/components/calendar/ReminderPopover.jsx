import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n/I18nContext'
import { weekdayShort } from '../../lib/dates'
import { SpeakerIcon } from '../icons'
import TimePicker from './TimePicker'
import './ReminderPopover.css'

const ORDER = [1, 2, 3, 4, 5, 6, 0] // Mon … Sun (0 = Sunday)
const LAST_DAY = 32 // sentinel day-of-month = "last day of the month"
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)

// Portal popover with a custom 24h time picker. The reminder is just a time —
// the date is the note's own day (or recurring for the "every day" board). For
// the everyday board it also shows a repeat picker: Weekly (weekday squares) or
// Monthly (a 1–31 grid + "last day"). The two modes are mutually exclusive.
export default function ReminderPopover({ anchorRef, value, onChange, onClear, onClose, showDays, days, onDays, monthDays, onMonthDays, speak, onSpeak }) {
  const { t } = useI18n()
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  // monthly when the note already carries month-days, otherwise weekly
  const [mode, setMode] = useState(monthDays && monthDays.length ? 'month' : 'week')
  const wide = showDays && mode === 'month'

  useLayoutEffect(() => {
    const a = anchorRef?.current?.getBoundingClientRect()
    const width = wide ? 220 : 170
    if (a) {
      let left = a.left
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8
      setPos({ top: a.bottom + 4, left: Math.max(8, left) })
    } else {
      setPos({ top: 60, left: 60 })
    }
  }, [anchorRef, wide])

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

  // switching mode clears the other mode's selection so exactly one repeat is active
  const pickWeek = () => {
    setMode('week')
    if (monthDays && monthDays.length) onMonthDays?.([])
  }
  const pickMonth = () => {
    setMode('month')
    if (days && days.length) onDays?.([])
  }
  const toggleMonthDay = (n) =>
    onMonthDays?.(
      (monthDays || []).includes(n)
        ? (monthDays || []).filter((d) => d !== n)
        : [...(monthDays || []), n].sort((a, b) => a - b)
    )

  return createPortal(
    <div className={'reminder-pop' + (wide ? ' reminder-pop--month' : '')} ref={ref} style={{ top: pos.top, left: pos.left }}>
      <TimePicker value={value} onChange={onChange} />
      {showDays && (
        <div className="reminder-pop__repeat">
          <div className="reminder-pop__tabs">
            <button
              className={'reminder-pop__tab' + (mode === 'week' ? ' is-on' : '')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={pickWeek}
            >
              {t('items.repeatWeekly')}
            </button>
            <button
              className={'reminder-pop__tab' + (mode === 'month' ? ' is-on' : '')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={pickMonth}
            >
              {t('items.repeatMonthly')}
            </button>
          </div>
          {mode === 'week' ? (
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
          ) : (
            <div className="reminder-pop__month">
              <div className="reminder-pop__month-grid">
                {MONTH_DAYS.map((n) => (
                  <button
                    key={n}
                    className={'reminder-pop__mday' + ((monthDays || []).includes(n) ? ' reminder-pop__mday--on' : '')}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggleMonthDay(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <button
                className={'reminder-pop__lastday' + ((monthDays || []).includes(LAST_DAY) ? ' reminder-pop__mday--on' : '')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleMonthDay(LAST_DAY)}
              >
                {t('items.lastDay')}
              </button>
            </div>
          )}
        </div>
      )}
      {onSpeak && (
        <button
          className={'reminder-pop__speak' + (speak ? ' is-on' : '')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSpeak(!speak)}
          title={t('items.speakAloud')}
        >
          <SpeakerIcon />
          <span>{t('items.speakAloud')}</span>
        </button>
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
