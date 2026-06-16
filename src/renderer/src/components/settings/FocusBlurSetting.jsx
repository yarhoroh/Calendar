import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

// Toggle the hover-focus blur: holding the cursor on a note dims the others so
// it reads clearly. On by default; stored with the calendar settings.
export default function FocusBlurSetting() {
  const { t } = useI18n()
  const [on, setOn] = useState(true)

  useEffect(() => {
    Promise.resolve(api.getCalendar?.()).then((c) => setOn(c?.focusBlur !== false))
  }, [])

  const toggle = () => {
    const next = !on
    setOn(next)
    api.setCalendar?.({ focusBlur: next })
  }

  return (
    <SettingRow title={t('settings.focusBlur')} description={t('settings.focusBlurDesc')}>
      <label className="switch">
        <input type="checkbox" checked={on} onChange={toggle} />
        <span />
      </label>
    </SettingRow>
  )
}
