import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import AiTaskForm from './AiTaskForm'

// Tasks the AI scheduled for itself, or that the user created manually via the
// form. The AI also creates them via the "addAiTask" action.
const fmt = (r) => {
  if (!r.every) return (r.at || '').replace('T', '  ')
  const win = r.winfrom && r.winto ? ` (${r.winfrom}–${r.winto})` : ''
  return `↻ every ${r.every} min${win}`
}

// little glyphs showing how an in-app task announces (voice / tray message)
const notifyIcons = (r) => {
  const m = String(r.notify || '').split(',')
  return (m.includes('voice') ? ' 🔊' : '') + (m.includes('tray') ? ' 🔔' : '')
}

export default function AiTasksPanel() {
  const { t } = useI18n()
  const [rows, setRows] = useState([])
  const [editingId, setEditingId] = useState(null)

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
      {sorted.map((r) =>
        editingId === r.id ? (
          <AiTaskForm
            key={r.id}
            task={r}
            onCreated={() => {
              setEditingId(null)
              load()
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div className={'ai-list__row' + (r.done ? ' ai-list__row--done' : '')} key={r.id}>
            <div className="ai-list__body">
              <div className="ai-list__time">
                {fmt(r)}
                {notifyIcons(r)}
                {r.done ? ' ✓' : ''}
              </div>
              <div className="ai-list__text">{r.text}</div>
            </div>
            <button className="ai-list__del" title={t('settings.taskEdit')} onClick={() => setEditingId(r.id)}>
              ✎
            </button>
            <button className="ai-list__del" title={t('settings.delete')} onClick={() => del(r.id)}>
              ×
            </button>
          </div>
        )
      )}
    </div>
  )
}
