import { useEffect, useRef, useState } from 'react'
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
import { registerUi, updateUiState } from './lib/uiBridge'
import { setAnswerHandler, subscribeAsk } from './lib/askBridge'
import AskPopup from './components/AskPopup'
import './styles/compact.css'

// Composition root: holds the active view and wires the titlebar, the current
// view and the close dialog. Reminder toasts live in a separate window; here we
// only listen for "open this day" requests coming from a clicked toast.
export default function App() {
  const [view, setView] = useState('calendar')
  const [command, setCommand] = useState(null)
  const [showChat, setShowChat] = useState(false)
  const [compact, setCompact] = useState({})
  const { theme, toggleTheme, applyTheme } = useTheme()
  const win = useWindowControls()
  useTtsPlayer()

  // let the AI read & flip the app-level settings it owns (theme, chat panel) in
  // real time; calendar settings are handled in CalendarBoard
  const setShowChatValue = (next) => {
    setShowChat(!!next)
    api.setShowChat?.(!!next)
  }
  const ctrlRef = useRef({})
  ctrlRef.current = { applyTheme, setShowChatValue, theme, showChat }
  useEffect(() => {
    updateUiState({ theme, showChat })
  }, [theme, showChat])
  useEffect(
    () =>
      registerUi((name, arg) => {
        if (name !== 'setSetting') return undefined
        const { applyTheme, setShowChatValue } = ctrlRef.current
        const { key, value } = arg || {}
        if (key === 'theme') return value === 'dark' || value === 'light' ? (applyTheme(value), true) : undefined
        if (key === 'showChat') return (setShowChatValue(value), true)
        return undefined
      }),
    []
  )

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

  // assistant "ask the user" popups: route the answer back to the AI together
  // with its own question, and publish whether a question is pending
  const chatRef = useRef(chat)
  chatRef.current = chat
  useEffect(() => {
    setAnswerHandler((q, a) => chatRef.current.send(`[Это мой ответ на твой вопрос «${q}»] ${a}`))
    return subscribeAsk((p) => updateUiState({ ask: p ? { open: true, question: p.question } : { open: false } }))
  }, [])

  useEffect(() => {
    api.onReminderOpen?.((dayKey) => runCommand({ kind: 'goto', date: dayKey }))
    Promise.resolve(api.getShowChat?.()).then((v) => setShowChat(!!v))
    Promise.resolve(api.getCalendar?.()).then((c) => {
      const cm = c?.compact
      // object = per-area flags; legacy boolean = all areas on
      if (cm && typeof cm === 'object') setCompact(cm)
      else if (cm) setCompact({ topbar: true, menu: true, calendar: true, chat: true })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // compact / mini mode: per-area density for small monitors. Each area gets its
  // own root class so it covers the whole app and survives view switches; stored
  // as an object with the calendar settings.
  useEffect(() => {
    const r = document.documentElement
    r.classList.toggle('cmp-topbar', !!compact.topbar)
    r.classList.toggle('cmp-menu', !!compact.menu)
    r.classList.toggle('cmp-calendar', !!compact.calendar)
    r.classList.toggle('cmp-chat', !!compact.chat)
  }, [compact])
  const toggleCompact = (key) =>
    setCompact((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      api.setCalendar?.({ compact: next })
      return next
    })

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
          <SettingsView
            showChat={showChat}
            onToggleChat={toggleChat}
            compact={compact}
            onToggleCompact={toggleCompact}
          />
        )}
        </ErrorBoundary>
      </main>

      {win.confirmClose && (
        <CloseDialog onTray={win.hideToTray} onQuit={win.quit} onCancel={win.cancelClose} />
      )}

      <AskPopup />
    </div>
  )
}
