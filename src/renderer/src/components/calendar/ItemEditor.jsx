import { useEffect, useRef, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import { CheckIcon, CloseIcon, CalendarIcon, GoogleIcon } from '../icons'
import ReminderPopover from './ReminderPopover'
import RichEditor from './RichEditor'
import './ItemEditor.css'

// legacy plain text → HTML (escape, keep line breaks) so old notes open in the editor
function textToHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML.replace(/\n/g, '<br>')
}

// The image resize/drag plugin can bake a leftover `opacity: 0.6` (from a
// cancelled drag) into an image's inline style and persist it, leaving the
// image permanently semi-transparent. We never set opacity in note content, so
// strip it on both save and load.
const stripOpacity = (html) => html.replace(/opacity\s*:\s*[\d.]+\s*;?/gi, '')

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
  googleEventId = null,
  googleShared = false,
  googleCalendar = null,
  googleAccount = null,
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
  const [shareOpen, setShareOpen] = useState(false)
  const [shareCals, setShareCals] = useState(null) // null = not loaded yet
  const [sharing, setSharing] = useState(false)
  const [linked, setLinked] = useState(!!googleEventId) // already on a Google calendar
  const [linkedWritable, setLinkedWritable] = useState(false) // imported note on a calendar we can write to
  const [delFromGoogle, setDelFromGoogle] = useState(googleShared) // delete confirm: also remove from Google
  const remBtnRef = useRef(null)
  const shareBtnRef = useRef(null)
  const editorRef = useRef(null)
  const busyRef = useRef(false) // guards against double-firing share/unshare (createEvent is async)

  // only dated notes (not the everyday / general boards) can become Google events
  const isDateDay = /^\d{4}-\d{2}-\d{2}$/.test(day || '')
  // a note we pushed to a shared calendar (vs one imported read-only from Google)
  const isShared = linked && googleShared
  // can deletion also remove the Google event? yes for notes we shared, and —
  // symmetric with editing, which pushes to any writable calendar — for imported
  // events on a calendar we can write to (owner/writer)
  const canDeleteGoogle = isDateDay && linked && (googleShared || linkedWritable)

  // load the writable shared calendars once (cheap — main reads its cache). The
  // share button only shows if there's at least one, so it's hidden entirely
  // when no Google account / no editable calendar is connected.
  useEffect(() => {
    if (!isDateDay || linked) return
    let alive = true
    Promise.resolve(api.google?.writableCalendars?.()).then((l) => alive && setShareCals(l || []))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // for a note imported from Google (linked, but not one WE shared), check once
  // whether its source calendar is writable — so deletion can offer to also
  // remove the event from the shared calendar, mirroring how editing pushes up
  useEffect(() => {
    if (!isDateDay || !linked || googleShared) return
    let alive = true
    Promise.resolve(api.google?.eventWritable?.(googleEventId)).then((w) => alive && setLinkedWritable(!!w))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openShare = () => setShareOpen((o) => !o)

  // create this note as an event on a shared Google calendar, link + save it.
  // busyRef guards re-entry so rapid clicks can't create duplicate events.
  const shareTo = async (cal) => {
    if (busyRef.current) return
    busyRef.current = true
    setSharing(true) // dropdown shows a "syncing…" spinner; clicks are guarded
    const { text, html } = getContent()
    const r = await api.google?.createEvent?.(cal.account, cal.id, {
      title: title.trim() || '(no title)',
      day,
      time: time ? String(time).split('T')[1] || time : null,
      description: text
    })
    busyRef.current = false
    setSharing(false)
    if (!r?.ok) {
      window.alert(r?.error || t('items.shareFailed'))
      return
    }
    setLinked(true)
    // save the note linked to the new event (always save — the Google event exists now)
    onSave({
      title: title.trim(),
      text,
      html,
      time,
      days,
      google: {
        googleEventId: r.event.googleEventId,
        googleCalendar: r.event.calendarName,
        googleAccount: r.event.account,
        googleShared: true
      }
    })
  }

  // undo sharing: delete the event from Google and unlink the note (keeps it local)
  const unShare = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setSharing(true)
    const r = await api.google?.deleteEvent?.(googleEventId)
    busyRef.current = false
    setSharing(false)
    if (r?.ok === false) {
      window.alert(r?.error || t('items.shareFailed'))
      return
    }
    setLinked(false)
    const { text, html } = getContent()
    onSave({
      title: title.trim(),
      text,
      html,
      time,
      days,
      google: { googleEventId: null, googleCalendar: null, googleAccount: null, googleShared: false }
    })
  }

  const startHtml = stripOpacity(initialHtml || (initialText ? textToHtml(initialText) : ''))

  const getContent = () => {
    const ed = editorRef.current
    const text = (ed?.getText() || '').trim()
    const raw = stripOpacity(ed?.getHTML() || '')
    const hasImg = /<img/i.test(raw)
    const html = ed && (text || hasImg) ? raw : ''
    return { text, html, empty: !text && !hasImg }
  }

  const commit = () => {
    const tt = title.trim()
    const { text, html, empty } = getContent()
    if (!tt && empty) onDelete({ deleteGoogle: isShared })
    else onSave({ title: tt, text, html, time, days })
  }

  const askDelete = () => {
    const { empty } = getContent()
    if (!title.trim() && empty) onDelete({ deleteGoogle: isShared })
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
        {/* share button: for un-shared notes with a writable calendar (to share),
            or for notes WE shared (to un-share). NOT for read-only imports. */}
        {isDateDay && ((!linked && shareCals && shareCals.length > 0) || isShared) && (
          <div className="item-editor__rem">
            <button
              ref={shareBtnRef}
              className={'item-editor__btn item-editor__gbtn' + (isShared ? ' is-on' : '')}
              title={isShared ? t('items.onGoogle') : t('items.shareToGoogle')}
              disabled={sharing}
              onMouseDown={noBlur(openShare)}
            >
              <GoogleIcon />
            </button>
            {shareOpen && (
              <div className="item-editor__share-menu" onMouseDown={(e) => e.preventDefault()}>
                {sharing ? (
                  <div className="item-editor__share-syncing">
                    <span className="ie-spin" aria-hidden />
                    {t('items.syncing')}
                  </div>
                ) : isShared ? (
                  <button className="item-editor__share-item is-linked" onMouseDown={noBlur(unShare)}>
                    <span className="item-editor__share-cal">✓ {googleCalendar || 'Google'}</span>
                    <span className="item-editor__share-acc">
                      {googleAccount} · {t('items.unshare')}
                    </span>
                  </button>
                ) : (
                  shareCals.map((c) => (
                    <button
                      key={c.account + c.id}
                      className="item-editor__share-item"
                      onMouseDown={noBlur(() => shareTo(c))}
                    >
                      <span className="item-editor__share-cal">{c.summary}</span>
                      <span className="item-editor__share-acc">{c.account}</span>
                    </button>
                  ))
                )}
              </div>
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
        <button
          className="item-editor__expand"
          title={t('items.expand')}
          // going fullscreen remounts the editor (it gets portalled), which would
          // re-read the original props and drop unsaved edits — so hand the live
          // draft up so the parent can persist it before expanding
          onMouseDown={noBlur(() => {
            const { text, html } = getContent()
            onExpand({ title, text, html, time, days })
          })}
        >
          ⛶
        </button>
      )}

      {confirmDel && (
        <div className="item-editor__confirm" onMouseDown={(e) => e.preventDefault()}>
          <div className="item-editor__confirm-box">
            <span className="item-editor__confirm-text">{t('items.deleteConfirm')}</span>
            {canDeleteGoogle && (
              <label className="item-editor__confirm-check">
                <input type="checkbox" checked={delFromGoogle} onChange={(e) => setDelFromGoogle(e.target.checked)} />
                {t('items.deleteFromGoogle')}
              </label>
            )}
            <div className="item-editor__confirm-actions">
              <button
                className="btn btn--danger"
                onMouseDown={noBlur(() => onDelete({ deleteGoogle: canDeleteGoogle && delFromGoogle }))}
              >
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
