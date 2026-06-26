import { useEffect, useRef, useState } from 'react'
import api from '../../lib/api'
import { ChevronLeftIcon, CloseIcon, ArchiveIcon, TrashIcon, MailIcon, ReplyIcon, ReplyAllIcon, ForwardIcon, StarIcon, ZoomInIcon, ZoomOutIcon } from '../icons'
import MailThreadMessage from './MailThreadMessage'
import MailAttachBadge from './MailAttachBadge'
import { monogram } from '../../lib/monogram'
import { useI18n } from '../../i18n/I18nContext'

// same date format the real message header uses (MailThreadMessage), so the skeleton's
// time matches exactly and doesn't change shape once the thread loads
const fmtDate = (ts) =>
  ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

// Reads a conversation. `split` = shown beside the list (× to close); full =
// replaces the list (back arrow). Loads the real thread (all messages sharing the
// X-GM-THRID) with parsed bodies; newest message is on top and expanded.
// Link opens (Ctrl+click / right-click menu) bubble up via onOpenInternal/onLinkMenu
// so the in-app browser lives at the mail-list level (overlays the whole mail area).
export default function MailReader({ msg, split, onBack, onMarkUnread, onDelete, stars, onToggleStar, folder, onOpenInternal, onLinkMenu }) {
  const { t } = useI18n()
  const [thread, setThread] = useState([])
  const [threadTotal, setThreadTotal] = useState(0) // total messages in the conversation (for the "loading more" indicator)
  const [loading, setLoading] = useState(false)
  const [subjectTr, setSubjectTr] = useState(null) // translated subject (the title lives here, outside the iframe)
  const threadTokenRef = useRef(0) // drops stale streamed messages when a new thread opens
  // reader zoom (% — scales the whole conversation). NOT persisted: it's per-open-message and
  // resets to 100% whenever a different message opens. Changed by the +/- buttons or Ctrl+wheel
  // (over the headers here, or inside a message body via MailThreadMessage).
  const [zoom, setZoom] = useState(100)
  const changeZoom = (delta) => setZoom((z) => Math.min(250, Math.max(50, z + delta)))
  const resetZoom = () => setZoom(100)
  const scrollRef = useRef(null)
  // Ctrl+wheel over the reader (outside the iframes) zooms. Native non-passive listener so
  // preventDefault actually stops Chromium from page-zooming the whole app. Over a message
  // BODY (iframe) the wheel is caught inside the iframe (MailThreadMessage) and routed here.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const delta = e.deltaY < 0 ? 5 : -5 // wheel forward (up) = in, toward you (down) = out
      setZoom((z) => Math.min(250, Math.max(50, z + delta)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // translate the subject alongside the body when a message picks a language (same
  // Google endpoint); 'original' reverts to the real subject
  const handlePickLang = async (target) => {
    if (target === 'original' || !msg?.subject) {
      setSubjectTr(null)
      return
    }
    const r = await api.mail?.webTranslate?.({ 0: msg.subject }, target)
    if (r?.ok && r.map) setSubjectTr(r.map[0] ?? r.map['0'] ?? null)
  }

  // progressive: append each message as the backend streams it (newest first), so the first
  // message shows immediately instead of waiting for the whole conversation to download
  useEffect(() => {
    const off = api.mail?.onThreadMessage?.((p) => {
      if (p.token !== threadTokenRef.current) return
      if (p.total) setThreadTotal(p.total) // how many to expect → drives the "loading more" row
      // dedup by id: the streamed events and the final invoke response arrive on different
      // IPC paths with no ordering guarantee, so a late event must not re-add a message the
      // final list already set (that was the "single message shows twice" bug)
      setThread((cur) => (cur.some((x) => x.id === p.message.id) ? cur : [...cur, p.message]))
      setLoading(false) // the first streamed message replaces the skeleton
    })
    return () => off?.()
  }, [])

  useEffect(() => {
    if (!msg) {
      setThread([])
      return
    }
    let alive = true
    const token = ++threadTokenRef.current
    setLoading(true)
    setThread([])
    setThreadTotal(0)
    setSubjectTr(null)
    setZoom(100) // each opened message starts at 100% (zoom isn't remembered)
    Promise.resolve(api.mail?.thread?.(msg.account, msg.threadId, msg.id, folder, token)).then((r) => {
      if (!alive || token !== threadTokenRef.current) return
      setLoading(false)
      // authoritative full list (newest first) — also covers any streamed message we missed
      if (r?.ok) setThread(r.messages || [])
    })
    return () => {
      alive = false
    }
  }, [msg?.id, msg?.threadId, msg?.account, folder])

  if (!msg) return <div className="mail-reader mail-reader--empty">{t('mail.selectToRead')}</div>

  return (
    <div className="mail-reader">
      <div className="mail-reader__bar">
        <button className="mail-reader__iconbtn" title={split ? t('mail.close') : t('mail.back')} onClick={onBack}>
          {split ? <CloseIcon /> : <ChevronLeftIcon />}
        </button>
        <button className="mail-reader__iconbtn" title={t('mail.archive')}><ArchiveIcon /></button>
        <button className="mail-reader__iconbtn" title={t('mail.delete')} onClick={() => onDelete?.(msg)}><TrashIcon /></button>
        <button className="mail-reader__iconbtn" title={t('mail.markUnread')} onClick={() => onMarkUnread?.(msg)}><MailIcon /></button>
        <div className="mail-reader__zoom">
          <button className="mail-reader__iconbtn" title={t('mail.zoomOut')} onClick={() => changeZoom(-5)}><ZoomOutIcon /></button>
          <button className="mail-reader__zoomval" title={t('mail.zoomReset')} onClick={resetZoom}>{zoom}%</button>
          <button className="mail-reader__iconbtn" title={t('mail.zoomIn')} onClick={() => changeZoom(5)}><ZoomInIcon /></button>
        </div>
      </div>

      <div className="mail-reader__scroll" ref={scrollRef}>
        <div className="mail-reader__subject">
          {subjectTr ?? msg.subject}
          {thread.length > 1 && <span className="mail-reader__count">{thread.length} {t('mail.messagesInThread')}</span>}
        </div>

        {loading ? (
          // skeleton from the list metadata we already have (sender, date, attachments,
          // preview) so the whole frame — header, body outline, reply bar — is visible
          // immediately; only the body area shows the spinner while the thread loads
          <div className="mail-reader__thread">
            <div className="mail-msg mail-msg--open">
              <div className="mail-msg__head mail-msg__head--static">
                <span className="mail-msg__avatar">{monogram(msg.from || msg.account)}</span>
                <div className="mail-msg__who">
                  <span className="mail-msg__from">{msg.from || msg.account}</span>
                  <span className="mail-msg__to">{msg.to ? `${t('mail.to')} ${msg.to}` : msg.snippet || ''}</span>
                </div>
                <MailAttachBadge attachments={msg.attachments} account={msg.account} />
                <span className="mail-msg__date">{fmtDate(msg.ts)}</span>
                <button
                  className={'mail-msg__star' + (stars?.[msg.id] ? ' is-on' : '')}
                  title={t('mail.star')}
                  onClick={() => onToggleStar?.(msg.id)}
                >
                  <StarIcon />
                </button>
              </div>
              <div className="mail-msg__open">
                <div className="mail-reader__bodyframe">
                  <span className="mail-spinner" />
                  <span className="mail-list__loading-text">{t('mail.loading')}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="mail-reader__thread">
            {thread.map((m, i) => (
              <MailThreadMessage
                key={m.id}
                m={m}
                defaultOpen={i === 0}
                account={msg.account}
                starred={!!stars?.[m.id]}
                onToggleStar={() => onToggleStar?.(m.id)}
                onOpenInternal={onOpenInternal}
                onLinkMenu={onLinkMenu}
                onPickLang={handlePickLang}
                onZoom={changeZoom}
                zoom={zoom}
              />
            ))}
            {thread.length > 0 && threadTotal > thread.length && (
              <div className="mail-reader__more">
                <span className="mail-spinner mail-spinner--sm" />
                <span className="mail-list__loading-text">{t('mail.loadingMore')}</span>
              </div>
            )}
            {thread.length === 0 && <div className="mail-list__empty">{t('mail.empty')}</div>}
          </div>
        )}

        <div className="mail-reader__replybar">
          <button className="btn btn--ghost"><ReplyIcon /> {t('mail.reply')}</button>
          <button className="btn btn--ghost"><ReplyAllIcon /> {t('mail.replyAll')}</button>
          <button className="btn btn--ghost"><ForwardIcon /> {t('mail.forward')}</button>
        </div>
      </div>
    </div>
  )
}
