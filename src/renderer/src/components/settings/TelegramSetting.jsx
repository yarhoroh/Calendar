import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import StatusDot from '../StatusDot'
import SettingRow from './SettingRow'

// Connect a Telegram bot so you can chat with the assistant from Telegram.
// Token from @BotFather; stored in ai-config.json.
export default function TelegramSetting() {
  const { t } = useI18n()
  const [token, setToken] = useState('')
  const [status, setStatus] = useState({ on: false, hasToken: false })
  const [saving, setSaving] = useState(false)

  // extra password-session layer on top of the owner-chat lock
  const [auth, setAuth] = useState({ enabled: false, hasPassword: false, sessionMinutes: 60 })
  const [authPassword, setAuthPassword] = useState('')
  const [authSaving, setAuthSaving] = useState(false)

  const refresh = () => Promise.resolve(api.getTelegramStatus?.()).then((s) => s && setStatus(s))
  const refreshAuth = () => Promise.resolve(api.getTelegramAuth?.()).then((a) => a && setAuth(a))
  useEffect(() => {
    refresh()
    refreshAuth()
  }, [])

  const save = async () => {
    setSaving(true)
    await api.setTelegramToken?.(token.trim())
    setSaving(false)
    setToken('')
    refresh()
  }

  // Clear the stored token → the bridge stops and the input field comes back.
  const disconnect = async () => {
    setSaving(true)
    await api.setTelegramToken?.('')
    setSaving(false)
    refresh()
  }

  const toggleAuth = async (enabled) => {
    setAuthSaving(true)
    const r = await api.setTelegramAuth?.({ enabled, sessionMinutes: auth.sessionMinutes })
    setAuthSaving(false)
    if (r) setAuth(r)
    else refreshAuth()
  }

  const savePassword = async () => {
    if (!authPassword.trim()) return
    setAuthSaving(true)
    const r = await api.setTelegramAuth?.({
      enabled: true,
      password: authPassword.trim(),
      sessionMinutes: auth.sessionMinutes
    })
    setAuthSaving(false)
    setAuthPassword('')
    if (r) setAuth(r)
    else refreshAuth()
  }

  const saveSessionMinutes = async (mins) => {
    setAuth((a) => ({ ...a, sessionMinutes: mins }))
    await api.setTelegramAuth?.({ enabled: auth.enabled, sessionMinutes: mins })
  }

  const tone = status.on ? 'green' : status.hasToken ? 'red' : 'amber'
  const label = status.on ? t('settings.tg.on') : status.hasToken ? t('settings.tg.bad') : t('settings.tg.off')

  return (
    <SettingRow title="Telegram" description={t('settings.tg.desc')} stacked>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <span className="tool-status__badge">
            <StatusDot tone={tone} /> {label}
          </span>
          {status.hasToken ? (
            <button className="btn" onClick={disconnect} disabled={saving}>
              {t('settings.tg.disconnect')}
            </button>
          ) : (
            <>
              <input
                className="ai-add__input"
                style={{ maxWidth: 150 }}
                type="password"
                placeholder={t('settings.tg.token')}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button className="btn btn--primary" onClick={save} disabled={saving || !token.trim()}>
                {t('settings.add')}
              </button>
            </>
          )}
        </div>

        {status.hasToken && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <label className="tool-status__badge" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={auth.enabled}
                disabled={authSaving || (!auth.hasPassword && !auth.enabled)}
                onChange={(e) => toggleAuth(e.target.checked)}
              />{' '}
              {t('settings.tg.authEnable')}
            </label>
            <input
              className="ai-add__input"
              style={{ maxWidth: 150 }}
              type="password"
              placeholder={auth.hasPassword ? t('settings.tg.authChange') : t('settings.tg.authSet')}
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
            />
            <button className="btn" onClick={savePassword} disabled={authSaving || !authPassword.trim()}>
              {t('settings.add')}
            </button>
            <span style={{ opacity: 0.8, fontSize: 13 }}>{t('settings.tg.authSessionMinutes')}</span>
            <input
              className="ai-add__input"
              style={{ maxWidth: 56 }}
              type="number"
              min={1}
              value={auth.sessionMinutes}
              onChange={(e) => saveSessionMinutes(Math.max(1, Number(e.target.value) || 60))}
            />
          </div>
        )}
      </div>
    </SettingRow>
  )
}
