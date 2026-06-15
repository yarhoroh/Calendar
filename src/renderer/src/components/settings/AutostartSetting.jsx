import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

export default function AutostartSetting() {
  const { t } = useI18n()
  const [on, setOn] = useState(false)

  useEffect(() => {
    Promise.resolve(api.getAutostart?.()).then((v) => setOn(!!v))
  }, [])

  const toggle = () => {
    const next = !on
    setOn(next)
    api.setAutostart?.(next)
  }

  return (
    <SettingRow title={t('settings.autostart')}>
      <label className="switch">
        <input type="checkbox" checked={on} onChange={toggle} />
        <span />
      </label>
    </SettingRow>
  )
}
