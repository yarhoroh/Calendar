import { memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import api from '../../lib/api'
import { updateUiState, registerUi } from '../../lib/uiBridge'
import { useI18n } from '../../i18n/I18nContext'
import { useDayItems, newItem } from '../../hooks/useDayItems'
import { useFolderFilter } from '../../lib/folderFilter'
import { useEverydayProjection } from '../../lib/everydayProjection'
import { parseKey } from '../../lib/dates'
import DayItem from './DayItem'
import ItemEditor from './ItemEditor'
import './DayItems.css'

const NOTE = 'application/x-note'
const isDated = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k)

// HH:mm of a note's time (handles old full datetimes); null = no time
const timeOf = (it) => (it.time ? (it.time.includes('T') ? it.time.split('T')[1] : it.time) : null)
// sort by time; untimed notes sink to the bottom in either direction
const byTime = (mode) => (a, b) => {
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (ta === tb) return 0
  if (ta == null) return 1
  if (tb == null) return -1
  return mode === 'desc' ? tb.localeCompare(ta) : ta.localeCompare(tb)
}

// Notes of one day. One editor slot at a time. Drag-and-drop reorders notes
// within the day and moves them between day columns; a placeholder shows where
// the dragged note will land.
function DayItems({ dayKey, sort }) {
  const { t } = useI18n()
  const { items, add, update, remove, moveToIndex, insertAt } = useDayItems(dayKey)
  const { visibleIds, activeId } = useFolderFilter()
  const proj = useEverydayProjection()
  const [editingId, setEditingId] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [draggingId, setDraggingId] = useState(null)

  const [overAt, setOverAt] = useState(-1) // insertion index for the placeholder
  const downEditing = useRef(null)
  const listRef = useRef(null)

  // publish fullscreen/editing state so the AI knows the current mode. Only the
  // column with an active note publishes; on close it resets the flags.
  useEffect(() => {
    if (expandedId || editingId) updateUiState({ fullscreen: !!expandedId, editing: !!editingId })
    return () => {
      if (expandedId || editingId) updateUiState({ fullscreen: false, editing: false })
    }
  }, [expandedId, editingId])

  // control bus: let the AI enter/leave edit & fullscreen. Every column listens
  // (read live values via the ref); a column serves a call only when it owns the
  // target note, returning undefined otherwise so the right column responds.
  const liveRef = useRef({})
  liveRef.current = { items, editingId, expandedId }
  useEffect(
    () =>
      registerUi((name, arg) => {
        const { items, editingId, expandedId } = liveRef.current
        const id = arg?.id
        const owns = (x) => x != null && items.some((it) => it.id === x)
        switch (name) {
          case 'enterEdit': // edit a given note, or the one already fullscreen here
            if (id != null) return owns(id) ? (setEditingId(id), true) : undefined
            return expandedId != null ? (setEditingId(expandedId), true) : undefined
          case 'enterFullscreen': // fullscreen a given note, or the one being edited here
            if (id != null) return owns(id) ? (setExpandedId(id), true) : undefined
            return editingId != null ? (setExpandedId(editingId), true) : undefined
          case 'exitFullscreen':
            return expandedId != null ? (setExpandedId(null), true) : undefined
          case 'closeEditor':
            if (editingId == null && expandedId == null) return undefined
            setEditingId(null)
            setExpandedId(null)
            return true
          default:
            return undefined
        }
      }),
    []
  )

  // insertion index from the cursor Y — computed in one place to avoid flicker
  const computeIndex = (clientY) => {
    const el = listRef.current
    if (!el) return items.length
    const rows = el.querySelectorAll('[data-index]')
    for (const row of rows) {
      const r = row.getBoundingClientRect()
      if (clientY < r.top + r.height / 2) return Number(row.dataset.index)
    }
    return items.length
  }

  const plain = dayKey === 'general' // general board: no reminder
  const noStatus = false // status is available on every board (incl. everyday & general)

  const stop = () => setEditingId(null)

  // inline edits from the list (e.g. the reminder clock) go through `update`,
  // which doesn't know about Google — wrap it so a linked note's time/title/text
  // change is also pushed to its Google event (main skips read-only calendars)
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(dayKey)
  const updateAndSync = (id, patch) => {
    update(id, patch)
    if (!isDate || !('time' in patch || 'title' in patch || 'text' in patch || 'html' in patch)) return
    const cur = items.find((i) => i.id === id)
    if (!cur?.googleEventId) return
    const m = { ...cur, ...patch }
    const hhmm = m.time ? String(m.time).split('T')[1] || m.time : null
    api.google?.updateEvent?.(m.googleEventId, { title: m.title || '(no title)', day: dayKey, time: hhmm, description: m.text || '' })
  }
  const clearDrag = () => {
    setDraggingId(null)
    setOverAt(-1)
  }

  const onStart = (e, item) => {
    e.dataTransfer.effectAllowed = 'move'
    try {
      e.dataTransfer.setData(NOTE, JSON.stringify({ id: item.id, fromDay: dayKey, item }))
    } catch {
      // ignore
    }
    setDraggingId(item.id)
  }

  const doDrop = async (e) => {
    const raw = e.dataTransfer.getData(NOTE)
    const at = overAt < 0 ? items.length : overAt
    clearDrag()
    if (!raw) return
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
    if (data.fromDay === dayKey) {
      moveToIndex(data.id, at)
    } else if (isDated(dayKey) && isDated(data.fromDay)) {
      // move a note to another day column. Remove from the source FIRST — the
      // note id is a global primary key, so it must not exist in two days at
      // once (main processes these saves in order).
      const src = (await api.getItems?.(data.fromDay)) || []
      api.saveItems?.(data.fromDay, src.filter((i) => i.id !== data.id))
      insertAt({ ...data.item }, at)
      if (data.item.time)
        api.setReminder?.({
          id: data.item.id,
          when: data.item.time,
          dayKey,
          title: data.item.title || 'Calendar',
          body: data.item.text || ''
        })
    }
  }

  const ph = (key) => <div className="day-items__placeholder" key={key} />

  // when a folder is selected, show only notes in it (or its subtree); rows keep
  // their FULL-array index so reorder/drag math stays correct
  const visible = visibleIds ? items.filter((it) => visibleIds.has(it.folderId || null)) : items

  // everyday notes shown as extra notes in the day's list when the calendar
  // "every day" toggle is on. A note's active weekdays are its own `days`, or —
  // if it has none — the global working days from settings.
  const everydayMatches =
    proj.enabled && isDated(dayKey)
      ? proj.items.filter((it) => {
          const eff = Array.isArray(it.days) && it.days.length ? it.days : proj.workingDays
          return eff?.includes(parseKey(dayKey).getDay())
        })
      : []

  // own notes + projected everyday matches, sorted together by time when a sort
  // mode is on. By-time sort is display-only; data-index still points at the
  // stored array, and placeholders/reorder apply to own notes in manual mode only.
  const ownEntries = visible.map((it) => ({ it, projected: false }))
  const projEntries = everydayMatches.map((it) => ({ it, projected: true }))
  const entries = sort
    ? [...ownEntries, ...projEntries].sort((a, b) => byTime(sort)(a.it, b.it))
    : [...ownEntries, ...projEntries]
  const rows = []
  entries.forEach(({ it, projected }) => {
    if (projected) {
      const projRow = (
        <div className={'day-items__row' + (expandedId === it.id ? ' day-items__row--fs' : '')} key={'ev-' + it.id}>
          {expandedId === it.id && (
            <button className="day-item__close" title={t('items.close')} onClick={() => setExpandedId(null)}>
              ✕
            </button>
          )}
          <DayItem
            item={it}
            dayKey="everyday"
            plain={false}
            noStatus={false}
            dragging={false}
            projected
            expanded={expandedId === it.id}
            onExpand={() => setExpandedId(it.id)}
            onEdit={proj.openEveryday}
            onUpdate={proj.update}
            onRemove={proj.remove}
            onDragStart={() => {}}
            onDragEnd={() => {}}
          />
        </div>
      )
      rows.push(expandedId === it.id ? createPortal(projRow, document.body, 'fs-ev-' + it.id) : projRow)
      return
    }
    const i = items.indexOf(it)
    if (!sort && overAt === i) rows.push(ph('ph-' + i))
    const ownRow = (
      <div
        className={'day-items__row' + (expandedId === it.id ? ' day-items__row--fs' : '')}
        data-index={i}
        key={it.id}
      >
        {expandedId === it.id && (
          <button
            className="day-item__close"
            title={t('items.close')}
            onClick={() => {
              setExpandedId(null)
              setEditingId(null)
            }}
          >
            ✕
          </button>
        )}
        {editingId === it.id ? (
          <ItemEditor
            initialTitle={it.title || ''}
            initialText={it.text || ''}
            initialHtml={it.html || ''}
            initialTime={it.time || null}
            initialDays={it.days}
            defaultDays={proj.workingDays}
            noteId={it.id}
            day={dayKey}
            timeOnly={dayKey === 'everyday'}
            plain={plain}
            expanded={expandedId === it.id}
            googleEventId={it.googleEventId}
            googleShared={it.googleShared}
            onExpand={(draft) => {
              if (draft)
                update(it.id, {
                  title: draft.title.trim() || null,
                  text: draft.text,
                  html: draft.html,
                  time: draft.time || null,
                  days: draft.days
                })
              setExpandedId(it.id)
            }}
            onSave={(f) => {
              update(it.id, {
                title: f.title || null,
                text: f.text,
                html: f.html,
                time: f.time || null,
                days: f.days,
                ...(f.google || {}) // fresh share → link the note to the new Google event
              })
              if (f.time)
                api.setReminder?.({ id: it.id, when: f.time, dayKey, title: f.title || 'Calendar', body: f.text, days: f.days })
              else api.clearReminder?.(it.id)
              if (f.google) {
                // just shared → register it so the Appointments tab dedupes it
                if (f.google.googleEventId) api.google?.markImported?.({ gid: f.google.googleEventId, noteId: it.id, day: dayKey })
              } else if (it.googleEventId && /^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
                // editing ANY linked Google note on a real date → push the change up.
                // main skips read-only calendars; dated-only avoids breaking recurring
                // (everyday) series, whose gid is the repeating master.
                const hhmm = f.time ? String(f.time).split('T')[1] || f.time : null
                api.google?.updateEvent?.(it.googleEventId, { title: f.title || '(no title)', day: dayKey, time: hhmm, description: f.text })
              }
              stop()
            }}
            onCancel={stop}
            onDelete={(opts) => {
              if (opts?.deleteGoogle && it.googleEventId) api.google?.deleteEvent?.(it.googleEventId)
              remove(it.id)
              stop()
            }}
          />
        ) : (
          <DayItem
            item={it}
            dayKey={dayKey}
            plain={plain}
            noStatus={noStatus}
            dragging={draggingId === it.id}
            expanded={expandedId === it.id}
            onExpand={() => setExpandedId(it.id)}
            onEdit={() => setEditingId(it.id)}
            onUpdate={updateAndSync}
            onRemove={remove}
            onDragStart={onStart}
            onDragEnd={clearDrag}
          />
        )}
      </div>
    )
    // a fullscreen note is portalled to <body> so it escapes the column's paint
    // containment and covers the whole window (below the titlebar)
    rows.push(expandedId === it.id ? createPortal(ownRow, document.body, 'fs-' + it.id) : ownRow)
  })
  if (!sort && overAt >= items.length && overAt !== -1) rows.push(ph('ph-end'))

  return (
    <div
      className="day-items"
      ref={listRef}
      onDragOver={(e) => {
        if (!e.dataTransfer.types?.includes(NOTE)) return
        e.preventDefault()
        setOverAt(computeIndex(e.clientY))
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOverAt(-1)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types?.includes(NOTE)) return
        e.preventDefault()
        doDrop(e)
      }}
    >
      {rows}

      {editingId === 'new' && (
        <ItemEditor
          defaultDays={proj.workingDays}
          day={dayKey}
          timeOnly={dayKey === 'everyday'}
          plain={plain}
          // expanding a brand-new note: persist it now (so it has an id and can be
          // portalled fullscreen) and keep editing it as a normal note — this also
          // means the draft survives the remount instead of being lost
          onExpand={(draft) => {
            const item = {
              ...newItem(draft?.text || ''),
              title: draft?.title?.trim() || null,
              html: draft?.html || '',
              time: draft?.time || null,
              days: draft?.days,
              folderId: activeId || null
            }
            add(item)
            setEditingId(item.id)
            setExpandedId(item.id)
          }}
          onSave={(f) => {
            const item = {
              ...newItem(f.text),
              title: f.title || null,
              html: f.html,
              time: f.time || null,
              days: f.days,
              folderId: activeId || null, // file new notes into the active folder
              ...(f.google || {}) // shared straight from a new note → link it
            }
            add(item)
            if (item.time)
              api.setReminder?.({
                id: item.id,
                when: item.time,
                dayKey,
                title: item.title || 'Calendar',
                body: item.text,
                days: item.days
              })
            if (f.google) api.google?.markImported?.({ gid: f.google.googleEventId, noteId: item.id, day: dayKey })
            stop()
          }}
          onCancel={stop}
          onDelete={stop}
        />
      )}

      <div
        className="day-items__add"
        onMouseDown={() => {
          downEditing.current = editingId
        }}
        onClick={() => {
          if (downEditing.current == null) setEditingId('new')
        }}
      />
    </div>
  )
}

export default memo(DayItems)
