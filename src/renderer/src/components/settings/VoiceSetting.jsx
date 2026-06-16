import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import api from '../../lib/api'
import SettingRow from './SettingRow'

// Voice / text-to-speech: choose the engine — bundled Piper (offline) or the
// system Windows voices (SAPI) — and test it.
const TEST_PHRASE = {
  uk: 'Доброго дня! Це перевірка голосу календаря.',
  en: 'Hello! This is the calendar voice test.'
}
const ENGINES = ['piper', 'windows']

export default function VoiceSetting() {
  const { t, lang } = useI18n()
  const [engine, setEngine] = useState('piper')

  useEffect(() => {
    Promise.resolve(api.getTtsEngine?.()).then((e) => e && setEngine(e))
  }, [])

  const pick = (e) => {
    setEngine(e)
    api.setTtsEngine?.(e)
  }
  const test = () => api.ttsSpeak?.({ text: TEST_PHRASE[lang] || TEST_PHRASE.uk, lang })

  return (
    <SettingRow title={t('settings.voice')} description={t('settings.voiceDesc')}>
      <div className="lang-switch">
        {ENGINES.map((e) => (
          <button
            key={e}
            className={'lang-switch__btn' + (engine === e ? ' lang-switch__btn--active' : '')}
            onClick={() => pick(e)}
          >
            {t(`settings.voice_${e}`)}
          </button>
        ))}
      </div>
      <button className="btn btn--ghost" onClick={test}>
        {t('settings.voiceTest')}
      </button>
    </SettingRow>
  )
}
