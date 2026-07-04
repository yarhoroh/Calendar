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
  // reconnect (re-init password without removing the account): which email is open + its new password
  const [reconnect, setReconnect] = useState(null) // email being reconnected, or null
  const [rcPass, setRcPass] = useState('')
  const [rcBusy, setRcBusy] = useState(false)
  const [rcErr, setRcErr] = useState('')

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

  // re-initialize the login/password of an EXISTING account (no removal). Uses the same
  // api.mail.add mechanism — same email overwrites the stored password, keeping all settings.
  const openReconnect = (e) => {
    setReconnect(e)
    setRcPass('')
    setRcErr('')
  }
  const saveReconnect = async (acc) => {
    setRcErr('')
    setRcBusy(true)
    const r = await api.mail?.add?.({ email: acc.email, password: rcPass.trim(), name: acc.name })
    setRcBusy(false)
    if (!r?.ok) return setRcErr(r?.error || 'failed to connect')
    setReconnect(null)
    setRcPass('')
    refresh()
    test(acc.email) // confirm the new password reads the inbox
  }
  // an auth failure in the test result → the app password is invalid (e.g. revoked by a Google
  // password change); offer reconnect right there
  const isAuthFail = (r) => r && !r.loading && !r.ok && /login failed|App Password|credentials|authenticat/i.test(r.error || '')

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
            <StatusDot tone={isAuthFail(result[acc.email]) ? 'red' : 'green'} />
            <div className="ai-list__body" style={{ flex: 1 }}>{acc.name || acc.email}</div>
            <button className="btn btn--ghost" title="Change the app password without removing the account" onClick={() => openReconnect(acc.email)}>
              🔑 Change password
            </button>
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
              {isAuthFail(result[acc.email]) && reconnect !== acc.email && (
                <div style={{ marginTop: 4 }}>
                  <button className="btn btn--primary" style={{ fontSize: 12 }} onClick={() => openReconnect(acc.email)}>
                    🔑 Re-enter app password
                  </button>
                </div>
              )}
            </div>
          )}
          {reconnect === acc.email && (
            <div className="ai-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, marginTop: 2 }}>
              <input
                className="ai-add__input"
                type="password"
                placeholder={`new app password for ${acc.email}`}
                value={rcPass}
                autoFocus
                onChange={(e) => setRcPass(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && rcPass.trim()) saveReconnect(acc) }}
              />
              <button
                type="button"
                className="btn btn--ghost"
                style={{ alignSelf: 'flex-start', fontSize: 12 }}
                onClick={() => api.openExternal?.('https://myaccount.google.com/apppasswords')}
              >
                🔗 Get a new Gmail App Password
              </button>
              {rcErr && <div className="ai-list__empty" style={{ fontSize: 12 }}>❌ {rcErr}</div>}
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn--primary" disabled={rcBusy || !rcPass.trim()} onClick={() => saveReconnect(acc)}>
                  {rcBusy ? 'Reconnecting…' : 'Save & reconnect'}
                </button>
                <button className="btn btn--ghost" disabled={rcBusy} onClick={() => setReconnect(null)}>
                  Cancel
                </button>
              </div>
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
