import { memo, useRef, useState } from 'react'
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
            onSave={(f) => {
              update(it.id, { title: f.title || null, text: f.text, bold: f.bold, italic: f.italic, size: f.size })
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
              onSave={(f) => {
                add({
                  ...newItem(f.text),
                  title: f.title || null,
                  bold: f.bold,
                  italic: f.italic,
                  size: f.size
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
