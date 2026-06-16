import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea'
import { saveFormat } from '../../lib/itemFormat'
import { CheckIcon, CloseIcon, CalendarIcon } from '../icons'
import ReminderPopover from './ReminderPopover'
import ContextMenu from '../ContextMenu'
import './ItemEditor.css'

const SIZES = [1, 2, 3]

// Inline note editor. Title + plain multi-line body. Sticky toggles (bold /
// italic / size) plus a reminder (calendar) button to set the time right here.
// Enter = new line, Ctrl+Enter = save, blur = auto-save.
export default function ItemEditor({
  initialTitle = '',
  initialText = '',
  initialBold = false,
  initialItalic = false,
  initialSize = 1,
  initialTime = null,
  timeOnly = false,
  plain = false,
  onSave,
  onCancel,
  onDelete
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState(initialTitle)
  const [text, setText] = useState(initialText)
  const [bold, setBold] = useState(initialBold)
  const [italic, setItalic] = useState(initialItalic)
  const [size, setSize] = useState(initialSize)
  const [time, setTime] = useState(initialTime)
  const [remOpen, setRemOpen] = useState(false)
  const [menu, setMenu] = useState(null) // right-click menu state
  const ref = useAutosizeTextarea(text, 10)
  const remBtnRef = useRef(null)
  const titleRef = useRef(null)
  // custom undo history — controlled inputs break the browser's native Ctrl+Z
  const histRef = useRef([])
  const lastSnap = useRef(0)
  const snapshot = (force) => {
    const now = Date.now()
    if (force || now - lastSnap.current > 400) {
      histRef.current.push({ title, text })
      if (histRef.current.length > 100) histRef.current.shift()
      lastSnap.current = now
    }
  }
  const undo = () => {
    const snap = histRef.current.pop()
    if (snap) {
      setTitle(snap.title)
      setText(snap.text)
    }
  }

  const openMenu = (e, field) => {
    e.preventDefault()
    e.stopPropagation()
    // capture selection/caret now — robust to the field losing focus when the
    // menu opens
    const el = e.currentTarget
    const sel = el.value.substring(el.selectionStart, el.selectionEnd)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      field,
      start: el.selectionStart,
      end: el.selectionEnd,
      value: el.value,
      copyText: sel || el.value // selection if any, else the whole field
    })
  }
  const copyField = () => {
    if (menu?.copyText != null) navigator.clipboard?.writeText(menu.copyText)
  }
  const pasteField = async () => {
    if (!menu) return
    let clip = ''
    try {
      clip = (await navigator.clipboard?.readText()) || ''
    } catch {
      return
    }
    snapshot(true)
    const next = menu.value.slice(0, menu.start) + clip + menu.value.slice(menu.end)
    if (menu.field === 'title') setTitle(next)
    else setText(next)
    const el = menu.field === 'title' ? titleRef.current : ref.current
    const caret = menu.start + clip.length
    requestAnimationFrame(() => {
      if (el) {
        el.focus()
        el.setSelectionRange(caret, caret)
      }
    })
  }

  useEffect(() => {
    const el = ref.current
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [])

  const remember = (f) => saveFormat({ bold, italic, size, ...f })
  const toggleBold = () =>
    setBold((v) => {
      remember({ bold: !v })
      return !v
    })
  const toggleItalic = () =>
    setItalic((v) => {
      remember({ italic: !v })
      return !v
    })
  const pickSize = (s) => {
    setSize(s)
    remember({ size: s })
  }

  const commit = () => {
    const tt = title.trim()
    if (!tt && !text.trim()) onDelete()
    else onSave({ title: tt, text, bold, italic, size, time })
  }

  const onBlur = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) commit()
  }

  const noBlur = (fn) => (e) => {
    e.preventDefault() // keep focus in the textarea
    fn()
  }

  return (
    <div
      className={`item-editor item-editor--s${size}`}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
          e.preventDefault()
          undo()
        }
      }}
    >
      <input
        ref={titleRef}
        className="item-editor__title"
        placeholder={t('items.titlePlaceholder')}
        value={title}
        onChange={(e) => {
          snapshot()
          setTitle(e.target.value)
        }}
        onContextMenu={(e) => openMenu(e, 'title')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault()
            commit()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            ref.current?.focus()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />

      <div className="item-editor__bar">
        <button
          className={'item-editor__btn' + (bold ? ' is-active' : '')}
          title="Bold"
          onMouseDown={noBlur(toggleBold)}
        >
          <b>B</b>
        </button>
        <button
          className={'item-editor__btn' + (italic ? ' is-active' : '')}
          title="Italic"
          onMouseDown={noBlur(toggleItalic)}
        >
          <i>I</i>
        </button>
        {SIZES.map((s) => (
          <button
            key={s}
            className={'item-editor__btn' + (size === s ? ' is-active' : '')}
            onMouseDown={noBlur(() => pickSize(s))}
          >
            {s}×
          </button>
        ))}

        <span className="item-editor__spacer" />

        {!plain && (
          <div className="item-editor__rem">
            {time && <span className="day-item__time day-item__time--on">{time.split('T')[1] || time}</span>}
            <button
              ref={remBtnRef}
              className={'item-editor__btn' + (time ? ' is-active' : '')}
              title={t('items.reminder')}
              onMouseDown={noBlur(() => setRemOpen((o) => !o))}
            >
              <CalendarIcon />
            </button>
            {remOpen && (
              <ReminderPopover
                anchorRef={remBtnRef}
                value={time}
                timeOnly={timeOnly}
                onChange={setTime}
                onClear={() => {
                  setTime(null)
                  setRemOpen(false)
                }}
                onClose={() => setRemOpen(false)}
              />
            )}
          </div>
        )}

        <button className="item-editor__btn item-editor__btn--save" onMouseDown={noBlur(commit)}>
          <CheckIcon />
        </button>
        <button className="item-editor__btn item-editor__btn--del" onMouseDown={noBlur(onDelete)}>
          <CloseIcon />
        </button>
      </div>

      <textarea
        ref={ref}
        className="item-editor__input"
        rows={1}
        style={{ fontWeight: bold ? 700 : 400, fontStyle: italic ? 'italic' : 'normal' }}
        placeholder={t('items.placeholder')}
        value={text}
        onChange={(e) => {
          snapshot()
          setText(e.target.value)
        }}
        onContextMenu={(e) => openMenu(e, 'text')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: t('items.copy'), onClick: copyField },
            { label: t('items.paste'), onClick: pasteField }
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
