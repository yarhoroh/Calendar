import { useEffect, useState } from 'react'
import api from '../../lib/api'
import StatusDot from '../StatusDot'

// Connect mailboxes over IMAP with an app password (Gmail: enable 2-Step
// Verification, then create an App Password). Independent of the calendar
// accounts. Step 1: add an account + test that the inbox can be read.
export default function MailAccountsSetting() {
  const [accounts, setAccounts] = useState([])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState({}) // email -> test result
  const [cleared, setCleared] = useState(null) // mail-cache wipe feedback

  const refresh = () => Promise.resolve(api.mail?.listAccounts?.()).then((a) => setAccounts(a || []))
  useEffect(() => {
    refresh()
  }, [])

  const add = async () => {
    setError('')
    setBusy(true)
    const r = await api.mail?.add?.({ email: email.trim(), password: password.trim(), name: name.trim() })
    setBusy(false)
    if (!r?.ok) return setError(r?.error || 'failed to connect')
    setEmail('')
    setPassword('')
    setName('')
    refresh()
  }

  const remove = async (e) => {
    await api.mail?.remove?.(e)
    setResult((p) => {
      const n = { ...p }
      delete n[e]
      return n
    })
    refresh()
  }

  const test = async (e) => {
    setResult((p) => ({ ...p, [e]: { loading: true } }))
    const r = await api.mail?.test?.(e)
    setResult((p) => ({ ...p, [e]: r }))
  }

  const clearCache = async () => {
    setCleared('…')
    const r = await api.mail?.clearCache?.()
    setCleared(r?.ok ? `🗑 ${r.removed} cached messages removed` : '❌ failed')
  }

  return (
    <>
      {accounts.map((acc) => (
        <div className="ai-list__row" key={acc.email} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusDot tone="green" />
            <div className="ai-list__body" style={{ flex: 1 }}>{acc.name || acc.email}</div>
            <button className="btn btn--ghost" disabled={result[acc.email]?.loading} onClick={() => test(acc.email)}>
              {result[acc.email]?.loading ? '…' : '📥 Test inbox'}
            </button>
            <button className="ai-list__del" title="Remove" onClick={() => remove(acc.email)}>×</button>
          </div>
          {result[acc.email] && !result[acc.email].loading && (
            <div className="ai-list__empty" style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-line' }}>
              {result[acc.email].ok
                ? [`✅ ${result[acc.email].count} messages cached`, ...(result[acc.email].sample || []).map((s) => `${s.unread ? '• ' : '  '}${s.subject || '(no subject)'} — ${s.from}`)].join('\n')
                : `❌ ${result[acc.email].error || 'failed'}`}
            </div>
          )}
        </div>
      ))}

      {error && <div className="ai-list__empty">{error}</div>}

      <div className="ai-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <input className="ai-add__input" placeholder="email address" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="ai-add__input" type="password" placeholder="app password (Gmail: 2FA → App passwords)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button
          type="button"
          className="btn btn--ghost"
          style={{ alignSelf: 'flex-start', fontSize: 12 }}
          onClick={() => api.openExternal?.('https://myaccount.google.com/apppasswords')}
        >
          🔗 Get a Gmail App Password
        </button>
        <input className="ai-add__input" placeholder="display name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn--primary" disabled={busy || !email.trim() || !password.trim()} onClick={add}>
          {busy ? 'Connecting…' : 'Add mailbox'}
        </button>
      </div>

      <div className="ai-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, marginTop: 4 }}>
        <button className="btn btn--ghost" style={{ alignSelf: 'flex-start' }} onClick={clearCache}>
          🗑 Clear mail cache
        </button>
        {cleared && <div className="ai-list__empty" style={{ fontSize: 12 }}>{cleared}</div>}
      </div>
    </>
  )
}
