import { forwardRef, useImperativeHandle, useMemo, useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { norm } from '../../lib/translit'

const looksEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim())

// Gmail-style recipient field: type + Enter/comma to add a chip, ↓/↑ to walk the contact
// autocomplete (wrapping back to the input at the ends), Backspace to remove the last.
// `value` is an array of { name, email }. Exposes `flush()` (via ref) which commits any
// half-typed address and RETURNS the full list synchronously — so a Send click works even
// if you didn't press Enter first (no stale-state race).
const RecipientInput = forwardRef(function RecipientInput({ value = [], onChange, contacts = [], placeholder, autoFocus }, ref) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [active, setActive] = useState(-1) // highlighted suggestion; -1 = the input cursor
  const [showAll, setShowAll] = useState(false) // Ctrl+Space → list every contact, no query

  const suggestions = useMemo(() => {
    const chosen = new Set(value.map((v) => v.email))
    const avail = contacts.filter((c) => !chosen.has(c.email))
    const q = norm(text)
    if (!q) return showAll ? avail.slice(0, 100) : [] // empty field: full list only after Ctrl+Space
    const qt = q.split(' ').filter(Boolean)
    // transliterated token match: every typed token must appear in the contact's name/email
    return avail.filter((c) => qt.every((tk) => norm(`${c.name || ''} ${c.email || ''}`).includes(tk))).slice(0, 8)
  }, [text, contacts, value, showAll])

  const add = (c) => {
    const email = String(c.email || '').trim().toLowerCase()
    if (!email) return value
    setText('')
    setActive(-1)
    setShowAll(false)
    if (value.some((v) => v.email === email)) return value
    const next = [...value, { name: c.name || '', email }]
    onChange(next)
    return next
  }
  // turn the typed text into a chip — but ONLY if it's a real email or resolves to a contact.
  // bare non-email text ("Ирина") is refused: we never make a junk recipient out of it.
  const commitTyped = () => {
    const raw = text.trim().replace(/[,;]\s*$/, '')
    if (!raw) return value
    const m = raw.match(/<([^>]+)>/)
    if (m && looksEmail(m[1])) return add({ email: m[1].trim(), name: raw.replace(/<[^>]+>/, '').trim() })
    if (looksEmail(raw)) return add({ email: raw, name: '' })
    // a bare name → resolve to a contact (transliterated); no match → add nothing, keep the text
    const qt = norm(raw).split(' ').filter(Boolean)
    const hit = qt.length && contacts.find((c) => qt.every((tk) => norm(`${c.name || ''} ${c.email || ''}`).includes(tk)))
    return hit ? add(hit) : value
  }
  const removeAt = (i) => onChange(value.filter((_, idx) => idx !== i))

  // parent (Send) calls this to fold any half-typed address in and read the final list
  useImperativeHandle(ref, () => ({ flush: () => commitTyped() }), [text, value])

  return (
    <div className="rcpt">
      <div className="rcpt__chips">
        {value.map((v, i) => (
          <span className="rcpt__chip" key={v.email} data-email={v.name && v.name !== v.email ? v.email : undefined}>
            {v.name || v.email}
            <button className="rcpt__x" onClick={() => removeAt(i)} tabIndex={-1}>×</button>
          </span>
        ))}
        <input
          className="rcpt__input"
          value={text}
          autoFocus={autoFocus}
          placeholder={value.length ? '' : `${placeholder || ''} · ${t('mail.recipientHint')}`.replace(/^ · /, '')}
          onChange={(e) => {
            setText(e.target.value)
            setActive(-1) // new query → back to the input cursor
          }}
          onKeyDown={(e) => {
            if (e.code === 'Space' && e.ctrlKey) {
              // Ctrl+Space → drop down EVERY contact, even with nothing typed
              e.preventDefault()
              setShowAll((s) => !s)
              setActive(-1)
            } else if (e.key === 'ArrowDown' && suggestions.length) {
              e.preventDefault()
              setActive((a) => (a >= suggestions.length - 1 ? -1 : a + 1))
            } else if (e.key === 'ArrowUp' && suggestions.length) {
              e.preventDefault()
              setActive((a) => (a <= -1 ? suggestions.length - 1 : a - 1))
            } else if (e.key === 'Enter') {
              if (active >= 0 && suggestions[active]) {
                e.preventDefault()
                add(suggestions[active])
              } else if (text.trim()) {
                e.preventDefault()
                commitTyped()
              }
            } else if ((e.key === ',' || e.key === ';' || e.key === 'Tab') && text.trim()) {
              e.preventDefault()
              commitTyped()
            } else if (e.key === 'Backspace' && !text && value.length) {
              removeAt(value.length - 1)
            } else if (e.key === 'Escape') {
              setText('')
              setActive(-1)
              setShowAll(false)
            }
          }}
          onBlur={() => {
            if (text.trim()) commitTyped()
            setShowAll(false)
          }}
        />
      </div>
      {suggestions.length > 0 && (
        <div className="rcpt__menu" style={{ maxHeight: 260, overflowY: 'auto' }}>
          {suggestions.map((c, i) => (
            <button
              className={'rcpt__opt' + (i === active ? ' is-active' : '')}
              key={c.email}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault() // keep focus → onBlur won't also fire commit
                add(c)
              }}
            >
              <span className="rcpt__opt-name">{c.name || c.email}</span>
              {c.name && <span className="rcpt__opt-email">{c.email}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

export default RecipientInput
