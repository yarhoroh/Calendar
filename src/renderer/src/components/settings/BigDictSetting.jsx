import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import api from '../../lib/api'
import SettingRow from './SettingRow'

// Big pronunciation dictionaries (millions of word forms) downloaded on demand per language
// and stored as an indexed SQLite file — queried word-by-word during TTS, so they add full
// stress coverage without sitting in RAM. ru: RUAccent (Apache-2.0); uk: lang-uk dictionary.
const LANGS = [
  { id: 'ru', name: 'Русский', size: '≈180 MB' },
  { id: 'uk', name: 'Українська', size: '≈150 MB' }
]

export default function BigDictSetting() {
  const { t } = useI18n()
  const [cfg, setCfg] = useState({}) // { ru: bool, uk: bool }
  const [status, setStatus] = useState({}) // lang → { status, progress, error }

  useEffect(() => {
    Promise.resolve(api.getBigDict?.()).then((c) => c && setCfg(c))
    LANGS.forEach((l) =>
      Promise.resolve(api.bigDictStatus?.(l.id)).then((s) => s && setStatus((p) => ({ ...p, [l.id]: s })))
    )
    const off = api.onBigDictProgress?.((s) => setStatus((p) => ({ ...p, [s.lang]: s }))) // live progress
    return () => off?.()
  }, [])

  const toggle = (lang, on) => {
    setCfg((p) => ({ ...p, [lang]: on }))
    api.setBigDict?.(lang, on) // main saves the flag and starts the download when turning on
    if (!on) Promise.resolve(api.bigDictRemove?.(lang)).then((s) => s && setStatus((p) => ({ ...p, [lang]: s })))
  }
  const retry = (lang) => Promise.resolve(api.bigDictDownload?.(lang)).then((s) => s && setStatus((p) => ({ ...p, [lang]: s })))

  return (
    <SettingRow title={t('settings.bigDict')} description={t('settings.bigDictDesc')} stacked>
      {LANGS.map((l) => {
        const st = status[l.id] || { status: 'absent', progress: 0 }
        const on = cfg[l.id] === true
        const pct = Math.round((st.progress || 0) * 100)
        const downloading = st.status === 'downloading'
        const ready = st.status === 'ready'
        return (
          <div key={l.id} style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                className={'lang-switch__btn' + (on ? ' lang-switch__btn--active' : '')}
                onClick={() => toggle(l.id, !on)}
              >
                {l.name}
              </button>
              <span style={{ fontSize: 12.5, color: ready && on ? 'var(--accent)' : 'var(--muted)' }}>
                {downloading
                  ? `${pct < 92 ? t('settings.voiceDownloading') : t('settings.bigDictBuilding')} ${pct}%`
                  : ready
                    ? `✓ ${t('settings.bigDictReady')}`
                    : l.size}
              </span>
            </div>
            {downloading && (
              <div
                style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden', marginTop: 6, maxWidth: 320 }}
              >
                <div style={{ height: '100%', width: pct + '%', background: 'var(--accent)', transition: 'width .2s' }} />
              </div>
            )}
            {st.status === 'error' && (
              <span style={{ fontSize: 12.5, color: '#e5484d', display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                ⚠ {st.error}
                <button className="btn btn--ghost" onClick={() => retry(l.id)}>
                  ↻
                </button>
              </span>
            )}
          </div>
        )
      })}
    </SettingRow>
  )
}
