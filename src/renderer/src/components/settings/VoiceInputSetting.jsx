import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

// Local offline voice input (sherpa-onnx). Toggle it on, pick a language, and
// download its model once (into userData). When on + downloaded, a mic button
// appears in the chat that records and transcribes locally into the input.
export default function VoiceInputSetting() {
  const { t } = useI18n()
  const [cfg, setCfg] = useState({ enabled: false, lang: 'ru' })
  const [status, setStatus] = useState({})
  const [prog, setProg] = useState(null) // { lang, progress } while downloading

  const reload = async () => {
    setCfg((await api.asr?.getConfig?.()) || { enabled: false, lang: 'ru' })
    setStatus((await api.asr?.status?.()) || {})
  }
  useEffect(() => {
    reload()
    const offC = api.asr?.onChanged?.(reload)
    const offP = api.asr?.onProgress?.((p) => setProg(p))
    return () => {
      offC?.()
      offP?.()
    }
  }, [])

  const setEnabled = (v) => {
    api.asr?.setConfig?.({ enabled: v })
    setCfg((c) => ({ ...c, enabled: v }))
  }
  const setLang = (v) => {
    api.asr?.setConfig?.({ lang: v })
    setCfg((c) => ({ ...c, lang: v }))
  }
  const download = async (lang) => {
    setProg({ lang, progress: 0 })
    await api.asr?.download?.(lang)
    setProg(null)
    reload()
  }

  const lang = cfg.lang || 'ru'
  const st = status[lang] || {}
  const downloading = prog && prog.lang === lang

  return (
    <SettingRow title={t('settings.voiceInput.title')} description={t('settings.voiceInput.desc')}>
      <div className="voice-input">
        <label className="voice-input__toggle">
          <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('settings.voiceInput.enable')}
        </label>
        <select className="select" value={lang} onChange={(e) => setLang(e.target.value)}>
          {Object.entries(status).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        {st.ready ? (
          <span className="voice-input__note">{t('settings.voiceInput.ready')}</span>
        ) : downloading ? (
          <span className="voice-input__note">{Math.round((prog.progress || 0) * 100)}%</span>
        ) : (
          <button className="btn" onClick={() => download(lang)}>
            {t('settings.voiceInput.download')} (~{st.mb || '?'} MB)
          </button>
        )}
      </div>
    </SettingRow>
  )
}
