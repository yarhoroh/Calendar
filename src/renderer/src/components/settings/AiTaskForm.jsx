import { useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import './AiTaskForm.css'

// datetime-local string for now + N minutes (local time, no seconds)
function nowPlus(mins) {
  const d = new Date(Date.now() + mins * 60000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

// Create OR edit an AI self-task: a prompt the assistant runs on schedule.
// Same ai_tasks row the AI's addAiTask action produces, plus a `notify`
// preference (voice / tray message) the task runner injects when it fires.
// Pass `task` to edit an existing one (pre-fills + saves via updateAiTask).
export default function AiTaskForm({ task, onCreated, onCancel }) {
  const { t } = useI18n()
  const editing = !!task
  const nm = String(task?.notify || '').split(',')
  const [text, setText] = useState(task?.text || '')
  const [periodic, setPeriodic] = useState(!!task?.every)
  const [at, setAt] = useState(() => (task?.at ? String(task.at).slice(0, 16) : nowPlus(30)))
  const [every, setEvery] = useState(task?.every || 60)
  const [from, setFrom] = useState(task?.winfrom || '')
  const [to, setTo] = useState(task?.winto || '')
  const [voice, setVoice] = useState(editing ? nm.includes('voice') : true)
  const [tray, setTray] = useState(editing ? nm.includes('tray') : false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setErr('')
    if (!text.trim()) return setErr(t('settings.taskNeedText'))
    if (periodic ? !(Number(every) > 0) : !at) return setErr(t('settings.taskNeedWhen'))
    const notify = [voice && 'voice', tray && 'tray'].filter(Boolean).join(',')
    const payload = periodic
      ? { text, every: Number(every), from, to, notify }
      : { text, at, notify }
    setBusy(true)
    const r = editing ? await api.updateAiTask?.(task.id, payload) : await api.addAiTask?.(payload)
    setBusy(false)
    if (!r) return setErr(t('settings.taskFailed'))
    if (!editing) setText('')
    onCreated?.()
  }

  return (
    <div className="ai-task-form">
      <textarea
        className="ai-add__input ai-task-form__text"
        rows={2}
        placeholder={t('settings.taskText')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="ai-task-form__row">
        <select className="select" value={periodic ? 'periodic' : 'once'} onChange={(e) => setPeriodic(e.target.value === 'periodic')}>
          <option value="once">{t('settings.taskOnce')}</option>
          <option value="periodic">{t('settings.taskPeriodic')}</option>
        </select>

        {periodic ? (
          <>
            <span className="ai-task-form__lbl">{t('settings.taskEvery')}</span>
            <input
              type="number"
              min="1"
              className="ai-add__input ai-task-form__num"
              value={every}
              onChange={(e) => setEvery(e.target.value)}
            />
            <span className="ai-task-form__lbl">{t('settings.taskMin')}</span>
          </>
        ) : (
          <input
            type="datetime-local"
            className="ai-add__input"
            value={at}
            onChange={(e) => setAt(e.target.value)}
          />
        )}
      </div>

      {periodic && (
        <div className="ai-task-form__row">
          <span className="ai-task-form__lbl">{t('settings.taskWindow')}</span>
          <input type="time" className="ai-add__input ai-task-form__num" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="ai-task-form__lbl">–</span>
          <input type="time" className="ai-add__input ai-task-form__num" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      )}

      <div className="ai-task-form__row">
        <span className="ai-task-form__lbl">{t('settings.taskNotify')}</span>
        <label className="ai-task-form__check">
          <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
          {t('settings.taskVoice')}
        </label>
        <label className="ai-task-form__check">
          <input type="checkbox" checked={tray} onChange={(e) => setTray(e.target.checked)} />
          {t('settings.taskTray')}
        </label>
      </div>

      {err && <div className="ai-list__empty">{err}</div>}

      <div className="ai-task-form__row ai-task-form__row--actions">
        {onCancel && (
          <button className="btn btn--ghost" disabled={busy} onClick={onCancel}>
            {t('settings.taskCancel')}
          </button>
        )}
        <button className="btn btn--primary" disabled={busy} onClick={submit}>
          {editing ? t('settings.taskSave') : t('settings.taskCreate')}
        </button>
      </div>
    </div>
  )
}
