import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

// Shows where ai-config.json lives + quick open / reveal. Deleting the file is
// safe — it's recreated with defaults on the next launch.
export default function AiConfigSetting() {
  const { t } = useI18n()
  const [path, setPath] = useState('')

  useEffect(() => {
    Promise.resolve(api.getAiConfigPath?.()).then((p) => p && setPath(p))
  }, [])

  return (
    <SettingRow title={t('settings.aiConfigFile')} description={path}>
      <div className="tool-status">
        <button className="btn btn--ghost" onClick={() => api.openAiConfig?.()}>
          {t('settings.open')}
        </button>
        <button className="btn btn--ghost" onClick={() => api.revealAiConfig?.()}>
          {t('settings.folder')}
        </button>
      </div>
    </SettingRow>
  )
}
