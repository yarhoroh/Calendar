import { forwardRef, useImperativeHandle, useMemo, useState } from 'react'

// Gmail-style recipient field: type + Enter/comma to add a chip, ↓/↑ to walk the contact
// autocomplete (wrapping back to the input at the ends), Backspace to remove the last.
// `value` is an array of { name, email }. Exposes `flush()` (via ref) which commits any
// half-typed address and RETURNS the full list synchronously — so a Send click works even
// if you didn't press Enter first (no stale-state race).
const RecipientInput = forwardRef(function RecipientInput({ value = [], onChange, contacts = [], placeholder, autoFocus }, ref) {
  const [text, setText] = useState('')
  const [active, setActive] = useState(-1) // highlighted suggestion; -1 = the input cursor

  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase()
    if (!q) return []
    const chosen = new Set(value.map((v) => v.email))
    return contacts
      .filter((c) => !chosen.has(c.email) && (c.email.includes(q) || (c.name || '').toLowerCase().includes(q)))
      .slice(0, 6)
  }, [text, contacts, value])

  const add = (c) => {
    const email = String(c.email || '').trim().toLowerCase()
    if (!email) return value
    setText('')
    setActive(-1)
    if (value.some((v) => v.email === email)) return value
    const next = [...value, { name: c.name || '', email }]
    onChange(next)
    return next
  }
  // turn the typed text into a chip; returns the resulting list
  const commitTyped = () => {
    const raw = text.trim().replace(/[,;]\s*$/, '')
    if (!raw) return value
    const m = raw.match(/<([^>]+)>/)
    return add({ email: m ? m[1] : raw, name: m ? raw.replace(/<[^>]+>/, '').trim() : '' })
  }
  const removeAt = (i) => onChange(value.filter((_, idx) => idx !== i))

  // parent (Send) calls this to fold any half-typed address in and read the final list
  useImperativeHandle(ref, () => ({ flush: () => commitTyped() }), [text, value])

  return (
    <div className="rcpt">
      <div className="rcpt__chips">
        {value.map((v, i) => (
          <span className="rcpt__chip" key={v.email} title={v.email}>
            {v.name || v.email}
            <button className="rcpt__x" onClick={() => removeAt(i)} tabIndex={-1}>×</button>
          </span>
        ))}
        <input
          className="rcpt__input"
          value={text}
          autoFocus={autoFocus}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => {
            setText(e.target.value)
            setActive(-1) // new query → back to the input cursor
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && suggestions.length) {
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
            }
          }}
          onBlur={() => text.trim() && commitTyped()}
        />
      </div>
      {suggestions.length > 0 && (
        <div className="rcpt__menu">
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
