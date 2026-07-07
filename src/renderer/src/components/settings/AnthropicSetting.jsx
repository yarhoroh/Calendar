import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import StatusDot from '../StatusDot'
import SettingRow from './SettingRow'
import UsageReport from './UsageReport'

// Anthropic models this build knows a default price for. Any model string works if the pricing table
// in ai-config.json has an entry; the table drives the cost math.
const MODELS = ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5']

// Connect the paid Anthropic API to MEASURE real token cost. Paste a key, pick a model, select
// "Anthropic API" as the engine above. Every call logs tokens + price to the report below.
export default function AnthropicSetting() {
  const { t } = useI18n()
  const [status, setStatus] = useState({ hasKey: false, model: 'claude-sonnet-4-6', logText: false, cache: '5m' })
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [test, setTest] = useState(null) // null | 'testing' | 'ok' | 'fail'
  const [testErr, setTestErr] = useState('')

  const refresh = () => Promise.resolve(api.getAnthropicStatus?.()).then((s) => s && setStatus(s))
  useEffect(() => { refresh() }, [])

  const saveKey = async () => { setSaving(true); await api.setAnthropicKey?.(key.trim()); setSaving(false); setKey(''); setTest(null); refresh() }
  const clearKey = async () => { setSaving(true); await api.setAnthropicKey?.(''); setSaving(false); setTest(null); refresh() }
  const pickModel = (m) => { setStatus((s) => ({ ...s, model: m })); api.setAnthropicModel?.(m); setTest(null) }
  const toggleLog = (on) => { setStatus((s) => ({ ...s, logText: on })); api.setApiLogText?.(on) }
  const pickCache = (mode) => { setStatus((s) => ({ ...s, cache: mode })); api.setAnthropicCache?.(mode) }
  const runTest = async () => {
    setTest('testing'); setTestErr('')
    const r = await api.testAnthropic?.()
    if (r?.ok) setTest('ok')
    else { setTest('fail'); setTestErr(r?.error || 'failed') }
  }
  const a = (k) => t('settings.anthropic.' + k)

  return (
    <>
      <SettingRow stacked title="Anthropic API" description={a('desc')}>
        {status.hasKey ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <span className="tool-status__badge"><StatusDot tone="green" /> {a('hasKey')}</span>
              <select className="ai-add__input" style={{ maxWidth: 220 }} value={status.model} onChange={(e) => pickModel(e.target.value)}>
                {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                {!MODELS.includes(status.model) && <option value={status.model}>{status.model}</option>}
              </select>
              <button className="btn btn--ghost" onClick={runTest} disabled={test === 'testing'}>{test === 'testing' ? a('testing') : a('test')}</button>
              {test === 'ok' && <span className="tool-status__badge"><StatusDot tone="green" /> {a('ok')}</span>}
              {test === 'fail' && <span className="tool-status__badge" title={testErr}><StatusDot tone="red" /> {a('fail')}</span>}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <span style={{ opacity: 0.8, fontSize: 13 }}>{a('cache')}</span>
              <div className="lang-switch">
                {[['off', a('cacheOff')], ['5m', a('cache5m')], ['1h', a('cache1h')]].map(([v, lbl]) => (
                  <button key={v} className={'lang-switch__btn' + (status.cache === v ? ' lang-switch__btn--active' : '')} onClick={() => pickCache(v)}>{lbl}</button>
                ))}
              </div>
              <label className="tool-status__badge" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={!!status.logText} onChange={(e) => toggleLog(e.target.checked)} /> {a('logText')}
              </label>
              <button className="btn" onClick={clearKey} disabled={saving} style={{ marginLeft: 'auto' }}>{a('remove')}</button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span className="tool-status__badge"><StatusDot tone="amber" /> {a('noKey')}</span>
            <input className="ai-add__input" style={{ maxWidth: 240 }} type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="btn btn--primary" onClick={saveKey} disabled={saving || !key.trim()}>{a('add')}</button>
          </div>
        )}
      </SettingRow>
      <UsageReport />
    </>
  )
}
