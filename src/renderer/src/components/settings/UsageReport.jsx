import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

const fmtN = (n) => (n || 0).toLocaleString()
const fmt$ = (n) => '$' + (n || 0).toFixed(n >= 1 ? 2 : 4)

// Cost/token report for the Anthropic API engine. Reads api-usage.db and shows grand totals +
// breakdowns by day / hour / model / channel, plus the raw recent calls — so real spend is traceable
// over time. Cache-read tokens are billed at 0.1× and shown separately (the caching win).
export default function UsageReport() {
  const { t } = useI18n()
  const u = (k) => t('settings.usage.' + k)
  const [rep, setRep] = useState(null)
  const [tab, setTab] = useState('day')
  const [loading, setLoading] = useState(false)

  const load = () => {
    setLoading(true)
    Promise.resolve(api.usageReport?.({ days: 90, logLimit: 200 })).then((r) => { setRep(r); setLoading(false) })
  }
  useEffect(() => { load() }, [])

  const clear = async () => { if (!window.confirm(u('confirmClear'))) return; await api.usageClear?.(); load() }

  const tot = rep?.total
  const TABS = [['day', u('tabDay')], ['hour', u('tabHour')], ['model', u('tabModel')], ['channel', u('tabChannel')], ['log', u('tabLog')]]
  const rows = { day: rep?.byDay, hour: rep?.byHour, model: rep?.byModel, channel: rep?.byChannel }[tab] || []
  const keyName = { day: 'day', hour: 'hour', model: 'model', channel: 'channel' }[tab]
  const tk = ' ' + u('tokens')

  return (
    <SettingRow stacked title={u('title')} description={u('desc')}>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* grand totals — one line, explicit token labels */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 14, fontSize: 13 }}>
          <b style={{ fontSize: 17 }}>{fmt$(tot?.cost)}</b>
          <span>{fmtN(tot?.calls)} {u('calls')}</span>
          <span>{u('input')}: <b>{fmtN(tot?.in_tok)}</b>{tk}</span>
          <span>{u('output')}: <b>{fmtN(tot?.out_tok)}</b>{tk}</span>
          <span>{u('cacheWrite')}: <b>{fmtN(tot?.cw_tok)}</b></span>
          <span>{u('cacheRead')}: <b>{fmtN(tot?.cr_tok)}</b></span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn btn--ghost" onClick={load} disabled={loading}>{loading ? '…' : u('refresh')}</button>
            <button className="btn" onClick={clear}>{u('clear')}</button>
          </span>
        </div>

        {/* tab switch */}
        <div className="lang-switch" style={{ alignSelf: 'flex-start' }}>
          {TABS.map(([v, lbl]) => (
            <button key={v} className={'lang-switch__btn' + (tab === v ? ' lang-switch__btn--active' : '')} onClick={() => setTab(v)}>{lbl}</button>
          ))}
        </div>

        {/* table — full width */}
        <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--border, rgba(0,0,0,0.12))', borderRadius: 8 }}>
          {tab === 'log' ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ position: 'sticky', top: 0, background: 'var(--panel,#fff)' }}>
                <th style={th}>{u('time')}</th><th style={th}>{u('model')}</th><th style={th}>{u('channel')}</th>
                <th style={thR}>{u('input')}</th><th style={thR}>{u('output')}</th><th style={thR}>{u('cacheRead')}</th><th style={thR}>$</th>
              </tr></thead>
              <tbody>
                {(rep?.recent || []).map((r) => (
                  <tr key={r.id}>
                    <td style={td}>{new Date(r.ts).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                    <td style={td}>{String(r.model || '').replace('claude-', '')}</td>
                    <td style={td}>{r.channel}</td>
                    <td style={tdR}>{fmtN(r.in_tok)}</td><td style={tdR}>{fmtN(r.out_tok)}</td><td style={tdR}>{fmtN(r.cr_tok)}</td><td style={tdR}>{fmt$(r.cost)}</td>
                  </tr>
                ))}
                {!rep?.recent?.length && <tr><td style={td} colSpan={7}>{u('empty')}</td></tr>}
              </tbody>
            </table>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ position: 'sticky', top: 0, background: 'var(--panel,#fff)' }}>
                <th style={th}>{TABS.find((x) => x[0] === tab)?.[1]}</th><th style={thR}>{u('calls')}</th>
                <th style={thR}>{u('input')}</th><th style={thR}>{u('output')}</th><th style={thR}>{u('cacheRead')}</th><th style={thR}>$</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r[keyName]}>
                    <td style={td}>{r[keyName]}</td>
                    <td style={tdR}>{fmtN(r.calls)}</td><td style={tdR}>{fmtN(r.in_tok)}</td><td style={tdR}>{fmtN(r.out_tok)}</td><td style={tdR}>{fmtN(r.cr_tok)}</td><td style={tdR}>{fmt$(r.cost)}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td style={td} colSpan={6}>{u('empty')}</td></tr>}
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
