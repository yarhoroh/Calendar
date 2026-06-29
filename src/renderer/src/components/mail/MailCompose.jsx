import { useEffect, useRef, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import { registerUi } from '../../lib/uiBridge'
import { CloseIcon, SendIcon, PaperclipIcon } from '../icons'
import RichEditor from '../calendar/RichEditor'
import RecipientInput from './RecipientInput'

// Compose a new email. From defaults to the mailbox you're in (switchable). Recipients are
// Gmail-style chips with contact autocomplete; the body is the rich note editor (fonts,
// alignment, inline images). Drag files onto it — or use the paperclip — to attach them.
// Send hands the message to the parent's background queue and closes immediately.
// recipients arrive from the AI as a string ("a@x.com, b@y.com") or already as chips
const parseRecips = (v) => {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim())
    return v
      .split(/[,;]/)
      .map((e) => e.trim())
      .filter(Boolean)
      .map((email) => ({ email, name: email }))
  return []
}

// the quote iframe needs its OWN CSP — without it, the srcdoc inherits the app's
// default-src 'self' and blocks every image. Allow only data:/cid: (so inlined images show;
// remote ones are turned into data: by the backend before they get here).
const QUOTE_HEAD =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline' data:; font-src data:;">` +
  `<meta name="color-scheme" content="light only"><style>html,body{margin:0;padding:8px}</style>`

