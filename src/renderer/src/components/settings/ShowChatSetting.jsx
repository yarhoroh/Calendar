import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

export default function ShowChatSetting({ checked, onChange }) {
  const { t } = useI18n()
  return (
    <SettingRow title={t('settings.showChat')}>
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={onChange} />
        <span />
      </label>
    </SettingRow>
  )
}
