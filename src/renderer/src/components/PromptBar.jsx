import { useState } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { useAutosizeTextarea } from '../hooks/useAutosizeTextarea'
import { SendIcon, StopIcon } from './icons'
import './PromptBar.css'

// Command line for handing tasks to the Claude CLI. The CLI is not wired up
// yet — for now Send just flips into the "running" state and Stop cancels it.
export default function PromptBar() {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  const ref = useAutosizeTextarea(text, 8)

  const canSend = text.trim().length > 0

  const send = () => {
    if (!canSend) return
    setRunning(true)
    // TODO: pass `text` to the Claude CLI and stream the result back
  }

  const stop = () => setRunning(false)

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
      send()
    }
  }

  return (
    <div className="promptbar">
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
        {running ? (
          <button className="promptbar__send promptbar__send--stop" title={t('prompt.stop')} onClick={stop}>
            <StopIcon />
          </button>
        ) : (
          <button className="promptbar__send" title={t('prompt.send')} onClick={send} disabled={!canSend}>
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  )
}