export default function MailCompose({ accounts = [], defaultFrom, initial, onSend, onSaveDraft, onClose }) {
  const { t } = useI18n()
  const [from, setFrom] = useState(initial?.from || defaultFrom || accounts[0]?.email || '')
  const [to, setTo] = useState(parseRecips(initial?.to))
  const [cc, setCc] = useState(parseRecips(initial?.cc))
  const [showCc, setShowCc] = useState(parseRecips(initial?.cc).length > 0)
  const [subject, setSubject] = useState(initial?.subject || '')
  const [attachments, setAttachments] = useState(initial?.attachments || []) // [{ name, path }]
  const [contacts, setContacts] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(initial?.loading || false) // a draft is still loading
  // the editor's manual floor height: drag the bottom-right grip to set it; the body still
  // auto-grows ABOVE this with more text and never shrinks below the size you set by hand
  const [editorMinH, setEditorMinH] = useState(220)
  const startEditorResize = (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = editorMinH
    const onMove = (ev) => setEditorMinH(Math.max(120, startH + (ev.clientY - startY)))
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  const toRef = useRef(null)
  const ccRef = useRef(null)
  const editorRef = useRef(null)
  const draftRef = useRef(initial?.draft || null) // set when this compose was opened FROM a draft
  // reply/forward keep the ORIGINAL as a faithful HTML quote (rendered in an iframe below, not
  // mangled through the rich editor); the editor holds only the user's new text. State (not a
  // ref) so re-opening a draft can swap the quote in and the iframe re-renders.
  const [quoteHtml, setQuoteHtml] = useState(initial?.quoteHtml || '')
  const [quoteHeader, setQuoteHeader] = useState(initial?.quoteHeader || '')

  useEffect(() => {
    Promise.resolve(api.mail?.contacts?.()).then((r) => setContacts(r || []))
  }, [])

  // Let the AI read THIS open draft and fill/edit it: getCompose returns the live content
  // (so APP STATE can show what the user has typed → "translate the body"); composeMail
  // applies fields (search a contact → set To, write the subject, set/replace the body).
  // Only the fields the AI provides change; the body uses the editor's setContent.
  const stateRef = useRef({})
  stateRef.current = { from, to, cc, subject, attachments }
  useEffect(
    () =>
      registerUi((name, arg) => {
        if (name === 'getCompose') {
          const s = stateRef.current
          return {
            open: true,
            from: s.from,
            to: s.to.map((r) => r.email).join(', '),
            cc: s.cc.map((r) => r.email).join(', '),
            subject: s.subject,
            text: editorRef.current?.getText?.() || '',
            html: finalHtml(),
            attachments: s.attachments,
            draft: draftRef.current // present when editing an existing draft → update, don't duplicate
          }
        }
        if (name === 'composeMail') {
          if (arg?.from) setFrom(arg.from)
          if (arg?.to != null) setTo(parseRecips(arg.to))
          if (arg?.cc != null) {
            setCc(parseRecips(arg.cc))
            setShowCc(true)
          }
          if (arg?.subject != null) setSubject(arg.subject)
          if (arg?.html != null) editorRef.current?.commands?.setContent?.(arg.html || '')
          if (Array.isArray(arg?.attachments)) setAttachments(arg.attachments)
          if (arg?.quoteHtml != null) setQuoteHtml(arg.quoteHtml)
          if (arg?.quoteHeader != null) setQuoteHeader(arg.quoteHeader)
          if (arg?.draft) draftRef.current = arg.draft // a draft being loaded into this composer
          if (arg?.loading != null) setLoading(arg.loading)
          return true
        }
        return undefined
      }),
    []
  )

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

  // the message body that goes out: the editor's text on top, the original as a faithful
  // HTML quote below (for reply/forward). Empty if nothing was typed and there's no quote.
  const finalHtml = () => {
    const body = editorRef.current?.getHTML?.() || ''
    if (!quoteHtml) return editorRef.current?.getText?.().trim() ? body : ''
    // wrap the quote in a marked container so re-opening a saved draft can split the user's
    // text (→ editor) from the original (→ quote iframe) instead of cramming all the HTML into
    // the rich editor, which mangles it. Invisible to recipients (just a div wrapper).
    return (
      `${body}<div data-cal-quote="1">` +
      `<div data-cal-quote-head="1">${quoteHeader || ''}</div>` +
      `<blockquote style="margin:0 0 0 8px;padding-left:10px;border-left:2px solid #ccc">${quoteHtml}</blockquote>` +
      `</div>`
    )
  }

  const send = () => {
    setError('')
    const recips = toRef.current?.flush?.() || to
    const ccs = ccRef.current?.flush?.() || cc
    if (!recips.length) return setError(t('mail.composeNeedTo'))
    if (!from) return setError(t('mail.composeNeedFrom'))
    const html = finalHtml()
    onSend?.({
      account: from,
      to: recips.map((v) => v.email).join(', '),
      cc: ccs.map((v) => v.email).join(', '),
      subject,
      text: editorRef.current?.getText?.() || '',
      html,
      attachments,
      draft: draftRef.current // if set, the parent deletes this draft from Drafts after sending
    })
    onClose?.()
  }

  // Save Draft: store the message in Drafts without sending. A draft has no required fields,
  // so we never block on a missing recipient. Editing an existing draft updates it (the parent
  // removes the old one). Closes the composer afterwards.
  // hand the draft to the parent's BACKGROUND queue (like Send) and close immediately — the
  // save/update runs in parallel and the "New email" button shows the in-flight task.
  const saveDraft = () => {
    const recips = toRef.current?.flush?.() || to
    const ccs = ccRef.current?.flush?.() || cc
    onSaveDraft?.({
      account: from,
      to: recips.map((v) => v.email).join(', '),
      cc: ccs.map((v) => v.email).join(', '),
      subject,
      text: editorRef.current?.getText?.() || '',
      html: finalHtml(),
      attachments,
      draft: draftRef.current
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

        <div className="mail-compose__editor" style={{ minHeight: editorMinH }}>
          <RichEditor rich register={false} initialHtml={initial?.html || ''} onReady={(ed) => (editorRef.current = ed)} attachDrop />
          <div className="mail-compose__editresize" onMouseDown={startEditorResize} title={t('mail.resize')} />
        </div>

        {/* reply/forward: the original message, rendered faithfully (images + layout) in an
            iframe — NOT pushed through the rich editor, which would mangle marketing HTML */}
        {quoteHtml && (
          <div className="mail-compose__quote">
            {quoteHeader && <div className="mail-compose__quote-head" dangerouslySetInnerHTML={{ __html: quoteHeader }} />}
            <iframe
              className="mail-compose__quote-frame"
              sandbox="allow-same-origin"
              title="quoted message"
              srcDoc={QUOTE_HEAD + `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px">${quoteHtml}</div>`}
              onLoad={(e) => {
                try {
                  const h = e.target.contentDocument?.body?.scrollHeight || 240
                  e.target.style.height = Math.min(2400, h + 16) + 'px'
                } catch {
                  /* sandboxed cross-origin — keep the default height */
                }
              }}
            />
          </div>
        )}

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
        <div className="mail-compose__actions">
          <button className="mail-compose__draftbtn" onClick={saveDraft}>
            {t('mail.leaveSaveDraft')}
          </button>
          <button className="mail-compose__send" onClick={send}>
            <SendIcon />
            <span>{t('mail.send')}</span>
          </button>
        </div>
      </div>

      {loading && (
        <div className="mail-compose__loading">
          <span className="mail-spinner" />
          <span>{t('mail.draftLoading')}</span>
        </div>
      )}
    </div>
  )
}
