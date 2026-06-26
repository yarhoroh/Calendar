import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import MailTaskForm from './MailTaskForm'

// Mail watcher tasks the user created — "watch this mailbox and tell me what matters".
// Separate from the calendar AI tasks. Edited here; the AI does not create these.
const fmt = (r) => {
  const acct = r.account === 'all' ? 'all accounts' : r.account
  const win = r.winfrom && r.winto ? ` ${r.winfrom}–${r.winto}` : ''
  return `📬 ${acct} · ${r.folder || 'INBOX'} · ↻ ${r.every} min${win}`
}

export default function MailTasksPanel() {
  const { t } = useI18n()
  const [rows, setRows] = useState([])
  const [editingId, setEditingId] = useState(null)

  const load = () => Promise.resolve(api.getMailTasks?.()).then((r) => setRows(r || []))
  useEffect(() => {
    load()
    const off = api.onAiDataChanged?.(load)
    return () => off?.()
  }, [])

  const del = async (id) => {
    await api.deleteMailTask?.(id)
    load()
  }

  return (
    <div className="ai-list">
      {rows.length === 0 && <div className="ai-list__empty">{t('settings.mailTasksEmpty')}</div>}
      {rows.map((r) =>
        editingId === r.id ? (
          <MailTaskForm
            key={r.id}
            task={r}
            onCreated={() => {
              setEditingId(null)
              load()
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div className={'ai-list__row' + (r.enabled === 0 ? ' ai-list__row--done' : '')} key={r.id}>
            <div className="ai-list__body">
              <div className="ai-list__time">
                {fmt(r)}
                {r.enabled === 0 ? ` ${t('settings.mailTaskOff')}` : ''}
              </div>
              <div className="ai-list__text">{r.prompt}</div>
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
