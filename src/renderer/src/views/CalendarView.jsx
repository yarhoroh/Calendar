import { useEffect, useRef, useState } from 'react'
import CalendarBoard from '../components/calendar/CalendarBoard'
import ChatPanel from '../components/ChatPanel'
import PromptBar from '../components/PromptBar'
import { subscribeUi, getUiState } from '../lib/uiBridge'
import './CalendarView.css'

// Two parts: the calendar board (top) and, when enabled, the AI chat (log +
// input) at the bottom. `chat` is owned by App so its history survives view
// switches. When a note is fullscreen, the chat docks on top of it (root class
// `fs-chat`) so it stays visible and usable — the AI is "live" beside the note.
export default function CalendarView({ command, showChat, chat }) {
  const [fullscreen, setFullscreen] = useState(false)
  const chatRef = useRef(null)

  useEffect(() => {
    const apply = (s) => setFullscreen(!!s.fullscreen)
    apply(getUiState())
    return subscribeUi(apply)
  }, [])

  // when a note is fullscreen and the chat is on, dock the chat over the overlay
  // and reserve exactly its real height at the bottom of the note (so an empty/
  // cleared chat takes only the input bar, not a fixed slab of empty space)
  const docked = fullscreen && showChat
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('fs-chat', docked)
    if (!docked) {
      root.style.removeProperty('--fs-chat-h')
      return
    }
    const el = chatRef.current
    const sync = () => root.style.setProperty('--fs-chat-h', `${el?.offsetHeight || 0}px`)
    sync()
    const ro = el ? new ResizeObserver(sync) : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      root.classList.remove('fs-chat')
      root.style.removeProperty('--fs-chat-h')
    }
  }, [docked])

  return (
    <div className="calendar-view">
      <CalendarBoard command={command} />
      {showChat && (
        <div className="calendar-view__chat" ref={chatRef}>
          <ChatPanel messages={chat.messages} busy={chat.busy} onClear={chat.clear} />
          <PromptBar onSend={chat.send} busy={chat.busy} />
        </div>
      )}
    </div>
  )
}
