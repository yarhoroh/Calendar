import { useEffect, useRef, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import { CloseIcon, SendIcon, PaperclipIcon } from '../icons'
import RichEditor from '../calendar/RichEditor'
import RecipientInput from './RecipientInput'

// Compose a new email. From defaults to the mailbox you're in (switchable). Recipients are
// Gmail-style chips with contact autocomplete; the body is the rich note editor (fonts,
// alignment, inline images). Drag files onto it — or use the paperclip — to attach them.
// Send hands the message to the parent's background queue and closes immediately.
export default function MailCompose({ accounts = [], defaultFrom, onSend, onClose }) {
  const { t } = useI18n()
  const [from, setFrom] = useState(defaultFrom || accounts[0]?.email || '')
  const [to, setTo] = useState([])
  const [cc, setCc] = useState([])
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState('')
  const [attachments, setAttachments] = useState([]) // [{ name, path }]
  const [contacts, setContacts] = useState([])
  const [error, setError] = useState('')
  const toRef = useRef(null)
  const ccRef = useRef(null)
  const editorRef = useRef(null)

  useEffect(() => {
    Promise.resolve(api.mail?.contacts?.()).then((r) => setContacts(r || []))
  }, [])

  const addFiles = (files) => {
    const added = [...(files || [])]
      .map((f) => ({ name: f.name, path: api.pathForFile?.(f) }))
      .filter((a) => a.path)
    if (added.length) setAttachments((cur) => [...cur, ...added])
  }
  const pickFiles = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => addFiles(input.files)
    input.click()
  }

  const send = () => {
    setError('')
    const recips = toRef.current?.flush?.() || to
    const ccs = ccRef.current?.flush?.() || cc
    if (!recips.length) return setError(t('mail.composeNeedTo'))
    if (!from) return setError(t('mail.composeNeedFrom'))
    const html = editorRef.current?.getHTML?.() || ''
    const text = editorRef.current?.getText?.() || ''
    onSend?.({
      account: from,
      to: recips.map((v) => v.email).join(', '),
      cc: ccs.map((v) => v.email).join(', '),
      subject,
      text,
      html: text.trim() ? html : '', // skip an empty <p></p>
      attachments
    })
    onClose?.()
  }

  const fromLabel = (a) => (a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email)

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')

  return (
    <div
      className="mail-compose"
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer?.files?.length) return
        e.preventDefault() // anywhere on the email → attach (don't let the browser open it)
        addFiles(e.dataTransfer.files)
      }}
    >
      <div className="mail-compose__bar">
        <button className="mail-reader__iconbtn" title={t('mail.close')} onClick={onClose}>
          <CloseIcon />
        </button>
        <span className="mail-compose__title">{t('mail.newEmail')}</span>
      </div>

      <div className="mail-compose__form">
        <div className="mail-compose__row">
          <span className="mail-compose__lbl">{t('mail.from')}</span>
          <select className="mail-compose__from" value={from} onChange={(e) => setFrom(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.email} value={a.email}>{fromLabel(a)}</option>
            ))}
          </select>
        </div>
        <div className="mail-compose__row">
          <span className="mail-compose__lbl">{t('mail.to')}</span>
          <RecipientInput ref={toRef} value={to} onChange={setTo} contacts={contacts} placeholder="name@example.com" autoFocus />
          {!showCc && (
            <button className="mail-compose__cc" onClick={() => setShowCc(true)}>Cc</button>
          )}
        </div>
        {showCc && (
          <div className="mail-compose__row">
            <span className="mail-compose__lbl">Cc</span>
            <RecipientInput ref={ccRef} value={cc} onChange={setCc} contacts={contacts} placeholder="name@example.com" />
          </div>
        )}
        <div className="mail-compose__row">
          <span className="mail-compose__lbl">{t('mail.subject')}</span>
          <input className="mail-compose__input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>

        <div className="mail-compose__editor">
          <RichEditor rich register={false} initialHtml="" onReady={(ed) => (editorRef.current = ed)} attachDrop />
        </div>

        {attachments.length > 0 && (
          <div className="mail-compose__attach">
            {attachments.map((a, i) => (
              <span className="mail-compose__file" key={a.path + i} title={a.name}>
                <PaperclipIcon />
                <span className="mail-compose__file-name">{a.name}</span>
                <button className="mail-compose__file-x" onClick={() => setAttachments((cur) => cur.filter((_, idx) => idx !== i))}>×</button>
              </span>
            ))}
          </div>
        )}

        {error && <div className="mail-compose__error">⚠ {error}</div>}
      </div>

      <div className="mail-compose__foot">
        <button className="mail-compose__attachbtn" title={t('mail.attach')} onClick={pickFiles}>
          <PaperclipIcon />
        </button>
        <button className="mail-compose__send" onClick={send}>
          <SendIcon />
          <span>{t('mail.send')}</span>
        </button>
      </div>
    </div>
  )
}
