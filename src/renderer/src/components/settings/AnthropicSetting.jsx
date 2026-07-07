import { useEffect, useState } from 'react'
import api from '../../lib/api'
import StatusDot from '../StatusDot'
import SettingRow from './SettingRow'
import UsageReport from './UsageReport'

// Anthropic models this build knows a default price for. The user may set any model string by editing
// ai-config.json; the pricing table there drives the cost math.
const MODELS = ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5']

// Connect the paid Anthropic API to MEASURE real token cost of the assistant. Paste a key from
// console.anthropic.com, pick a model. The chat routes through it (select "Anthropic API" as the
// engine above); every call logs tokens + price to api-usage.db, shown in the report below.
export default function AnthropicSetting() {
  const [status, setStatus] = useState({ hasKey: false, model: 'claude-sonnet-4-6', logText: false })
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
  const runTest = async () => {
    setTest('testing'); setTestErr('')
    const r = await api.testAnthropic?.()
    if (r?.ok) setTest('ok')
    else { setTest('fail'); setTestErr(r?.error || 'failed') }
  }

  return (
    <>
      <SettingRow title="Anthropic API" description="Прямой API Anthropic для замера реальной стоимости токенов. Ключ — console.anthropic.com. Промпт кэшируется, каждый вызов пишет токены и цену в отчёт ниже.">
        <div className="tool-status" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="tool-status__badge">
            <StatusDot tone={status.hasKey ? 'green' : 'amber'} /> {status.hasKey ? 'ключ есть' : 'нет ключа'}
          </span>
          {status.hasKey ? (
            <>
              <select className="ai-add__input" style={{ maxWidth: 200 }} value={status.model} onChange={(e) => pickModel(e.target.value)}>
                {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                {!MODELS.includes(status.model) && <option value={status.model}>{status.model}</option>}
              </select>
              <button className="btn btn--ghost" onClick={runTest} disabled={test === 'testing'}>
                {test === 'testing' ? 'проверка…' : 'проверить ключ'}
              </button>
              {test === 'ok' && <span className="tool-status__badge"><StatusDot tone="green" /> ок</span>}
              {test === 'fail' && <span className="tool-status__badge" title={testErr}><StatusDot tone="red" /> ошибка</span>}
              <label className="tool-status__badge" style={{ cursor: 'pointer' }} title="Хранить полный текст запроса/ответа каждого вызова (приватность + рост базы)">
                <input type="checkbox" checked={!!status.logText} onChange={(e) => toggleLog(e.target.checked)} /> хранить текст
              </label>
              <button className="btn" onClick={clearKey} disabled={saving}>убрать ключ</button>
            </>
          ) : (
            <>
              <input className="ai-add__input" style={{ maxWidth: 220 }} type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
              <button className="btn btn--primary" onClick={saveKey} disabled={saving || !key.trim()}>Добавить</button>
            </>
          )}
        </div>
      </SettingRow>
      <UsageReport />
    </>
  )
}
