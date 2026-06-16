import { useState } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { useAutosizeTextarea } from '../hooks/useAutosizeTextarea'
import { useAiStatus } from '../hooks/useAiStatus'
import { SendIcon } from './icons'
import './PromptBar.css'

// Chat input. Enter sends, Ctrl+Enter inserts a new line. Sending is handled by
// the parent (useChat); while a reply is pending the send button is disabled.
export default function PromptBar({ onSend, busy }) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const ref = useAutosizeTextarea(text, 8)
  const { state, cli, model } = useAiStatus()
  const statusLabel =
    state === 'ready' ? t('chat.ready') : state === 'offline' ? t('chat.offline') : t('chat.starting')
  const cliLabel = { gemini: 'Gemini', claude: 'Claude', codex: 'Codex' }[cli] || 'Gemini'
  const modelLabel = model && model !== 'default' && model !== 'auto' ? ` · ${model}` : ''

  const canSend = text.trim().length > 0 && !busy

  const submit = () => {
    if (!canSend) return
    onSend(text)
    setText('')
  }

  const insertNewline = () => {
    const el = ref.current
    const start = el.selectionStart
    const end = el.selectionEnd
    setText((prev) => prev.slice(0, start) + '\n' + prev.slice(end))
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 1
    })
  }

  const onKeyDown = (e) => {
    if (e.key !== 'Enter') return
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      insertNewline()
    } else if (!e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="promptbar">
      <div className="promptbar__status" title={statusLabel}>
        <span className={`promptbar__dot promptbar__dot--${state}`} />
        <span className="promptbar__status-text">
          {cliLabel}
          {modelLabel} · {statusLabel}
        </span>
      </div>
      <div className="promptbar__box">
        <textarea
          ref={ref}
          className="promptbar__input"
          rows={1}
          placeholder={t('prompt.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="promptbar__send"
          title={t('prompt.send')}
          onClick={submit}
          disabled={!canSend}
        >
          <SendIcon />
        </button>
      </div>
    </div>
  )
}
