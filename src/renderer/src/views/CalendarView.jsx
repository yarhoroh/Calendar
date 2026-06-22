import CalendarBoard from '../components/calendar/CalendarBoard'
import './CalendarView.css'

// The calendar board. The AI chat now lives at the App level (shared across the
// calendar and appointments views), so this just hosts the board.
export default function CalendarView({ command }) {
  return (
    <div className="calendar-view">
      <CalendarBoard command={command} />
    </div>
  )
}
