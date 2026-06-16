import { memo, useRef, useState } from 'react'
import api from '../../lib/api'
import { useDayItems, newItem } from '../../hooks/useDayItems'
import { useFolderFilter } from '../../lib/folderFilter'
import { useEverydayProjection } from '../../lib/everydayProjection'
import { parseKey } from '../../lib/dates'
import { loadFormat } from '../../lib/itemFormat'
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
  const { items, add, update, remove, moveToIndex, insertAt } = useDayItems(dayKey)
  const { visibleIds, activeId } = useFolderFilter()
  const proj = useEverydayProjection()
  const [editingId, setEditingId] = useState(null)
  const [draggingId, setDraggingId] = useState(null)
  const [overAt, setOverAt] = useState(-1) // insertion index for the placeholder
  const downEditing = useRef(null)
  const listRef = useRef(null)

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
      rows.push(
        <div className="day-items__row" key={'ev-' + it.id}>
          <DayItem
            item={it}
            dayKey="everyday"
            plain={false}
            noStatus={false}
            dragging={false}
            projected
            onEdit={proj.openEveryday}
            onUpdate={proj.update}
            onRemove={proj.remove}
            onDragStart={() => {}}
            onDragEnd={() => {}}
          />
        </div>
      )
      return
    }
    const i = items.indexOf(it)
    if (!sort && overAt === i) rows.push(ph('ph-' + i))
    rows.push(
      <div className="day-items__row" data-index={i} key={it.id}>
        {editingId === it.id ? (
          <ItemEditor
            initialTitle={it.title || ''}
            initialText={it.text || ''}
            initialBold={!!it.bold}
            initialItalic={!!it.italic}
            initialSize={it.size || 1}
            initialTime={it.time || null}
            timeOnly={dayKey === 'everyday'}
            plain={plain}
            onSave={(f) => {
              update(it.id, {
                title: f.title || null,
                text: f.text,
                bold: f.bold,
                italic: f.italic,
                size: f.size,
                time: f.time || null
              })
              if (f.time)
                api.setReminder?.({ id: it.id, when: f.time, dayKey, title: f.title || 'Calendar', body: f.text })
              else api.clearReminder?.(it.id)
              stop()
            }}
            onCancel={stop}
            onDelete={() => {
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
            onEdit={() => setEditingId(it.id)}
            onUpdate={update}
            onRemove={remove}
            onDragStart={onStart}
            onDragEnd={clearDrag}
          />
        )}
      </div>
    )
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

      {editingId === 'new' &&
        (() => {
          const fmt = loadFormat()
          return (
            <ItemEditor
              initialBold={fmt.bold}
              initialItalic={fmt.italic}
              initialSize={fmt.size}
              timeOnly={dayKey === 'everyday'}
              plain={plain}
              onSave={(f) => {
                const item = {
                  ...newItem(f.text),
                  title: f.title || null,
                  bold: f.bold,
                  italic: f.italic,
                  size: f.size,
                  time: f.time || null,
                  folderId: activeId || null // file new notes into the active folder
                }
                add(item)
                if (item.time)
                  api.setReminder?.({
                    id: item.id,
                    when: item.time,
                    dayKey,
                    title: item.title || 'Calendar',
                    body: item.text
                  })
                stop()
              }}
              onCancel={stop}
              onDelete={stop}
            />
          )
        })()}

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
