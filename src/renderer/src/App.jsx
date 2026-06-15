import { useEffect, useState } from 'react'
import api from './lib/api'
import TitleBar from './components/TitleBar'
import CloseDialog from './components/CloseDialog'
import ErrorBoundary from './components/ErrorBoundary'
import CalendarView from './views/CalendarView'
import SettingsView from './views/SettingsView'
import { useTheme } from './hooks/useTheme'
import { useWindowControls } from './hooks/useWindowControls'

// Composition root: holds the active view and wires the titlebar, the current
// view and the close dialog. Reminder toasts live in a separate window; here we
// only listen for "open this day" requests coming from a clicked toast.
export default function App() {
  const [view, setView] = useState('calendar')
  const [focusRequest, setFocusRequest] = useState(null)
  const { theme, toggleTheme } = useTheme()
  const win = useWindowControls()

  useEffect(() => {
    api.onReminderOpen?.((dayKey) => {
      setView('calendar')
      setFocusRequest({ key: dayKey, n: Date.now() })
    })
  }, [])

  const toggleView = () => setView((v) => (v === 'calendar' ? 'settings' : 'calendar'))

  return (
    <div className="app">
      <TitleBar
        view={view}
        onToggleView={toggleView}
        theme={theme}
        onToggleTheme={toggleTheme}
        pinned={win.pinned}
        onTogglePin={win.togglePin}
        maximized={win.maximized}
        onMinimize={win.minimize}
        onToggleMaximize={win.toggleMaximize}
        onClose={win.close}
      />

      <main className="content">
        <ErrorBoundary>
          {view === 'calendar' ? <CalendarView focusRequest={focusRequest} /> : <SettingsView />}
        </ErrorBoundary>
      </main>

      {win.confirmClose && (
        <CloseDialog onTray={win.hideToTray} onQuit={win.quit} onCancel={win.cancelClose} />
      )}
    </div>
  )
}
