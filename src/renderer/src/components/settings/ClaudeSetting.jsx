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

export default function ClaudeSetting() {
  const { t } = useI18n()
  const [st, setSt] = useState({ status: 'checking', version: '' })

  const detect = () => {
    setSt({ status: 'checking', version: '' })
    Promise.resolve(api.detectClaude?.()).then((r) =>
      setSt(r?.found ? { status: 'found', version: r.version } : { status: 'missing', version: '' })
    )
  }

  useEffect(() => {
    detect()
  }, [])

  const meta = META[st.status]

  return (
    <SettingRow title="Claude CLI" description={t('settings.gemini.desc')}>
      <div className="tool-status">
        <span className="tool-status__badge">
          <StatusDot tone={meta.tone} pulse={meta.pulse} />
          {t(`settings.gemini.${meta.key}`)}
          {st.status === 'found' && st.version ? ` · ${st.version}` : ''}
        </span>
        <button className="btn btn--ghost" onClick={detect}>
          {t('settings.gemini.check')}
        </button>
      </div>
    </SettingRow>
  )
}
