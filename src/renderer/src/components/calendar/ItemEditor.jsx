import { useRef, useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { CheckIcon, CloseIcon, CalendarIcon } from '../icons'
import ReminderPopover from './ReminderPopover'
import RichEditor from './RichEditor'
import './ItemEditor.css'

// legacy plain text → HTML (escape, keep line breaks) so old notes open in the editor
function textToHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML.replace(/\n/g, '<br>')
}

// Rich note editor: a title line + a Quill HTML body (bold/italic/underline,
// sizes, lists, inline base64 images). Saves both the HTML and a plain-text
// version (for search / the AI). Enter (in title) / Ctrl+Enter / blur = save.
export default function ItemEditor({
  initialTitle = '',
  initialText = '',
  initialHtml = '',
  initialTime = null,
  initialDays = null,
  defaultDays = [],
  noteId = null,
  day = null,
  timeOnly = false,
  plain = false,
  expanded = false,
  onExpand,
  onSave,
  onCancel,
  onDelete
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState(initialTitle)
  const [time, setTime] = useState(initialTime)
  const [days, setDays] = useState(initialDays)
  const [remOpen, setRemOpen] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const remBtnRef = useRef(null)
  const editorRef = useRef(null)

  const startHtml = initialHtml || (initialText ? textToHtml(initialText) : '')

  const getContent = () => {
    const ed = editorRef.current
    const text = (ed?.getText() || '').trim()
    const raw = ed?.getHTML() || ''
    const hasImg = /<img/i.test(raw)
    const html = ed && (text || hasImg) ? raw : ''
    return { text, html, empty: !text && !hasImg }
  }

  const commit = () => {
    const tt = title.trim()
    const { text, html, empty } = getContent()
    if (!tt && empty) onDelete()
    else onSave({ title: tt, text, html, time, days })
  }

  const askDelete = () => {
    const { empty } = getContent()
    if (!title.trim() && empty) onDelete()
    else setConfirmDel(true)
  }

  // commit when focus leaves the editor for elsewhere on the page; but NOT when
  // the whole window loses focus (image file dialog / alt-tab) — keep editing then
  const onBlur = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return
    // the chat is a parallel tool (and the AI edits this note live) — clicking it
    // must NOT close/save the editor
    if (e.relatedTarget?.closest?.('.promptbar, .chat')) return
    if (!document.hasFocus()) return
    commit()
  }
  const noBlur = (fn) => (e) => {
    e.preventDefault()
    fn()
  }

  return (
    <div className="item-editor" onBlur={onBlur}>
      <div className="item-editor__head">
        <input
          className="item-editor__title"
          placeholder={t('items.titlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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
                showDays={timeOnly}
                days={days && days.length ? days : defaultDays}
                onDays={setDays}
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
        <button className="item-editor__btn item-editor__btn--del" onMouseDown={noBlur(askDelete)}>
          <CloseIcon />
        </button>
      </div>

      <RichEditor initialHtml={startHtml} meta={{ id: noteId, day }} onReady={(ed) => (editorRef.current = ed)} />

      {onExpand && !expanded && (
        <button className="item-editor__expand" title={t('items.expand')} onMouseDown={noBlur(onExpand)}>
          ⛶
        </button>
      )}

      {confirmDel && (
        <div className="item-editor__confirm" onMouseDown={(e) => e.preventDefault()}>
          <div className="item-editor__confirm-box">
            <span className="item-editor__confirm-text">{t('items.deleteConfirm')}</span>
            <div className="item-editor__confirm-actions">
              <button className="btn btn--danger" onMouseDown={noBlur(onDelete)}>
                {t('items.yes')}
              </button>
              <button className="btn" onMouseDown={noBlur(() => setConfirmDel(false))}>
                {t('items.no')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
