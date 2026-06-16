import CalendarBoard from '../components/calendar/CalendarBoard'
import ChatPanel from '../components/ChatPanel'
import PromptBar from '../components/PromptBar'
import './CalendarView.css'

// Two parts: the calendar board (top) and, when enabled, the AI chat (log +
// input) at the bottom. `chat` is owned by App so its history survives view
// switches.
export default function CalendarView({ command, showChat, chat }) {
  return (
    <div className="calendar-view">
      <CalendarBoard command={command} />
      {showChat && (
        <>
          <ChatPanel messages={chat.messages} busy={chat.busy} onClear={chat.clear} />
          <PromptBar onSend={chat.send} busy={chat.busy} />
        </>
      )}
    </div>
  )
}
