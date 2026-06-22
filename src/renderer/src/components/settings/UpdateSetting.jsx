import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

// Manual "check for updates" — reuses electron-updater. If a newer release is
// found it downloads in the background and the app shows a restart dialog when
// ready; here we just report the outcome.
export default function UpdateSetting() {
  const { t } = useI18n()
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState('') // '' | checking | latest | available | dev | error

  useEffect(() => {
    Promise.resolve(api.getVersion?.()).then((v) => setVersion(v || ''))
  }, [])

  const check = async () => {
    setStatus('checking')
    const r = await api.checkForUpdate?.()
    setStatus(r?.status || 'error')
  }

  const note = status && status !== 'checking' ? t(`settings.update.${status}`) : status === 'checking' ? t('settings.update.checking') : ''

  return (
    <SettingRow title={t('settings.update.title')} description={version ? `v${version}` : ''}>
      <div className="update-row">
        {note && <span className="update-row__note">{note}</span>}
        <button className="btn" onClick={check} disabled={status === 'checking'}>
          {t('settings.update.check')}
        </button>
      </div>
    </SettingRow>
  )
}
