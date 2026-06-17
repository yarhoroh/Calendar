import { useEffect, useRef, useState } from 'react'
import { subscribeAsk, submitAsk, closeAsk } from '../lib/askBridge'
import { useI18n } from '../i18n/I18nContext'
import './AskPopup.css'

// Popup shown when the assistant asks the user something (the `ask` action).
// The answer is routed back to the AI together with the question. The AI can
// also dismiss it on its own (closeAsk).
export default function AskPopup() {
  const { t } = useI18n()
  const [ask, setAsk] = useState(null)
  const [text, setText] = useState('')
  const inputRef = useRef(null)

  useEffect(() => subscribeAsk(setAsk), [])
  useEffect(() => {
    if (ask) {
      setText('')
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [ask])

  if (!ask) return null

  const send = () => {
    const a = text.trim()
    if (!a) return
    submitAsk(a)
  }

  return (
    <div className="ask-popup">
      <div className="ask-popup__box">
        <button className="ask-popup__close" title={t('items.close')} onClick={() => closeAsk()}>
          ✕
        </button>
        <div className="ask-popup__q">{ask.question}</div>
        <textarea
          ref={inputRef}
          className="ask-popup__input"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape') {
              closeAsk()
            }
          }}
        />
        <div className="ask-popup__actions">
          <button className="btn btn--primary" onClick={send} disabled={!text.trim()}>
            {t('prompt.send')}
          </button>
        </div>
      </div>
    </div>
  )
}
