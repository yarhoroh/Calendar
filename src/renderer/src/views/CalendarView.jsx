import CalendarBoard from '../components/calendar/CalendarBoard'
import PromptBar from '../components/PromptBar'
import './CalendarView.css'

// Two parts: the calendar board (top, scales to fill) and the task prompt
// bar (bottom).
export default function CalendarView({ focusRequest }) {
  return (
    <div className="calendar-view">
      <CalendarBoard focusRequest={focusRequest} />
      <PromptBar />
    </div>
  )
}
