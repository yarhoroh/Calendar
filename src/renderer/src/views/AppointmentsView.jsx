import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import api from '../lib/api'
import { useI18n } from '../i18n/I18nContext'
import { startOfToday, addDays, dateKey, parseKey, weekday, monthShort, dayNum, isWeekend, sameDay } from '../lib/dates'
import { importGoogleEvent, importGoogleEventEveryday, syncImportedNote } from '../lib/importGoogle'
import { runGoogleAutoSync } from '../lib/autoSyncGoogle'
import { GoogleIcon } from '../components/icons'
import './AppointmentsView.css'

const CHUNK = 10 // days pulled per step; the view tops up until the screen is filled
const GCAL_URL = 'https://calendar.google.com'

const Spinner = ({ sm }) => <span className={'spinner' + (sm ? ' spinner--sm' : '')} aria-hidden />


// Infinite agenda of Google Calendar events: scroll up for past days, down for
// future, lazily pulling each new date range. Today is highlighted green,
// weekends red — like the main calendar. One-way (read-only) import.
export default function AppointmentsView({ onJump }) {
  const { t } = useI18n()
  const today = startOfToday()
  const todayKey = dateKey(today)

  const [accounts, setAccounts] = useState([])
  const [eventsByDay, setEventsByDay] = useState({})
  const [range, setRange] = useState({ start: todayKey, end: dateKey(addDays(today, CHUNK)) })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [syncedId, setSyncedId] = useState(null) // brief ✓ after a manual sync
  const [syncingAll, setSyncingAll] = useState(false) // "Sync" button in the bar
  const [openSet, setOpenSet] = useState(() => new Set()) // event gids whose body is expanded
  const [loading, setLoading] = useState(true) // initial / refresh fetch
  const [loadingMore, setLoadingMore] = useState(null) // 'top' | 'bottom' | null
  const [notice, setNotice] = useState('') // e.g. complex-recurrence message

  const scrollRef = useRef(null)
  const loadingRef = useRef(false)
  const prependRef = useRef(null) // height snapshot for scroll preservation on prepend
  const rangeRef = useRef(range)
  rangeRef.current = range
  const eventsRef = useRef(eventsByDay)
  eventsRef.current = eventsByDay

  // fetch a date range and merge it in, replacing those days' buckets
  const fetchRange = useCallback(async (from, to) => {
    const evs = (await api.google?.listEvents?.(from, to)) || []
    const grouped = {}
    for (const ev of evs) (grouped[ev.day] = grouped[ev.day] || []).push(ev)
    setEventsByDay((prev) => {
      const next = { ...prev }
      let d = parseKey(from)
      const end = parseKey(to)
      while (d <= end) {
        const k = dateKey(d)
        next[k] = grouped[k] || []
        d = addDays(d, 1)
      }
      return next
    })
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    const accs = (await api.google?.listAccounts?.()) || []
    setAccounts(accs)
    const sel = accs.some((a) => a.calendars?.some((c) => c.selected))
    setPickerOpen((p) => p || !sel)
    setEventsByDay({})
    await fetchRange(todayKey, dateKey(addDays(today, CHUNK)))
    setRange({ start: todayKey, end: dateKey(addDays(today, CHUNK)) })
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchRange])

  useEffect(() => {
    reload()
  }, [reload])

  // when notes change anywhere (e.g. an imported note is deleted), re-check the
  // import flags instantly — cheap DB check, no Google fetch, no scroll reset
  useEffect(() => {
    const off = api.onItemsChanged?.(async () => {
      const items = []
      for (const list of Object.values(eventsRef.current)) {
        for (const e of list)
          items.push({ googleEventId: e.googleEventId, account: e.account, calendarId: e.calendarId, recurringEventId: e.recurringEventId })
      }
      if (!items.length) return
      const status = await api.google?.importedStatus?.(items)
      if (!status) return
      setEventsByDay((prev) => {
        const next = {}
        for (const k of Object.keys(prev)) {
          next[k] = prev[k].map((e) => {
            const s = status[e.googleEventId]
            return s ? { ...e, imported: s.imported, importedDay: s.importedDay } : e
          })
        }
        return next
      })
    })
    return () => off?.()
  }, [])

  // when WE create/update/delete an event on Google (sharing a note, editing or
  // deleting a shared one), re-fetch the loaded range so it appears/updates here
  // immediately — no manual Refresh
  useEffect(() => {
    const off = api.google?.onChanged?.(() => {
      const r = rangeRef.current
      fetchRange(r.start, r.end)
    })
    return () => off?.()
  }, [fetchRange])

  const loadFuture = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoadingMore('bottom')
    const from = dateKey(addDays(parseKey(rangeRef.current.end), 1))
    const to = dateKey(addDays(parseKey(rangeRef.current.end), CHUNK))
    await fetchRange(from, to)
    setRange((r) => ({ ...r, end: to }))
    loadingRef.current = false
    setLoadingMore(null)
  }, [fetchRange])

  const loadPast = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoadingMore('top')
    const el = scrollRef.current
    prependRef.current = { h: el?.scrollHeight || 0, top: el?.scrollTop || 0 }
    const to = dateKey(addDays(parseKey(rangeRef.current.start), -1))
    const from = dateKey(addDays(parseKey(rangeRef.current.start), -CHUNK))
    await fetchRange(from, to)
    setRange((r) => ({ ...r, start: from }))
    loadingRef.current = false
    setLoadingMore(null)
  }, [fetchRange])

  // top up future days until the agenda actually overflows — so we only load
  // what's needed to fill the screen (and refill when the window grows)
  const ensureFilled = useCallback(() => {
    const el = scrollRef.current
    // clientHeight 0 = the tab is hidden (display:none) — don't loop-fetch then
    if (el && el.clientHeight > 0 && !loadingRef.current && el.scrollHeight <= el.clientHeight + 4) loadFuture()
  }, [loadFuture])

  useEffect(() => {
    ensureFilled()
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => ensureFilled())
    ro.observe(el)
    return () => ro.disconnect()
  }, [ensureFilled, range])

  // keep the viewport stable when older days are prepended above
  useLayoutEffect(() => {
    const p = prependRef.current
    const el = scrollRef.current
    if (p && el) {
      el.scrollTop = el.scrollHeight - p.h + p.top
      prependRef.current = null
    }
  }, [range.start])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el || loadingRef.current) return
    if (el.scrollTop < 250) loadPast()
    else if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadFuture()
  }

  // scroll only the agenda to today (never the outer layout)
  const scrollToToday = () => {
    const el = scrollRef.current
    const todayEl = el?.querySelector('.agenda-day--today')
    if (el && todayEl) el.scrollTop += todayEl.getBoundingClientRect().top - el.getBoundingClientRect().top - 6
  }

  const connect = async () => {
    const r = await api.google?.connect?.()
    if (r?.ok) reload()
  }

  const toggleCalendar = async (acc, calId) => {
    const selected = acc.calendars.filter((c) => c.selected).map((c) => c.id)
    const next = selected.includes(calId) ? selected.filter((id) => id !== calId) : [...selected, calId]
    await api.google?.setCalendars?.(acc.email, next)
    reload()
  }

  // mode: 'day' = this occurrence onto its date; 'every' = the whole series onto everyday
  const importEv = async (ev, mode) => {
    setBusyId(ev.googleEventId)
    setNotice('')
    const res = mode === 'every' ? await importGoogleEventEveryday(ev) : await importGoogleEvent(ev)
    if (res?.unsupported) {
      setNotice(t('appointments.complexRecurrence'))
      setBusyId(null)
      return
    }
    const day = res?.day
    setEventsByDay((prev) => {
      const next = {}
      for (const k of Object.keys(prev)) {
        next[k] = prev[k].map((e) => {
          const hit =
            mode === 'every'
              ? e.recurringEventId && e.recurringEventId === ev.recurringEventId
              : e.googleEventId === ev.googleEventId
          return hit ? { ...e, imported: true, importedDay: day } : e
        })
      }
      return next
    })
    setBusyId(null)
  }

  // sync ALL auto-sync calendars now (the bar "Sync" button) — don't wait for the timer
  const runSyncAll = async () => {
    setSyncingAll(true)
    await runGoogleAutoSync()
    setSyncingAll(false)
  }

  // sync this one event now: import it if new, or pull Google changes onto the
  // linked note if already imported (the items:changed listener refreshes flags)
  const syncEv = async (ev) => {
    setBusyId(ev.googleEventId)
    if (ev.imported) await syncImportedNote(ev)
    else if (ev.recurring) {
      const r = await importGoogleEventEveryday(ev)
      if (r?.unsupported) await importGoogleEvent(ev)
    } else await importGoogleEvent(ev)
    setBusyId(null)
    // brief ✓ so a fast (local) sync is still visibly confirmed
    setSyncedId(ev.googleEventId)
    setTimeout(() => setSyncedId((id) => (id === ev.googleEventId ? null : id)), 1500)
  }

  // undo an import right from here (deletes the linked note); the items:changed
  // listener flips the event back to importable
  const unimportEv = (ev) =>
    api.google?.unimport?.({
      googleEventId: ev.googleEventId,
      account: ev.account,
      calendarId: ev.calendarId,
      recurringEventId: ev.recurringEventId
    })

  // click a card to expand/collapse its description (event body)
  const toggleOpen = (gid) =>
    setOpenSet((prev) => {
      const next = new Set(prev)
      next.has(gid) ? next.delete(gid) : next.add(gid)
      return next
    })

  const hasAccounts = accounts.length > 0
  const anySelected = accounts.some((a) => a.calendars?.some((c) => c.selected))

  // every day in the loaded range (continuous, like a calendar)
  const days = []
  for (let d = parseKey(range.start); d <= parseKey(range.end); d = addDays(d, 1)) days.push(new Date(d))

  return (
    <div className="appointments">
      <div className="appointments__bar">
        <span className="appointments__title">
          {t('nav.appointments')}
          {loading && <Spinner sm />}
        </span>
        <div className="appointments__bar-actions">
          {hasAccounts && anySelected && (
            <button className="btn" onClick={scrollToToday}>
              {t('calendar.today')}
            </button>
          )}
          {hasAccounts && (
            <button className={'btn' + (pickerOpen ? ' btn--primary' : '')} onClick={() => setPickerOpen((o) => !o)}>
              {t('appointments.calendars')}
            </button>
          )}
          <button className="btn btn--icon" title={t('appointments.openGoogle')} onClick={() => api.openExternal?.(GCAL_URL)}>
            <GoogleIcon />
          </button>
          <button className="btn" onClick={reload}>
            {t('appointments.refresh')}
          </button>
          {hasAccounts && anySelected && (
            <button className="btn" onClick={runSyncAll} disabled={syncingAll} title={t('appointments.syncAllHint')}>
              {syncingAll ? <Spinner sm /> : t('appointments.syncAll')}
            </button>
          )}
        </div>
      </div>

      {notice && <div className="appointments__notice">{notice}</div>}

      {pickerOpen && hasAccounts && (
        <div className="appointments__cals">
          <span className="appointments__cals-label">{t('appointments.pickCalendars')}</span>
          {accounts.map((acc) => (
            <div className="appointments__cal-group" key={acc.email}>
              {accounts.length > 1 && <span className="appointments__cal-acc">{acc.email}</span>}
              {(acc.calendars || []).map((c) => (
                <button
                  key={acc.email + c.id}
                  className={'cal-chip' + (c.selected ? ' cal-chip--on' : '')}
                  onClick={() => toggleCalendar(acc, c.id)}
                  title={acc.email}
                >
                  {c.color && <span className="cal-chip__dot" style={{ background: c.color }} />}
                  {c.summary}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {!hasAccounts ? (
        loading ? (
          <div className="appointments__empty">
            <Spinner />
          </div>
        ) : (
          <div className="appointments__empty">
            <p>{t('appointments.noAccounts')}</p>
            <button className="btn btn--primary" onClick={connect}>
              {t('settings.google.connect')}
            </button>
          </div>
        )
      ) : !anySelected ? (
        <div className="appointments__empty">{t('appointments.pickHint')}</div>
      ) : (
        <div className="appointments__agenda" ref={scrollRef} onScroll={onScroll}>
          {loadingMore === 'top' && (
            <div className="agenda-more">
              <Spinner sm />
            </div>
          )}
          {days.map((d) => {
            const key = dateKey(d)
            const evs = eventsByDay[key] || []
            const cls =
              'agenda-day' +
              (sameDay(d, today) ? ' agenda-day--today' : isWeekend(d) ? ' agenda-day--weekend' : '')
            return (
              <div className={cls} key={key}>
                <div className="agenda-day__head">
                  <span className="agenda-day__num">{dayNum(d)}</span>
                  <span className="agenda-day__wd">{weekday(d)}</span>
                  <span className="agenda-day__mo">{monthShort(d)}</span>
                </div>
                <div className="agenda-day__events">
                  {evs.length === 0 ? (
                    <span className="agenda-day__none">·</span>
                  ) : (
                    evs.map((ev) => (
                      <div className="appt-card" key={ev.googleEventId}>
                        <span className="appt-card__time">{ev.allDay ? t('appointments.allDay') : ev.time}</span>
                        <div
                          className={'appt-card__body' + (ev.description ? ' appt-card__body--clickable' : '')}
                          onClick={ev.description ? () => toggleOpen(ev.googleEventId) : undefined}
                        >
                          <div className="appt-card__title">
                            {ev.appCreated && (
                              <button
                                className={'appt-card__mine' + (syncedId === ev.googleEventId ? ' is-synced' : '')}
                                title={t('appointments.syncNow')}
                                disabled={busyId === ev.googleEventId}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  syncEv(ev)
                                }}
                              >
                                {busyId === ev.googleEventId ? (
                                  <Spinner sm />
                                ) : syncedId === ev.googleEventId ? (
                                  '✓'
                                ) : (
                                  '⟳'
                                )}
                              </button>
                            )}
                            {ev.htmlLink ? (
                              <a
                                href="#"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  api.openExternal?.(ev.htmlLink)
                                }}
                              >
                                {ev.title}
                              </a>
                            ) : (
                              ev.title
                            )}
                          </div>
                          <div className="appt-card__meta">
                            {ev.calendarName}
                            {ev.location ? ` · ${ev.location}` : ''}
                          </div>
                          {ev.description && openSet.has(ev.googleEventId) && (
                            <div className="appt-card__desc" onClick={(e) => e.stopPropagation()}>
                              {ev.description}
                            </div>
                          )}
                        </div>
                        <div className="appt-card__actions">
                          {ev.imported ? (
                            <>
                              <button
                                className="btn appt-card__open"
                                title={t('appointments.openInCalendar')}
                                onClick={() => onJump?.(ev.importedDay)}
                              >
                                {t('appointments.imported')} ↗
                              </button>
                              <button
                                className="btn appt-card__x"
                                title={t('appointments.unimport')}
                                onClick={() => unimportEv(ev)}
                              >
                                ✕
                              </button>
                            </>
                          ) : ev.recurring ? (
                            <>
                              <button className="btn" onClick={() => importEv(ev, 'day')} disabled={busyId === ev.googleEventId}>
                                {t('appointments.thisDay')}
                              </button>
                              <button className="btn btn--primary" onClick={() => importEv(ev, 'every')} disabled={busyId === ev.googleEventId}>
                                {t('appointments.everyDay')}
                              </button>
                            </>
                          ) : (
                            <button className="btn btn--primary" onClick={() => importEv(ev, 'day')} disabled={busyId === ev.googleEventId}>
                              {t('appointments.import')}
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )
          })}
          {loadingMore === 'bottom' && (
            <div className="agenda-more">
              <Spinner sm />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
