import { memo } from 'react'
import { weekday, monthShort, dayNum, dateKey } from '../../lib/dates'
import DayItems from './DayItems'
import './DayColumn.css'

// One day. Empty body for now — notes will live there. Double-click toggles
// the full-width expanded mode; the right edge resizes all columns.
// Memoized: it only re-renders when its own props change (not on scroll), so a
// few hundred columns stay cheap. Width is set in CSS via the --col-w variable.
function DayColumn({
  date,
  style,
  isToday,
  isWeekend,
  isActive,
  resizable,
  onActivate,
  onToggleExpand,
  onResizeStart
}) {
  const headClass =
    'day-col__head' +
    (isToday ? ' day-col__head--today' : isWeekend ? ' day-col__head--weekend' : '')

  return (
    <div
      className={isActive ? 'day-col day-col--active' : 'day-col'}
      style={style}
      onClick={() => onActivate(date)}
    >
      <div className={headClass} onDoubleClick={() => onToggleExpand(date)}>
        <span className="day-col__wd">{weekday(date)}</span>
        <span className="day-col__num">{dayNum(date)}</span>
        <span className="day-col__mo">{monthShort(date)}</span>
      </div>
      <div className="day-col__body">
        <DayItems dayKey={dateKey(date)} />
      </div>
      {resizable && (
        <div
          className="day-col__resize"
          onMouseDown={(e) => onResizeStart(e, date)}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  )
}

export default memo(DayColumn)
