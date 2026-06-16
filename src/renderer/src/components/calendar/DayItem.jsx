import { useEffect, useRef, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import { useFolderFilter } from '../../lib/folderFilter'
import { BUILTIN_SET, useCustomStatuses } from '../../lib/statuses'
import { CheckIcon, CloseIcon, CalendarIcon, PaperclipIcon } from '../icons'
import StatusMenu from './StatusMenu'
import ReminderPopover from './ReminderPopover'
import AttachmentsPopover from './AttachmentsPopover'
import ContextMenu from '../ContextMenu'
import './DayItem.css'

// A saved note (view only). Double-click to edit, drag to reorder. Reminder +
// status controls sit in the top-right.
export default function DayItem({
  item,
  dayKey,
  plain,
  noStatus,
  dragging,
  onEdit,
  onUpdate,
  onRemove,
  onDragStart,
  onDragEnd
}) {
  const { t } = useI18n()
  const { names } = useFolderFilter()
  const customStatuses = useCustomStatuses()
  const folderName = item.folderId ? names[item.folderId] : null
  const customStatus = !BUILTIN_SET.has(item.status) ? customStatuses.find((c) => c.id === item.status) : null
  const [statusMenu, setStatusMenu] = useState(false)
  const [reminderOpen, setReminderOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachCount, setAttachCount] = useState(0)
  const [fileOver, setFileOver] = useState(false)
  const [menu, setMenu] = useState(null) // {x,y} for the right-click menu

  const copyNote = () => {
    const txt = (item.title ? item.title + '\n' : '') + (item.text || '')
    navigator.clipboard?.writeText(txt)
  }
  const remBtnRef = useRef(null)
  const clipBtnRef = useRef(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      Promise.resolve(api.listAttachments?.(item.id)).then((r) => alive && setAttachCount((r || []).length))
    load()
    const off = api.onAttachChanged?.((p) => {
      if (!p || p.noteId === item.id) load()
    })
    return () => {
      alive = false
      off?.()
    }
  }, [item.id])

  const struck = item.status === 'done' || item.status === 'cancelled'
  const fired = dayKey !== 'everyday' && item.time ? new Date(item.time).getTime() <= Date.now() : false
  const remClass = item.time ? (fired ? ' day-item__ctrl-btn--fired' : ' day-item__ctrl-btn--on') : ''

  const setTime = (when) => {
    onUpdate(item.id, { time: when })
    api.setReminder?.({
      id: item.id,
      when,
      dayKey,
      title: item.title || 'Calendar',
      body: item.text || ''
    })
  }
  const clearTime = () => {
    onUpdate(item.id, { time: null })
    api.clearReminder?.(item.id)
    setReminderOpen(false)
  }

  return (
    <div
      className={
        'day-item' +
        (struck ? ' day-item--struck' : '') +
        (fileOver ? ' day-item--drop' : '') +
        (dragging ? ' day-item--dragging' : '')
      }
      draggable
      onDragStart={(e) => onDragStart(e, item)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        // only handle OS files here; note-reorder index is computed by the
        // container (single source of truth → no flicker)
        if (e.dataTransfer.types?.includes('Files')) {
          e.preventDefault()
          setFileOver(true)
        }
      }}
      onDragLeave={() => setFileOver(false)}
      onDrop={async (e) => {
        const dropped = Array.from(e.dataTransfer.files || [])
        if (!dropped.length) return // note moves are handled by the container
        e.preventDefault()
        e.stopPropagation()
        setFileOver(false)
        for (const f of dropped) {
          const p = api.pathForFile?.(f)
          if (p) await api.addAttachmentPath?.(item.id, p)
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onEdit()
      }}
    >
      <div className="day-item__right">
      <div className="day-item__controls">
        {!plain && (
        <div className="day-item__ctrl day-item__ctrl--rem">
          {item.time && (
            <span className={'day-item__time' + (fired ? ' day-item__time--fired' : ' day-item__time--on')}>
              {item.time.split('T')[1] || item.time}
            </span>
          )}
          <button
            ref={remBtnRef}
            className={'day-item__ctrl-btn' + remClass}
            title={t('items.reminder')}
            onClick={(e) => {
              e.stopPropagation()
              setReminderOpen((v) => !v)
            }}
          >
            <CalendarIcon />
          </button>
          {reminderOpen && (
            <ReminderPopover
              anchorRef={remBtnRef}
              value={item.time}
              timeOnly={dayKey === 'everyday'}
              onChange={setTime}
              onClear={clearTime}
              onClose={() => setReminderOpen(false)}
            />
          )}
        </div>
        )}

        <div className="day-item__ctrl">
          <button
            ref={clipBtnRef}
            className={'day-item__ctrl-btn' + (attachCount ? ' day-item__ctrl-btn--on' : '')}
            title={t('attach.title')}
            onClick={(e) => {
              e.stopPropagation()
              setAttachOpen((v) => !v)
            }}
          >
            <PaperclipIcon />
            {attachCount > 0 && <span className="day-item__clip-count">{attachCount}</span>}
          </button>
          {attachOpen && (
            <AttachmentsPopover
              anchorRef={clipBtnRef}
              noteId={item.id}
              onClose={() => setAttachOpen(false)}
            />
          )}
        </div>

        {!noStatus && (
        <div className="day-item__ctrl day-item__ctrl--status">
          <button
            className="day-item__ctrl-btn"
            onClick={(e) => {
              e.stopPropagation()
              setStatusMenu((v) => !v)
            }}
          >
            {BUILTIN_SET.has(item.status) ? (
              <span className={`status-ring status-ring--${item.status}`}>
                {item.status === 'done' && <CheckIcon />}
                {item.status === 'cancelled' && <CloseIcon />}
              </span>
            ) : customStatus ? (
              <span className="status-ring" style={{ borderColor: customStatus.color, background: customStatus.color }} />
            ) : (
              <span className="status-ring status-ring--todo" />
            )}
          </button>
          {statusMenu && (
            <StatusMenu
              current={item.status}
              onPick={(s) => {
                onUpdate(item.id, { status: s })
                setStatusMenu(false)
              }}
              onClose={() => setStatusMenu(false)}
            />
          )}
        </div>
        )}
      </div>
      </div>

      <div className={'day-item__content' + (item.size > 1 ? ` day-item__content--s${item.size}` : '')}>
        {item.title && (
          <div
            className="day-item__title"
            onClick={(e) => {
              e.stopPropagation()
              onUpdate(item.id, { collapsed: !item.collapsed })
            }}
          >
            {item.title}
          </div>
        )}
        <div
          className={'day-item__text' + (item.collapsed ? ' day-item__text--collapsed' : '')}
          style={{
            fontWeight: item.bold ? 700 : undefined,
            fontStyle: item.italic ? 'italic' : undefined
          }}
        >
          {item.text}
        </div>
      </div>

      {folderName && <span className="day-item__folder">{folderName}</span>}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ label: t('items.copy'), onClick: copyNote }]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
