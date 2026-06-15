import { useI18n } from '../i18n/I18nContext'
import SettingsSection from '../components/settings/SettingsSection'
import GeminiSetting from '../components/settings/GeminiSetting'
import LanguageSetting from '../components/settings/LanguageSetting'
import ReminderDurationSetting from '../components/settings/ReminderDurationSetting'
import AutostartSetting from '../components/settings/AutostartSetting'

// Settings page — grows by adding more sections / rows.
export default function SettingsView() {
  const { t } = useI18n()
  return (
    <div className="settings">
      <div className="settings__list">
        <SettingsSection>
          <LanguageSetting />
          <ReminderDurationSetting />
          <AutostartSetting />
        </SettingsSection>
        <SettingsSection title={t('settings.tools')}>
          <GeminiSetting />
        </SettingsSection>
      </div>
    </div>
  )
}
