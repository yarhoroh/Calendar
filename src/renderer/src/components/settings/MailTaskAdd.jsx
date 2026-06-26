import { useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import MailTaskForm from './MailTaskForm'

// "New mail watcher" affordance below the Mail Tasks section. Creating one broadcasts
// aiData:changed, so MailTasksPanel reloads on its own.
export default function MailTaskAdd() {
  const { t } = useI18n()
  const [adding, setAdding] = useState(false)

  return adding ? (
    <MailTaskForm onCreated={() => setAdding(false)} onCancel={() => setAdding(false)} />
  ) : (
    <button className="btn btn--ghost ai-task-add-btn" onClick={() => setAdding(true)}>
      {`＋ ${t('settings.mailTaskNew')}`}
    </button>
  )
}
