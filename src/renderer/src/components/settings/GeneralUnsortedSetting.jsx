import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

// When on, selecting the "General" root shows only notes that aren't filed into
// any folder (instead of every note). Off by default; stored with the calendar
// settings — takes effect when you return to the calendar.
export default function GeneralUnsortedSetting() {
  const { t } = useI18n()
  const [on, setOn] = useState(false)

  useEffect(() => {
    Promise.resolve(api.getCalendar?.()).then((c) => setOn(!!c?.generalUnsortedOnly))
  }, [])

  const toggle = () => {
    const next = !on
    setOn(next)
    api.setCalendar?.({ generalUnsortedOnly: next })
  }

  return (
    <SettingRow title={t('settings.generalUnsorted')} description={t('settings.generalUnsortedDesc')}>
      <label className="switch">
        <input type="checkbox" checked={on} onChange={toggle} />
        <span />
      </label>
    </SettingRow>
  )
}
