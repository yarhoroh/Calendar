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

  const refresh = () => Promise.resolve(api.getTelegramStatus?.()).then((s) => s && setStatus(s))
  useEffect(() => {
    refresh()
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

  const tone = status.on ? 'green' : status.hasToken ? 'red' : 'amber'
  const label = status.on ? t('settings.tg.on') : status.hasToken ? t('settings.tg.bad') : t('settings.tg.off')

  return (
    <SettingRow title="Telegram" description={t('settings.tg.desc')}>
      <div className="tool-status">
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
    </SettingRow>
  )
}
