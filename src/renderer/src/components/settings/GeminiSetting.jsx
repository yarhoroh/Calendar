import { useI18n } from '../../i18n/I18nContext'
import { useGeminiStatus } from '../../hooks/useGeminiStatus'
import StatusDot from '../StatusDot'
import SettingRow from './SettingRow'

const STATUS = {
  checking: { tone: 'amber', pulse: true, key: 'checking' },
  found: { tone: 'green', key: 'active' },
  missing: { tone: 'red', key: 'missing' },
  installing: { tone: 'amber', pulse: true, key: 'installing' },
  error: { tone: 'red', key: 'error' }
}

export default function GeminiSetting() {
  const { t } = useI18n()
  const { status, version, path, error, detect, install } = useGeminiStatus()
  const meta = STATUS[status]

  const description =
    status === 'error'
      ? error
      : status === 'found' && path
        ? path
        : t('settings.gemini.desc')

  return (
    <SettingRow title="Gemini CLI" description={description}>
      <div className="tool-status">
        <span className="tool-status__badge">
          <StatusDot tone={meta.tone} pulse={meta.pulse} />
          {t(`settings.gemini.${meta.key}`)}
          {status === 'found' && version ? ` · ${version}` : ''}
        </span>

        {status === 'missing' && (
          <button className="btn btn--primary" onClick={install}>
            {t('settings.gemini.install')}
          </button>
        )}
        {status === 'error' && (
          <button className="btn btn--ghost" onClick={detect}>
            {t('settings.gemini.retry')}
          </button>
        )}
        {status === 'found' && (
          <button className="btn btn--ghost" onClick={detect}>
            {t('settings.gemini.check')}
          </button>
        )}
      </div>
    </SettingRow>
  )
}
