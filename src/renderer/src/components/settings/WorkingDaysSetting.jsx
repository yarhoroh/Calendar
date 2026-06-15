import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

// Pick which weekdays are working days. "Every day" reminders fire only on these.
const ORDER = [1, 2, 3, 4, 5, 6, 0] // Mon … Sun (0 = Sunday)

export default function WorkingDaysSetting() {
  const { t, lang } = useI18n()
  const [days, setDays] = useState([1, 2, 3, 4, 5])

  useEffect(() => {
    Promise.resolve(api.getWorkingDays?.()).then((d) => Array.isArray(d) && setDays(d))
  }, [])

  // localized short weekday name for index (0=Sun..6=Sat)
  const label = (idx) =>
    new Intl.DateTimeFormat(lang === 'uk' ? 'uk' : 'en', { weekday: 'short' }).format(
      new Date(2024, 0, 7 + idx) // 2024-01-07 is a Sunday
    )

  const toggle = (idx) => {
    const next = days.includes(idx) ? days.filter((d) => d !== idx) : [...days, idx].sort((a, b) => a - b)
    setDays(next)
    api.setWorkingDays?.(next)
  }

  return (
    <SettingRow title={t('settings.workingDays')} description={t('settings.workingDaysDesc')}>
      <div className="weekday-pick">
        {ORDER.map((idx) => (
          <button
            key={idx}
            className={'weekday-pick__btn' + (days.includes(idx) ? ' weekday-pick__btn--on' : '')}
            onClick={() => toggle(idx)}
          >
            {label(idx)}
          </button>
        ))}
      </div>
    </SettingRow>
  )
}
