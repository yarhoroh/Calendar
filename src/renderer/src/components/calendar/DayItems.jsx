import { memo, useRef, useState } from 'react'
import api from '../../lib/api'
import { useDayItems, newItem } from '../../hooks/useDayItems'
import { loadFormat } from '../../lib/itemFormat'
import DayItem from './DayItem'
import ItemEditor from './ItemEditor'
import './DayItems.css'

// Notes of one day. One editor slot at a time (editingId = item id | 'new' |
// null). Clicking the empty area starts a new note only when nothing is being
// edited; otherwise the open editor just commits (no stray draft).
function DayItems({ dayKey }) {
  const { items, add, update, remove, reorder } = useDayItems(dayKey)
  const [editingId, setEditingId] = useState(null)
  const dragId = useRef(null)
  const downEditing = useRef(null)
  const plain = dayKey === 'general' // general board: no reminder
  const noStatus = plain || dayKey === 'everyday' // everyday & general: no status

  const stop = () => setEditingId(null)

  return (
    <div className="day-items">
      {items.map((it) =>
        editingId === it.id ? (
          <ItemEditor
            key={it.id}
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
            key={it.id}
            item={it}
            dayKey={dayKey}
            plain={plain}
            noStatus={noStatus}
            onEdit={() => setEditingId(it.id)}
            onUpdate={update}
            onRemove={remove}
            onDragStart={(id) => {
              dragId.current = id
            }}
            onDrop={(targetId) => {
              if (dragId.current) reorder(dragId.current, targetId)
              dragId.current = null
            }}
          />
        )
      )}

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
                  time: f.time || null
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
