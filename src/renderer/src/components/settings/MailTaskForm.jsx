import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import './AiTaskForm.css'

// Create OR edit a MAIL watcher task: "watch this mailbox every N minutes and, when
// new mail arrives, tell me if it matches this instruction." The watcher fetches only
// NEW mail (UID high-water mark) and pinches the AI with the prompt + the new messages.
export default function MailTaskForm({ task, onCreated, onCancel }) {
  const { t } = useI18n()
  const editing = !!task
  const [accounts, setAccounts] = useState([])
  const [account, setAccount] = useState(task?.account || 'all')
  const [folder, setFolder] = useState(task?.folder || 'INBOX')
  const [every, setEvery] = useState(task?.every || 10)
  const [from, setFrom] = useState(task?.winfrom || '')
  const [to, setTo] = useState(task?.winto || '')
  const [prompt, setPrompt] = useState(task?.prompt || '')
  const [enabled, setEnabled] = useState(task ? task.enabled !== 0 : true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.resolve(api.mail?.listAccounts?.()).then((r) => setAccounts(r || []))
  }, [])

  const submit = async () => {
    setErr('')
    if (!prompt.trim()) return setErr(t('settings.mailTaskNeedPrompt'))
    if (!(Number(every) > 0)) return setErr(t('settings.mailTaskNeedEvery'))
    const payload = { account, folder: folder.trim() || 'INBOX', every: Number(every), from, to, prompt, enabled }
    setBusy(true)
    const r = editing ? await api.updateMailTask?.(task.id, payload) : await api.addMailTask?.(payload)
    setBusy(false)
    if (!r) return setErr(t('settings.taskFailed'))
    if (!editing) setPrompt('')
    onCreated?.()
  }

  return (
    <div className="ai-task-form">
      <textarea
        className="ai-add__input ai-task-form__text"
        rows={2}
        placeholder={t('settings.mailTaskPrompt')}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />

      <div className="ai-task-form__row">
        <select className="select" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="all">{t('settings.mailTaskAllAccounts')}</option>
          {accounts.map((a) => (
            <option key={a.email} value={a.email}>{a.email}</option>
          ))}
        </select>
        <input
          className="ai-add__input ai-task-form__num"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="INBOX"
          title={t('settings.mailTaskFolder')}
        />
      </div>

      <div className="ai-task-form__row">
        <span className="ai-task-form__lbl">{t('settings.taskEvery')}</span>
        <input
          type="number"
          min="1"
          className="ai-add__input ai-task-form__num"
          value={every}
          onChange={(e) => setEvery(e.target.value)}
        />
        <span className="ai-task-form__lbl">{t('settings.taskMin')}</span>
      </div>

      <div className="ai-task-form__row">
        <span className="ai-task-form__lbl">{t('settings.taskWindow')}</span>
        <input type="time" className="ai-add__input ai-task-form__num" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="ai-task-form__lbl">–</span>
        <input type="time" className="ai-add__input ai-task-form__num" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      <div className="ai-task-form__row">
        <label className="ai-task-form__check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('settings.mailTaskEnabled')}
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
