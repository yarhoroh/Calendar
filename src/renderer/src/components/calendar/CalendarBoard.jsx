import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import DayColumn from './DayColumn'
import DayItems from './DayItems'
import MonthPicker from './MonthPicker'
import { ChevronLeftIcon, ChevronRightIcon } from '../icons'
import { sameDay, startOfToday, addDays, isWeekend, dateNumeric, daysDiff, parseKey } from '../../lib/dates'
import { useCalendarSettings } from '../../hooks/useCalendarSettings'
import { useI18n } from '../../i18n/I18nContext'
import './CalendarBoard.css'

const MIN_W = 120
const MAX_W = 900
const BUFFER = 2

const clamp = (v, a, b) => Math.min(Math.max(v, a), b)

// Truly infinite calendar: nothing is pre-generated and there is no scroll
// container. `origin` is the (fractional) day offset from today shown at the
// left edge; only the visible columns are rendered and dates are derived on
// the fly, so you can scroll forever in either direction.
export default function CalendarBoard({ focusRequest }) {
  const { t, lang } = useI18n()
  const { settings, loaded, update } = useCalendarSettings()
  const viewportRef = useRef(null)

  const [today] = useState(() => startOfToday())
  const [origin, setOriginState] = useState(0)
  const [colWidth, setColWidth] = useState(settings.colWidth)
  const [containerWidth, setContainerWidth] = useState(0)
  const [activeTs, setActiveTs] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [grabbing, setGrabbing] = useState(false)
  const [everyday, setEveryday] = useState(false)

  const expanded = settings.expanded
  const colW = expanded ? containerWidth || colWidth : colWidth

  // refs mirror state for the stable callbacks / animation loops
  const originRef = useRef(0)
  originRef.current = origin
  const colWidthRef = useRef(colWidth)
  colWidthRef.current = colWidth
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const rafRef = useRef(0)
  const wheelSnapRef = useRef(0)

  const setOrigin = (v) => setOriginState(v)

  useLayoutEffect(() => {
    if (loaded) setColWidth(settings.colWidth)
  }, [loaded, settings.colWidth])

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth))
    ro.observe(el)
    setContainerWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [loaded])

  const effW = () => (expandedRef.current ? viewportRef.current?.clientWidth || colWidthRef.current : colWidthRef.current)

  const animateOrigin = (target, duration, from = originRef.current) => {
    cancelAnimationFrame(rafRef.current)
    const dist = target - from
    if (Math.abs(dist) < 0.0005) {
      setOrigin(target)
      return
    }
    const start = performance.now()
    const ease = (x) => 1 - Math.pow(1 - x, 3)
    const step = (now) => {
      const x = Math.min((now - start) / duration, 1)
      setOrigin(from + dist * ease(x))
      if (x < 1) rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
  }

  const startMomentum = (vPx, width) => {
    let v = clamp(vPx, -6, 6)
    let cur = originRef.current
    let last = performance.now()
    const friction = 0.9
    const step = (now) => {
      const dt = now - last || 16
      last = now
      cur -= (v * dt) / width
      setOrigin(cur)
      v *= Math.pow(friction, dt / 16)
      if (Math.abs(v) > 0.05) rafRef.current = requestAnimationFrame(step)
      else animateOrigin(Math.round(cur), 150, cur)
    }
    rafRef.current = requestAnimationFrame(step)
  }

  const nav = (dir) => animateOrigin(Math.round(originRef.current) + dir, 240)
  const goToday = () => {
    setEveryday(false)
    animateOrigin(0, 280)
  }

  const jumpToDate = (date) => {
    setPickerOpen(false)
    setEveryday(false)
    animateOrigin(daysDiff(date, today), 300)
  }

  // jump here when a reminder toast is opened
  useEffect(() => {
    if (focusRequest) animateOrigin(daysDiff(parseKey(focusRequest.key), today), 320)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest])

  const onWheel = (e) => {
    // vertical wheel scrolls the column under the cursor; only horizontal
    // (trackpad / shift-wheel) pans the calendar
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    cancelAnimationFrame(rafRef.current)
    const width = colW || colWidth
    setOriginState((o) => o + e.deltaX / width)
    clearTimeout(wheelSnapRef.current)
    wheelSnapRef.current = setTimeout(() => animateOrigin(Math.round(originRef.current), 150), 130)
  }

  // Ctrl + drag pans, with inertia + snap on release
  const onMouseDown = (e) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    cancelAnimationFrame(rafRef.current)
    const width = effW()
    setGrabbing(true)
    let lastX = e.clientX
    let lastT = performance.now()
    let vel = 0
    const onMove = (ev) => {
      const now = performance.now()
      const dx = ev.clientX - lastX
      const dt = now - lastT || 16
      setOriginState((o) => o - dx / width)
      vel = dx / dt
      lastX = ev.clientX
      lastT = now
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setGrabbing(false)
      startMomentum(vel, width)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // stable handlers for the memoized columns
  const handleActivate = useCallback((date) => setActiveTs(date.getTime()), [])

  const handleToggleExpand = useCallback(
    (date) => {
      update({ expanded: !expandedRef.current })
      setOrigin(daysDiff(date, today))
    },
    [update, today]
  )

  const handleResizeStart = useCallback(
    (e, date) => {
      if (expandedRef.current) return
      e.preventDefault()
      const k0 = daysDiff(date, today)
      const startW = colWidthRef.current
      const left0 = (k0 - originRef.current) * startW
      const startX = e.clientX
      let latest = startW
      const onMove = (ev) => {
        latest = clamp(startW + (ev.clientX - startX), MIN_W, MAX_W)
        setColWidth(latest)
        setOrigin(k0 - left0 / latest) // keep the grabbed column anchored
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        update({ colWidth: latest })
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [update, today]
  )

  if (!loaded) return <div className="calendar-board" />

  const leftDate = addDays(today, Math.round(origin))

  // which day offsets are visible right now
  const columns = []
  if (colW > 0 && containerWidth > 0) {
    const perScreen = Math.ceil(containerWidth / colW)
    const first = Math.floor(origin) - BUFFER
    const last = Math.floor(origin) + perScreen + BUFFER
    for (let k = first; k <= last; k++) columns.push(k)
  }

  return (
    <div className="calendar-board">
      <div className="calendar-board__toolbar">
        <button
          className="cal-btn"
          title={t('calendar.prev')}
          disabled={everyday}
          onClick={() => nav(-1)}
        >
          <ChevronLeftIcon />
        </button>
        <button
          className="cal-btn"
          title={t('calendar.next')}
          disabled={everyday}
          onClick={() => nav(1)}
        >
          <ChevronRightIcon />
        </button>
        <button className="cal-btn" onClick={goToday}>
          {t('calendar.today')}
        </button>
        <button
          className={'cal-btn' + (everyday ? ' cal-btn--active' : '')}
          onClick={() => setEveryday((e) => !e)}
        >
          {t('calendar.everyday')}
        </button>
        <div className="calendar-board__month">
          <button
            className="calendar-board__label"
            onClick={() => setPickerOpen((o) => !o)}
            title={t('calendar.pickDate')}
          >
            {dateNumeric(leftDate)}
          </button>
          {pickerOpen && (
            <MonthPicker
              selected={leftDate}
              today={today}
              onPick={jumpToDate}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>
      </div>

      {everyday ? (
        <div className="calendar-board__everyday">
          <DayItems dayKey="everyday" />
        </div>
      ) : (
        <div
          ref={viewportRef}
          className={'calendar-board__viewport' + (grabbing ? ' calendar-board__viewport--grabbing' : '')}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
        >
          {columns.map((k) => {
            const date = addDays(today, k)
            return (
              <DayColumn
                key={k}
                date={date}
                lang={lang}
                style={{ left: `${(k - origin) * colW}px`, width: `${colW}px` }}
                isToday={sameDay(date, today)}
                isWeekend={isWeekend(date)}
                isActive={activeTs === date.getTime()}
                resizable={!expanded}
                onActivate={handleActivate}
                onToggleExpand={handleToggleExpand}
                onResizeStart={handleResizeStart}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
