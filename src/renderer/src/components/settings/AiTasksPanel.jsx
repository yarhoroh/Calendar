import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'

// Tasks the AI scheduled for itself (or the user assigned). Read-only list with
// delete — the AI creates them via the "addAiTask" action.
const fmt = (at) => (at || '').replace('T', '  ')

export default function AiTasksPanel() {
  const { t } = useI18n()
  const [rows, setRows] = useState([])

  const load = () => Promise.resolve(api.getAiTasks?.()).then((r) => setRows(r || []))
  useEffect(() => {
    load()
    const off = api.onAiDataChanged?.(load)
    return () => off?.()
  }, [])

  const del = async (id) => {
    await api.deleteAiTask?.(id)
    load()
  }

  // pending first (by time), already-fired tasks greyed at the bottom
  const sorted = [...rows].sort((a, b) => a.done - b.done || (a.at || '').localeCompare(b.at || ''))

  return (
    <div className="ai-list">
      {sorted.length === 0 && <div className="ai-list__empty">{t('settings.tasksEmpty')}</div>}
      {sorted.map((r) => (
        <div className={'ai-list__row' + (r.done ? ' ai-list__row--done' : '')} key={r.id}>
          <div className="ai-list__body">
            <div className="ai-list__time">
              {fmt(r.at)}
              {r.done ? ' ✓' : ''}
            </div>
            <div className="ai-list__text">{r.text}</div>
          </div>
          <button className="ai-list__del" title={t('settings.delete')} onClick={() => del(r.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
