import { memo, useRef, useState } from 'react'
import api from '../../lib/api'
import { useDayItems, newItem } from '../../hooks/useDayItems'
import { useFolderFilter } from '../../lib/folderFilter'
import { loadFormat } from '../../lib/itemFormat'
import DayItem from './DayItem'
import ItemEditor from './ItemEditor'
import './DayItems.css'

const NOTE = 'application/x-note'
const isDated = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k)

// Notes of one day. One editor slot at a time. Drag-and-drop reorders notes
// within the day and moves them between day columns; a placeholder shows where
// the dragged note will land.
function DayItems({ dayKey }) {
  const { items, add, update, remove, moveToIndex, insertAt } = useDayItems(dayKey)
  const { visibleIds, activeId } = useFolderFilter()
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
  const rows = []
  visible.forEach((it) => {
    const i = items.indexOf(it)
    if (overAt === i) rows.push(ph('ph-' + i))
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
  if (overAt >= items.length && overAt !== -1) rows.push(ph('ph-end'))

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
