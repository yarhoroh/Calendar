import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import StatusDot from '../StatusDot'
import SettingRow from './SettingRow'
import { runGoogleAutoSync } from '../../lib/autoSyncGoogle'

// Connect one or more Google accounts (read-only Calendar) and pick which
// calendars to pull events from. Tokens live encrypted in ai-config.json.
export default function GoogleAccountsSetting() {
  const { t } = useI18n()
  const [accounts, setAccounts] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [syncEvery, setSyncEvery] = useState(0) // minutes; 0 = off

  const refresh = () => Promise.resolve(api.google?.listAccounts?.()).then((a) => setAccounts(a || []))
  useEffect(() => {
    refresh()
    Promise.resolve(api.google?.getSyncInterval?.()).then((m) => setSyncEvery(Number(m) || 0))
  }, [])

  const changeInterval = (m) => {
    setSyncEvery(m)
    api.google?.setSyncInterval?.(m)
  }

  const connect = async () => {
    setBusy(true)
    setError('')
    const r = await api.google?.connect?.()
    setBusy(false)
    if (r && r.ok === false) setError(r.error || 'failed')
    refresh()
  }

  const disconnect = async (email) => {
    setBusy(true)
    await api.google?.disconnect?.(email)
    setBusy(false)
    refresh()
  }

  const toggleCalendar = async (acc, calId) => {
    const selected = acc.calendars.filter((c) => c.selected).map((c) => c.id)
    const next = selected.includes(calId) ? selected.filter((id) => id !== calId) : [...selected, calId]
    await api.google?.setCalendars?.(acc.email, next)
    refresh()
  }

  const toggleAutoSync = async (acc, calId) => {
    const on = acc.calendars.filter((c) => c.autoSync).map((c) => c.id)
    const turningOn = !on.includes(calId)
    const next = turningOn ? [...on, calId] : on.filter((id) => id !== calId)
    await api.google?.setAutoSync?.(acc.email, next)
    if (turningOn) {
      // auto-sync only pulls SELECTED calendars → make sure it's selected too
      const selected = acc.calendars.filter((c) => c.selected).map((c) => c.id)
      if (!selected.includes(calId)) await api.google?.setCalendars?.(acc.email, [...selected, calId])
      runGoogleAutoSync() // pull it in right away, don't wait for the timer
    }
    refresh()
  }

  return (
    <>
      <SettingRow title="Google Calendar" description={t('settings.google.desc')}>
        <button className="btn btn--primary" onClick={connect} disabled={busy}>
          {t('settings.google.connect')}
        </button>
      </SettingRow>

      {error && <div className="ai-list__empty">{error}</div>}

      {accounts.map((acc) => (
        <div className="ai-list__row" key={acc.email} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusDot tone={acc.needsReconnect ? 'red' : 'green'} />
            <div className="ai-list__body" style={{ flex: 1 }}>
              {acc.displayName || acc.email}
              {acc.needsReconnect ? ` — ${t('settings.google.reconnect')}` : ''}
            </div>
            <button className="ai-list__del" title={t('settings.google.disconnect')} onClick={() => disconnect(acc.email)}>
              ×
            </button>
          </div>
          {!acc.needsReconnect && (
            <div className="google-cals">
              {acc.calendars.length === 0 && <span className="ai-list__empty">{t('settings.google.noCalendars')}</span>}
              {acc.calendars.map((c) => (
                <div className="google-cal-row" key={c.id}>
                  <label className="google-cal">
                    <input type="checkbox" checked={!!c.selected} onChange={() => toggleCalendar(acc, c.id)} />
                    {c.color && <span className="google-cal__dot" style={{ background: c.color }} />}
                    <span>{c.summary}</span>
                  </label>
                  <button
                    className={'google-cal__sync' + (c.autoSync ? ' is-on' : '')}
                    title={t('settings.google.autoSync')}
                    onClick={() => toggleAutoSync(acc, c.id)}
                  >
                    ⟳
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <SettingRow title={t('settings.google.syncEvery')} description={t('settings.google.syncEveryDesc')}>
        <select className="select" value={syncEvery} onChange={(e) => changeInterval(Number(e.target.value))}>
          <option value={0}>{t('settings.google.syncOff')}</option>
          <option value={1}>1 {t('settings.google.min')}</option>
          <option value={5}>5 {t('settings.google.min')}</option>
          <option value={10}>10 {t('settings.google.min')}</option>
          <option value={30}>30 {t('settings.google.min')}</option>
          <option value={60}>1 {t('settings.google.hour')}</option>
          <option value={1440}>{t('settings.google.syncDaily')}</option>
        </select>
      </SettingRow>
    </>
  )
}
