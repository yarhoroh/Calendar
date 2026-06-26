import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import api from '../../lib/api'
import SettingRow from './SettingRow'

// Voice / text-to-speech: choose the engine — bundled Piper (offline), the system
// Windows voices (SAPI), or Supertonic (multilingual neural, downloaded on first use).
const TEST_PHRASE = {
  // stress marks (U+0301 after the stressed vowel) to test whether Supertonic honours
  // them — e.g. го́лосу must stress the first syllable, not the model's default guess
  uk: 'До́брого дня! Це переві́рка го́лосу календаря́.',
  en: 'Hello! This is the calendar voice test.'
}
const ENGINES = ['piper', 'windows', 'supertonic']
const VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'] // Supertonic presets
// piper: only the Ukrainian model is multi-speaker (ru/en are single-voice)
const PIPER_VOICES = [{ id: 0, name: 'Lada' }, { id: 1, name: 'Mykyta' }, { id: 2, name: 'Tetiana' }]

export default function VoiceSetting() {
  const { t, lang } = useI18n()
  const [engine, setEngine] = useState('piper')
  const [voice, setVoice] = useState('F1') // Supertonic voice preset
  const [piperVoice, setPiperVoice] = useState(2) // piper uk speaker (default tetiana)
  const [speed, setSpeed] = useState(1) // speech speed for the selected engine
  // Supertonic download state — survives leaving/returning to settings (it lives in main)
  const [sup, setSup] = useState({ status: 'absent', progress: 0, error: '' })

  useEffect(() => {
    Promise.resolve(api.getTtsEngine?.()).then((e) => e && setEngine(e))
    Promise.resolve(api.getSupertonicVoice?.()).then((v) => v && setVoice(v))
    Promise.resolve(api.getPiperVoice?.()).then((v) => v != null && setPiperVoice(v))
    Promise.resolve(api.supertonicStatus?.()).then((s) => s && setSup(s))
    const off = api.onSupertonicProgress?.((s) => setSup(s)) // live progress in the background
    return () => off?.()
  }, [])

  // speed is per-engine → reload it whenever the selected engine changes
  useEffect(() => {
    Promise.resolve(api.getTtsSpeed?.(engine)).then((v) => v != null && setSpeed(v))
  }, [engine])

  const pick = (e) => {
    setEngine(e)
    api.setTtsEngine?.(e)
    // selecting Supertonic starts the (one-time) download if it isn't there yet
    if (e === 'supertonic' && sup.status !== 'ready') Promise.resolve(api.supertonicDownload?.()).then((s) => s && setSup(s))
  }
  const pickVoice = (v) => {
    setVoice(v)
    api.setSupertonicVoice?.(v)
  }
  const pickPiperVoice = (id) => {
    setPiperVoice(id)
    api.setPiperVoice?.(id)
  }
  const pickSpeed = (v) => {
    setSpeed(v)
    api.setTtsSpeed?.(engine, v)
  }
  const test = () => api.ttsSpeak?.({ text: TEST_PHRASE[lang] || TEST_PHRASE.uk, lang })

  const pct = Math.round((sup.progress || 0) * 100)

  return (
    <SettingRow title={t('settings.voice')} description={t('settings.voiceDesc')} stacked>
      <div className="lang-switch">
        {ENGINES.map((e) => (
          <button
            key={e}
            className={'lang-switch__btn' + (engine === e ? ' lang-switch__btn--active' : '')}
            // green text on Supertonic = model downloaded & ready (selection still shown by the active bg)
            style={e === 'supertonic' && sup.status === 'ready' ? { color: 'var(--accent)' } : undefined}
            onClick={() => pick(e)}
          >
            {t(`settings.voice_${e}`)}
          </button>
        ))}
      </div>

      {engine === 'piper' && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>{t('settings.voiceUkOnly')}</div>
          <div className="lang-switch" style={{ flexWrap: 'wrap' }}>
            {PIPER_VOICES.map((v) => (
              <button
                key={v.id}
                className={'lang-switch__btn' + (piperVoice === v.id ? ' lang-switch__btn--active' : '')}
                onClick={() => pickPiperVoice(v.id)}
              >
                {v.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {engine === 'supertonic' && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>{t('settings.voicePreset')}</div>
          <div className="lang-switch" style={{ flexWrap: 'wrap' }}>
            {VOICES.map((v) => (
              <button
                key={v}
                className={'lang-switch__btn' + (voice === v ? ' lang-switch__btn--active' : '')}
                onClick={() => pickVoice(v)}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>
          {t('settings.voiceSpeed')} · {speed.toFixed(2)}×
        </div>
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.05"
          value={speed}
          onChange={(e) => pickSpeed(Number(e.target.value))}
          style={{ width: '100%', maxWidth: 320, display: 'block', accentColor: 'var(--accent)' }}
        />
      </div>

      {engine === 'supertonic' && sup.status === 'downloading' && (
        <div style={{ marginTop: 8 }}>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden', marginBottom: 4 }}>
            <div style={{ height: '100%', width: pct + '%', background: 'var(--accent)', transition: 'width .2s' }} />
          </div>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            {t('settings.voiceDownloading')} {pct}%
          </span>
        </div>
      )}
      {engine === 'supertonic' && sup.status === 'error' && (
        <span style={{ marginTop: 8, fontSize: 12.5, color: '#e5484d' }}>
          ⚠ {sup.error}{' '}
          <button className="btn btn--ghost" onClick={() => Promise.resolve(api.supertonicDownload?.()).then((s) => s && setSup(s))}>
            ↻
          </button>
        </span>
      )}

      <button className="btn btn--ghost" onClick={test} style={{ display: 'block', marginTop: 12 }}>
        {t('settings.voiceTest')}
      </button>
    </SettingRow>
  )
}
