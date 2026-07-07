import { useEffect, useState } from 'react'
import api from '../../lib/api'
import SettingRow from './SettingRow'

const fmtN = (n) => (n || 0).toLocaleString('ru-RU')
const fmt$ = (n) => '$' + (n || 0).toFixed(n >= 1 ? 2 : 4)

// Cost/token report for the Anthropic API engine. Reads api-usage.db (via usage:report) and shows
// grand totals + breakdowns by day, model and channel, plus the raw recent calls — so real spend is
// traceable over time. Cache-read tokens are billed at 0.1× and shown separately (the caching win).
export default function UsageReport() {
  const [rep, setRep] = useState(null)
  const [tab, setTab] = useState('day') // day | hour | model | channel | log
  const [loading, setLoading] = useState(false)

  const load = () => {
    setLoading(true)
    Promise.resolve(api.usageReport?.({ days: 90, logLimit: 200 })).then((r) => { setRep(r); setLoading(false) })
  }
  useEffect(() => { load() }, [])

  const clear = async () => {
    if (!window.confirm('Очистить всю статистику API? Отменить нельзя.')) return
    await api.usageClear?.()
    load()
  }

  const t = rep?.total
  const TABS = [['day', 'по дням'], ['hour', 'по часам'], ['model', 'по моделям'], ['channel', 'по каналам'], ['log', 'журнал']]
  const rows = { day: rep?.byDay, hour: rep?.byHour, model: rep?.byModel, channel: rep?.byChannel }[tab] || []
  const keyName = { day: 'day', hour: 'hour', model: 'model', channel: 'channel' }[tab]

  return (
    <SettingRow title="Расход API (Anthropic)" description="Токены и деньги по каждому вызову. Cache-read (кэш) считается по 0.1× — это экономия от кэширования.">
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* grand totals */}
        <div className="tool-status" style={{ flexWrap: 'wrap', gap: 12 }}>
          <b style={{ fontSize: 15 }}>{fmt$(t?.cost)}</b>
          <span>· {fmtN(t?.calls)} вызовов</span>
          <span>· вход {fmtN(t?.in_tok)}</span>
          <span>· выход {fmtN(t?.out_tok)}</span>
          <span>· кэш-запись {fmtN(t?.cw_tok)}</span>
          <span>· кэш-чтение {fmtN(t?.cr_tok)}</span>
          <button className="btn btn--ghost" onClick={load} disabled={loading} style={{ marginLeft: 'auto' }}>{loading ? '…' : 'обновить'}</button>
          <button className="btn" onClick={clear}>очистить</button>
        </div>

        {/* tab switch */}
        <div className="lang-switch">
          {TABS.map(([v, lbl]) => (
            <button key={v} className={'lang-switch__btn' + (tab === v ? ' lang-switch__btn--active' : '')} onClick={() => setTab(v)}>{lbl}</button>
          ))}
        </div>

        {/* table */}
        <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border, rgba(0,0,0,0.12))', borderRadius: 8 }}>
          {tab === 'log' ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ position: 'sticky', top: 0, background: 'var(--panel,#fff)' }}>
                <th style={th}>время</th><th style={th}>модель</th><th style={th}>канал</th><th style={thR}>вход</th><th style={thR}>выход</th><th style={thR}>кэш R</th><th style={thR}>$</th>
              </tr></thead>
              <tbody>
                {(rep?.recent || []).map((r) => (
                  <tr key={r.id}>
                    <td style={td}>{new Date(r.ts).toLocaleString('ru-RU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                    <td style={td}>{String(r.model || '').replace('claude-', '')}</td>
                    <td style={td}>{r.channel}</td>
                    <td style={tdR}>{fmtN(r.in_tok)}</td><td style={tdR}>{fmtN(r.out_tok)}</td><td style={tdR}>{fmtN(r.cr_tok)}</td><td style={tdR}>{fmt$(r.cost)}</td>
                  </tr>
                ))}
                {!rep?.recent?.length && <tr><td style={td} colSpan={7}>пусто</td></tr>}
              </tbody>
            </table>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ position: 'sticky', top: 0, background: 'var(--panel,#fff)' }}>
                <th style={th}>{TABS.find((x) => x[0] === tab)?.[1]}</th><th style={thR}>вызовы</th><th style={thR}>вход</th><th style={thR}>выход</th><th style={thR}>кэш R</th><th style={thR}>$</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r[keyName]}>
                    <td style={td}>{r[keyName]}</td>
                    <td style={tdR}>{fmtN(r.calls)}</td><td style={tdR}>{fmtN(r.in_tok)}</td><td style={tdR}>{fmtN(r.out_tok)}</td><td style={tdR}>{fmtN(r.cr_tok)}</td><td style={tdR}>{fmt$(r.cost)}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td style={td} colSpan={6}>пусто</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </SettingRow>
  )
}

const th = { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border,rgba(0,0,0,0.12))', fontWeight: 600 }
const thR = { ...th, textAlign: 'right' }
const td = { padding: '3px 8px', borderBottom: '1px solid var(--border,rgba(0,0,0,0.06))', whiteSpace: 'nowrap' }
const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
