import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n/I18nContext'
import './ChatPanel.css'

// Conversation log above the prompt bar. Messages stack; the user can clear the
// context. Shown only when there's something to show.
export default function ChatPanel({ messages, busy, onClear }) {
  const { t } = useI18n()
  const listRef = useRef(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  if (!messages.length && !busy) return null

  return (
    <div className="chat">
      <div className="chat__head">
        <span className="chat__title">AI</span>
        <button className="chat__clear" onClick={onClear}>
          {t('chat.clear')}
        </button>
      </div>
      <div className="chat__list" ref={listRef}>
        {messages.map((m, i) => (
          <div key={i} className={`chat__msg chat__msg--${m.role}`}>
            {m.images?.length > 0 && (
              <div className="chat__imgs">
                {m.images.map((im, j) => (
                  <img key={j} className="chat__img" src={`data:${im.media_type};base64,${im.data}`} alt="" />
                ))}
              </div>
            )}
            {m.content}
          </div>
        ))}
        {busy && <div className="chat__msg chat__msg--assistant chat__typing">…</div>}
      </div>
    </div>
  )
}
