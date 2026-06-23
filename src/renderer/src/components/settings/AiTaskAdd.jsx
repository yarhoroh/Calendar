import { useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import AiTaskForm from './AiTaskForm'

// The "new AI task" affordance, placed BELOW the tasks section (outside its
// body). Creating a task broadcasts aiData:changed, so AiTasksPanel reloads on
// its own — no direct coupling needed here.
export default function AiTaskAdd() {
  const { t } = useI18n()
  const [adding, setAdding] = useState(false)

  return adding ? (
    <AiTaskForm onCreated={() => setAdding(false)} onCancel={() => setAdding(false)} />
  ) : (
    <button className="btn btn--ghost ai-task-add-btn" onClick={() => setAdding(true)}>
      {`＋ ${t('settings.taskNew')}`}
    </button>
  )
}
