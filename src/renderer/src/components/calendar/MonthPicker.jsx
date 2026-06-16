import { useEffect, useRef, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from '../icons'
import { sameDay, monthLabel } from '../../lib/dates'
import './MonthPicker.css'

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1)

// Popover month grid. Click a day → onPick(date). Closes on outside click.
export default function MonthPicker({ selected, today, onPick, onClose }) {
  // guard against an invalid `selected` (e.g. origin went NaN) so the grid and
  // month label never crash on "Invalid time value"
  const sel = Number.isFinite(+selected) ? selected : today
  const [view, setView] = useState(() => startOfMonth(sel))
  const ref = useRef(null)

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const first = startOfMonth(view)
  const startWeekday = (first.getDay() + 6) % 7 // make Monday = 0
  const gridStart = new Date(first)
  gridStart.setDate(1 - startWeekday)

  const cells = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    cells.push(d)
  }

  const prevMonth = () => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))
  const nextMonth = () => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))

  return (
    <div className="month-picker" ref={ref}>
      <div className="month-picker__head">
        <button className="month-picker__nav" onClick={prevMonth} title="Предыдущий месяц">
          <ChevronLeftIcon />
        </button>
        <span className="month-picker__title">{monthLabel(view)}</span>
        <button className="month-picker__nav" onClick={nextMonth} title="Следующий месяц">
          <ChevronRightIcon />
        </button>
      </div>

      <div className="month-picker__weekdays">
        {WEEKDAYS.map((w) => (
          <span key={w} className="month-picker__wd">
            {w}
          </span>
        ))}
      </div>

      <div className="month-picker__grid">
        {cells.map((d, i) => {
          const out = d.getMonth() !== view.getMonth()
          const cls =
            'month-picker__day' +
            (out ? ' month-picker__day--out' : '') +
            (sameDay(d, today) ? ' month-picker__day--today' : '') +
            (sameDay(d, sel) ? ' month-picker__day--sel' : '')
          return (
            <button key={i} className={cls} onClick={() => onPick(d)}>
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}
