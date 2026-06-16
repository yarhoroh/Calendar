import { useEffect } from 'react'
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
  useEffect(() => {
    const apply = (s) => document.documentElement.classList.toggle('fs-chat', !!s.fullscreen && showChat)
    apply(getUiState())
    const off = subscribeUi(apply)
    return () => {
      off()
      document.documentElement.classList.remove('fs-chat')
    }
  }, [showChat])

  return (
    <div className="calendar-view">
      <CalendarBoard command={command} />
      {showChat && (
        <div className="calendar-view__chat">
          <ChatPanel messages={chat.messages} busy={chat.busy} onClear={chat.clear} />
          <PromptBar onSend={chat.send} busy={chat.busy} />
        </div>
      )}
    </div>
  )
}
