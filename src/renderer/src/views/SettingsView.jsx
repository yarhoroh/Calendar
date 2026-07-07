import { useState, useEffect } from 'react'
import api from '../lib/api'
import { useI18n } from '../i18n/I18nContext'
import SettingsSection from '../components/settings/SettingsSection'
import ClaudeSetting from '../components/settings/ClaudeSetting'
import CodexSetting from '../components/settings/CodexSetting'
import AntigravitySetting from '../components/settings/AntigravitySetting'
import GeminiSetting from '../components/settings/GeminiSetting'
import AnthropicSetting from '../components/settings/AnthropicSetting'
import AiConfigSetting from '../components/settings/AiConfigSetting'
import TelegramSetting from '../components/settings/TelegramSetting'
import GoogleAccountsSetting from '../components/settings/GoogleAccountsSetting'
import MailAccountsSetting from '../components/settings/MailAccountsSetting'
import AiEngineSetting from '../components/settings/AiEngineSetting'
import LanguageSetting from '../components/settings/LanguageSetting'
import SkinSetting from '../components/settings/SkinSetting'
import ReminderDurationSetting from '../components/settings/ReminderDurationSetting'
import ReminderSoundSetting from '../components/settings/ReminderSoundSetting'
import AutostartSetting from '../components/settings/AutostartSetting'
import ShowChatSetting from '../components/settings/ShowChatSetting'
import VoiceSetting from '../components/settings/VoiceSetting'
import BigDictSetting from '../components/settings/BigDictSetting'
import WorkingDaysSetting from '../components/settings/WorkingDaysSetting'
import MemoryPanel from '../components/settings/MemoryPanel'
import AiTasksPanel from '../components/settings/AiTasksPanel'
import AiTaskAdd from '../components/settings/AiTaskAdd'
import MailTasksPanel from '../components/settings/MailTasksPanel'
import MailTaskAdd from '../components/settings/MailTaskAdd'
import StatusesPanel from '../components/settings/StatusesPanel'
import FocusBlurSetting from '../components/settings/FocusBlurSetting'
import GeneralUnsortedSetting from '../components/settings/GeneralUnsortedSetting'
import CompactSetting from '../components/settings/CompactSetting'
import UpdateSetting from '../components/settings/UpdateSetting'
import VoiceInputSetting from '../components/settings/VoiceInputSetting'

// Settings page — two tabs: general app settings, and the assistant's own data
// (memory + scheduled tasks) so the user can see and control what the AI keeps.
export default function SettingsView({ showChat, onToggleChat, compact, onToggleCompact, skin, onApplySkin }) {
  const { t } = useI18n()
  const [tab, setTab] = useState('general')
  const [ai, setAi] = useState(null) // active engine — only ITS settings row is shown (less clutter)
  // read the engine ourselves too (authoritative) — don't depend solely on the child's callback timing
  useEffect(() => { Promise.resolve(api.getAi?.()).then((v) => setAi(v || 'agy')) }, [])

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
              <VoiceSetting />
              <BigDictSetting />
              <VoiceInputSetting />
              <AutostartSetting />
            </SettingsSection>
            <SettingsSection title={t('settings.interface')}>
              <SkinSetting skin={skin} onApply={onApplySkin} />
              <ShowChatSetting checked={showChat} onChange={onToggleChat} />
              <FocusBlurSetting />
              <GeneralUnsortedSetting />
              <CompactSetting compact={compact} onToggle={onToggleCompact} />
            </SettingsSection>
            <SettingsSection title={t('settings.tools')}>
              <AiEngineSetting onChange={setAi} />
              {ai === 'claude' && <ClaudeSetting />}
              {ai === 'codex' && <CodexSetting />}
              {ai === 'agy' && <AntigravitySetting />}
              {ai === 'gemini' && <GeminiSetting />}
              {ai === 'anthropic' && <AnthropicSetting />}
              <AiConfigSetting />
            </SettingsSection>
            <SettingsSection title={t('settings.bots')}>
              <TelegramSetting />
            </SettingsSection>
            <SettingsSection title={t('settings.google.title')}>
              <GoogleAccountsSetting />
            </SettingsSection>
            <SettingsSection title="Email (IMAP)">
              <MailAccountsSetting />
            </SettingsSection>
            <SettingsSection title={t('settings.statuses')}>
              <StatusesPanel />
            </SettingsSection>
            <SettingsSection title={t('settings.update.section')}>
              <UpdateSetting />
            </SettingsSection>
          </>
        ) : (
          <>
            <SettingsSection title={t('settings.memory')}>
              <MemoryPanel />
            </SettingsSection>
            <SettingsSection title={t('settings.aiTasks')} footer={<AiTaskAdd />}>
              <AiTasksPanel />
            </SettingsSection>
            <SettingsSection title={t('settings.mailTasks')} footer={<MailTaskAdd />}>
              <MailTasksPanel />
            </SettingsSection>
          </>
        )}
      </div>
    </div>
  )
}
