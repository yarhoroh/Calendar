import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import StatusDot from '../StatusDot'
import SettingRow from './SettingRow'

const META = {
  checking: { tone: 'amber', pulse: true, key: 'checking' },
  found: { tone: 'green', key: 'active' },
  missing: { tone: 'red', key: 'missing' }
}

// Status row for the Antigravity CLI (agy), mirroring the other engine rows.
export default function AntigravitySetting() {
  const { t } = useI18n()
  const [st, setSt] = useState({ status: 'checking' })

  const detect = () => {
    setSt({ status: 'checking' })
    Promise.resolve(api.detectAgy?.()).then((r) => setSt({ status: r?.found ? 'found' : 'missing' }))
  }

  useEffect(() => {
    detect()
  }, [])

  const meta = META[st.status]

  return (
    <SettingRow title="Antigravity CLI" description={t('settings.cli.desc')}>
      <div className="tool-status">
        <span className="tool-status__badge">
          <StatusDot tone={meta.tone} pulse={meta.pulse} />
          {t(`settings.cli.${meta.key}`)}
        </span>
        <button className="btn btn--ghost" onClick={detect}>
          {t('settings.cli.check')}
        </button>
      </div>
    </SettingRow>
  )
}
