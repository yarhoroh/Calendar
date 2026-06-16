import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

const OPTIONS = [
  { v: 'gemini', label: 'Gemini' },
  { v: 'claude', label: 'Claude' },
  { v: 'codex', label: 'Codex' }
]

export default function AiEngineSetting() {
  const { t } = useI18n()
  const [ai, setAiState] = useState('gemini')

  useEffect(() => {
    Promise.resolve(api.getAi?.()).then((v) => setAiState(v || 'gemini'))
  }, [])

  const pick = (v) => {
    setAiState(v)
    api.setAi?.(v)
  }

  return (
    <SettingRow title={t('settings.aiEngine')}>
      <div className="lang-switch">
        {OPTIONS.map((o) => (
          <button
            key={o.v}
            className={'lang-switch__btn' + (ai === o.v ? ' lang-switch__btn--active' : '')}
            onClick={() => pick(o.v)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </SettingRow>
  )
}
