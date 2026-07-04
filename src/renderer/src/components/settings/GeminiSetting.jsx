import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import StatusDot from '../StatusDot'
import SettingRow from './SettingRow'

// Free-tier models that actually work on the API key (Flash line + Gemma). Pro is intentionally
// omitted — its free-tier quota is zero. The user can still set any model by editing ai-config.json.
// verified free on the API key (HTTP 200). Models with a zero free-tier quota (gemini-2.0-flash,
// any -pro) are deliberately excluded — they return 429 RESOURCE_EXHAUSTED, limit: 0.
const MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemma-4-31b-it'
]

// Connect the free Google Gemini API: paste an API key (aistudio.google.com/apikey) and pick a
// model. The key lives in ai-config.json (userData), never in code. Select "Gemini API" as the
// engine above to route the chat/tasks through it.
export default function GeminiSetting() {
  const { t } = useI18n()
  const [status, setStatus] = useState({ hasKey: false, model: 'gemini-2.5-flash' })
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [test, setTest] = useState(null) // null | 'testing' | 'ok' | 'fail'
  const [testErr, setTestErr] = useState('')

  const refresh = () => Promise.resolve(api.getGeminiStatus?.()).then((s) => s && setStatus(s))
  useEffect(() => {
    refresh()
  }, [])

  const saveKey = async () => {
    setSaving(true)
    await api.setGeminiKey?.(key.trim())
    setSaving(false)
    setKey('')
    setTest(null)
    refresh()
  }

  const clearKey = async () => {
    setSaving(true)
    await api.setGeminiKey?.('')
    setSaving(false)
    setTest(null)
    refresh()
  }

  const pickModel = (m) => {
    setStatus((s) => ({ ...s, model: m }))
    api.setGeminiModel?.(m)
    setTest(null)
  }

  const runTest = async () => {
    setTest('testing')
    setTestErr('')
    const r = await api.testGemini?.()
    if (r?.ok) setTest('ok')
    else {
      setTest('fail')
      setTestErr(r?.error || 'failed')
    }
  }

  const tone = status.hasKey ? 'green' : 'amber'
  const label = status.hasKey ? t('settings.gemini.on') : t('settings.gemini.off')

  return (
    <SettingRow title="Gemini API" description={t('settings.gemini.desc')}>
      <div className="tool-status" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="tool-status__badge">
          <StatusDot tone={tone} /> {label}
        </span>

        {status.hasKey ? (
          <>
            <select className="ai-add__input" style={{ maxWidth: 190 }} value={status.model} onChange={(e) => pickModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {!MODELS.includes(status.model) && <option value={status.model}>{status.model}</option>}
            </select>
            <button className="btn btn--ghost" onClick={runTest} disabled={test === 'testing'}>
              {test === 'testing' ? t('settings.gemini.testing') : t('settings.gemini.test')}
            </button>
            {test === 'ok' && (
              <span className="tool-status__badge">
                <StatusDot tone="green" /> {t('settings.gemini.testOk')}
              </span>
            )}
            {test === 'fail' && (
              <span className="tool-status__badge" title={testErr}>
                <StatusDot tone="red" /> {t('settings.gemini.testFail')}
              </span>
            )}
            <button className="btn" onClick={clearKey} disabled={saving}>
              {t('settings.gemini.clear')}
            </button>
          </>
        ) : (
          <>
            <input
              className="ai-add__input"
              style={{ maxWidth: 190 }}
              type="password"
              placeholder={t('settings.gemini.key')}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button className="btn btn--primary" onClick={saveKey} disabled={saving || !key.trim()}>
              {t('settings.add')}
            </button>
          </>
        )}
      </div>
    </SettingRow>
  )
}
