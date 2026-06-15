import { useI18n } from '../../i18n/I18nContext'
import api from '../../lib/api'
import SettingRow from './SettingRow'

// Voice / text-to-speech. For now a single test button; per-language voice
// pickers (uk / ru / en) land here once those voices are bundled.
const TEST_PHRASE = {
  uk: 'Доброго дня! Це перевірка голосу календаря.',
  en: 'Hello! This is the calendar voice test.'
}

export default function VoiceSetting() {
  const { t, lang } = useI18n()
  const test = () => api.ttsSpeak?.({ text: TEST_PHRASE[lang] || TEST_PHRASE.uk, lang })

  return (
    <SettingRow title={t('settings.voice')} description={t('settings.voiceDesc')}>
      <button className="btn btn--ghost" onClick={test}>
        {t('settings.voiceTest')}
      </button>
    </SettingRow>
  )
}
