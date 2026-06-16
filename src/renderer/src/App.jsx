import { useEffect, useState } from 'react'
import api from './lib/api'
import TitleBar from './components/TitleBar'
import CloseDialog from './components/CloseDialog'
import ErrorBoundary from './components/ErrorBoundary'
import CalendarView from './views/CalendarView'
import SettingsView from './views/SettingsView'
import { useTheme } from './hooks/useTheme'
import { useWindowControls } from './hooks/useWindowControls'
import { useTtsPlayer } from './hooks/useTtsPlayer'
import { useAiTaskRunner } from './hooks/useAiTaskRunner'
import { useTelegramBridge } from './hooks/useTelegramBridge'
import { useChat } from './hooks/useChat'

// Composition root: holds the active view and wires the titlebar, the current
// view and the close dialog. Reminder toasts live in a separate window; here we
// only listen for "open this day" requests coming from a clicked toast.
export default function App() {
  const [view, setView] = useState('calendar')
  const [command, setCommand] = useState(null)
  const [showChat, setShowChat] = useState(false)
  const { theme, toggleTheme } = useTheme()
  const win = useWindowControls()
  useTtsPlayer()

  // calendar/UI commands from reminders or the AI chat
  const runCommand = (cmd) => {
    setView('calendar')
    setCommand({ ...cmd, n: Date.now() })
  }

  // chat lives here (not in CalendarView) so its history survives switching to
  // Settings and back — it only clears when the user clears it
  const chat = useChat({ onCommand: runCommand })

  useAiTaskRunner({ onCommand: runCommand })
  useTelegramBridge({ onCommand: runCommand })

  useEffect(() => {
    api.onReminderOpen?.((dayKey) => runCommand({ kind: 'goto', date: dayKey }))
    Promise.resolve(api.getShowChat?.()).then((v) => setShowChat(!!v))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Block the browser's default file-drop (which would navigate the window to
  // the file). Notes handle their own drop to attach; everywhere else is a no-op.
  useEffect(() => {
    const prevent = (e) => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  const toggleChat = () =>
    setShowChat((v) => {
      const next = !v
      api.setShowChat?.(next)
      return next
    })

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
          {view === 'calendar' ? (
          <CalendarView command={command} showChat={showChat} chat={chat} />
        ) : (
          <SettingsView showChat={showChat} onToggleChat={toggleChat} />
        )}
        </ErrorBoundary>
      </main>

      {win.confirmClose && (
        <CloseDialog onTray={win.hideToTray} onQuit={win.quit} onCancel={win.cancelClose} />
      )}
    </div>
  )
}
