import { memo, useRef } from 'react'
import { weekday, monthShort, dayNum, dateKey } from '../../lib/dates'
import DayItems from './DayItems'
import './DayColumn.css'

const SORT_CYCLE = [undefined, 'asc', 'desc'] // default → by-time ↑ → by-time ↓
const SORT_GLYPH = { asc: '↑', desc: '↓' }

// One day. Single-click the header to cycle the note sort (manual → by time ↑ →
// by time ↓, saved per day); double-click toggles full-width expanded mode; the
// right edge resizes all columns. Memoized: only re-renders when its props change.
function DayColumn({
  date,
  style,
  isToday,
  isWeekend,
  isActive,
  resizable,
  sort,
  onSort,
  onActivate,
  onToggleExpand,
  onResizeStart
}) {
  const headClass =
    'day-col__head' +
    (isToday ? ' day-col__head--today' : isWeekend ? ' day-col__head--weekend' : '')

  // disambiguate single (cycle sort) from double (expand) click on the header
  const clickTimer = useRef(0)
  const onHeadClick = () => {
    clearTimeout(clickTimer.current)
    clickTimer.current = setTimeout(() => {
      const next = SORT_CYCLE[(SORT_CYCLE.indexOf(sort) + 1) % SORT_CYCLE.length]
      onSort(dateKey(date), next || 'default')
    }, 220)
  }
  const onHeadDouble = () => {
    clearTimeout(clickTimer.current)
    onToggleExpand(date)
  }

  return (
    <div
      className={isActive ? 'day-col day-col--active' : 'day-col'}
      style={style}
      onClick={() => onActivate(date)}
    >
      <div className={headClass} onClick={onHeadClick} onDoubleClick={onHeadDouble}>
        <span className="day-col__num">{dayNum(date)}</span>
        <span className="day-col__meta">
          <span className="day-col__wd">{weekday(date)}</span>
          <span className="day-col__mo">{monthShort(date)}</span>
        </span>
        <span className={'day-col__sort' + (sort ? ' day-col__sort--on' : '')}>{SORT_GLYPH[sort] || '⇅'}</span>
      </div>
      <div className="day-col__body">
        <DayItems dayKey={dateKey(date)} sort={sort} />
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
