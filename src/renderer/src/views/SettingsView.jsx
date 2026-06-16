import { useState } from 'react'
import { useI18n } from '../i18n/I18nContext'
import SettingsSection from '../components/settings/SettingsSection'
import GeminiSetting from '../components/settings/GeminiSetting'
import ClaudeSetting from '../components/settings/ClaudeSetting'
import CodexSetting from '../components/settings/CodexSetting'
import AiConfigSetting from '../components/settings/AiConfigSetting'
import TelegramSetting from '../components/settings/TelegramSetting'
import AiEngineSetting from '../components/settings/AiEngineSetting'
import LanguageSetting from '../components/settings/LanguageSetting'
import ReminderDurationSetting from '../components/settings/ReminderDurationSetting'
import ReminderSoundSetting from '../components/settings/ReminderSoundSetting'
import AutostartSetting from '../components/settings/AutostartSetting'
import ShowChatSetting from '../components/settings/ShowChatSetting'
import VoiceSetting from '../components/settings/VoiceSetting'
import WorkingDaysSetting from '../components/settings/WorkingDaysSetting'
import MemoryPanel from '../components/settings/MemoryPanel'
import AiTasksPanel from '../components/settings/AiTasksPanel'
import StatusesPanel from '../components/settings/StatusesPanel'
import FocusBlurSetting from '../components/settings/FocusBlurSetting'

// Settings page — two tabs: general app settings, and the assistant's own data
// (memory + scheduled tasks) so the user can see and control what the AI keeps.
export default function SettingsView({ showChat, onToggleChat }) {
  const { t } = useI18n()
  const [tab, setTab] = useState('general')

  return (
    <div className="settings">
      <div className="settings-tabs">
        <button
          className={'settings-tabs__btn' + (tab === 'general' ? ' settings-tabs__btn--active' : '')}
          onClick={() => setTab('general')}
        >
          {t('settings.tabGeneral')}
        </button>
        <button
          className={'settings-tabs__btn' + (tab === 'ai' ? ' settings-tabs__btn--active' : '')}
          onClick={() => setTab('ai')}
        >
          {t('settings.tabAi')}
        </button>
      </div>

      <div className="settings__list">
        {tab === 'general' ? (
          <>
            <SettingsSection>
              <LanguageSetting />
              <ReminderDurationSetting />
              <ReminderSoundSetting />
              <WorkingDaysSetting />
              <ShowChatSetting checked={showChat} onChange={onToggleChat} />
              <FocusBlurSetting />
              <VoiceSetting />
              <AutostartSetting />
            </SettingsSection>
            <SettingsSection title={t('settings.tools')}>
              <AiEngineSetting />
              <GeminiSetting />
              <ClaudeSetting />
              <CodexSetting />
              <AiConfigSetting />
            </SettingsSection>
            <SettingsSection title={t('settings.bots')}>
              <TelegramSetting />
            </SettingsSection>
            <SettingsSection title={t('settings.statuses')}>
              <StatusesPanel />
            </SettingsSection>
          </>
        ) : (
          <>
            <SettingsSection title={t('settings.memory')}>
              <MemoryPanel />
            </SettingsSection>
            <SettingsSection title={t('settings.aiTasks')}>
              <AiTasksPanel />
            </SettingsSection>
          </>
        )}
      </div>
    </div>
  )
}
