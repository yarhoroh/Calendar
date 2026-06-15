import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

export default function ReminderSoundSetting() {
  const { t } = useI18n()
  const [on, setOn] = useState(true)

  useEffect(() => {
    Promise.resolve(api.getReminderSound?.()).then((v) => setOn(v !== false))
  }, [])

  const toggle = () => {
    const next = !on
    setOn(next)
    api.setReminderSound?.(next)
  }

  return (
    <SettingRow title={t('settings.reminderSound')}>
      <label className="switch">
        <input type="checkbox" checked={on} onChange={toggle} />
        <span />
      </label>
    </SettingRow>
  )
}
