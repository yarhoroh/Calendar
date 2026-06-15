import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

const OPTIONS = [
  { v: 0, key: 'always' },
  { v: 5, key: 's5' },
  { v: 10, key: 's10' }
]

export default function ReminderDurationSetting() {
  const { t } = useI18n()
  const [value, setValue] = useState(0)

  useEffect(() => {
    Promise.resolve(api.getReminderDuration?.()).then((d) => setValue(d || 0))
  }, [])

  const pick = (v) => {
    setValue(v)
    api.setReminderDuration?.(v)
  }

  return (
    <SettingRow title={t('settings.notifyDuration.label')}>
      <div className="lang-switch">
        {OPTIONS.map((o) => (
          <button
            key={o.v}
            className={'lang-switch__btn' + (value === o.v ? ' lang-switch__btn--active' : '')}
            onClick={() => pick(o.v)}
          >
            {t(`settings.notifyDuration.${o.key}`)}
          </button>
        ))}
      </div>
    </SettingRow>
  )
}
