import { useEffect, useRef, useState } from 'react'
import api from './lib/api'
import TitleBar from './components/TitleBar'
import CloseDialog from './components/CloseDialog'
import ErrorBoundary from './components/ErrorBoundary'
import CalendarView from './views/CalendarView'
import AppointmentsView from './views/AppointmentsView'
import MailView from './views/MailView'
import PdfView from './views/PdfView'
import SettingsView from './views/SettingsView'
import ArticleReader from './components/mail/ArticleReader'
import MailWebView from './components/mail/MailWebView'
import { useTheme } from './hooks/useTheme'
import { useWindowControls } from './hooks/useWindowControls'
import { useTtsPlayer } from './hooks/useTtsPlayer'
import { useAiTaskRunner } from './hooks/useAiTaskRunner'
import { useMailTaskRunner } from './hooks/useMailTaskRunner'
import { useTelegramBridge } from './hooks/useTelegramBridge'
import { useChat } from './hooks/useChat'
import ChatPanel from './components/ChatPanel'
import PromptBar from './components/PromptBar'
import { registerUi, updateUiState, subscribeUi, getUiState, ui } from './lib/uiBridge'
import { runGoogleAutoSync } from './lib/autoSyncGoogle'
import { setAnswerHandler, subscribeAsk } from './lib/askBridge'
import AskPopup from './components/AskPopup'
import './styles/compact.css'

// Composition root: holds the active view and wires the titlebar, the current
// view and the close dialog. Reminder toasts live in a separate window; here we
// only listen for "open this day" requests coming from a clicked toast.
export default function App() {
  // restore the last-open tab across restarts (calendar / appointments / mail / settings)
  const [view, setView] = useState(() => {
    const saved = localStorage.getItem('view')
    return ['calendar', 'appointments', 'mail', 'pdf', 'settings'].includes(saved) ? saved : 'calendar'
  })
  const [command, setCommand] = useState(null)
  const [reader, setReader] = useState(null) // AI showReader: { title, text, lang, speak }
  const [browseUrl, setBrowseUrl] = useState(null) // AI openUrl: a page shown in the internal browser
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
  // publish the active tab so the AI knows the user is on mail/settings/etc (not just the
  // calendar board). The mail list owns `openMail` (the message being read); we only read
  // it for the AI when the user is actually on the mail tab.
  useEffect(() => {
    updateUiState({ view })
  }, [view])
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
    // web/reader commands open their own overlay — they must NOT yank the user to calendar
    if (cmd.kind === 'showReader') return setReader({ title: cmd.title, text: cmd.text, lang: cmd.lang, speak: cmd.speak })
    if (cmd.kind === 'openUrl') return setBrowseUrl(cmd.url)
    if (cmd.kind === 'composeMail') {
      // show mail and open (or, if already open, edit) the composer with the AI's prefill
      setView('mail')
      localStorage.setItem('view', 'mail')
      ui('composeMail', { from: cmd.from, to: cmd.to, cc: cmd.cc, subject: cmd.subject, html: cmd.html })
      return
    }
    setView('calendar')
    setCommand({ ...cmd, n: Date.now() })
  }

  // tell the AI when the internal browser is open (and where) so it knows the user is in it
  useEffect(() => {
    updateUiState({ browserOpen: !!browseUrl, browserUrl: browseUrl || null })
  }, [browseUrl])

  // chat lives here (not in CalendarView) so its history survives switching to
  // Settings and back — it only clears when the user clears it
  const chat = useChat({ onCommand: runCommand })

  useAiTaskRunner({ onCommand: runCommand })
  useMailTaskRunner({ onCommand: runCommand })
  useTelegramBridge({ onCommand: runCommand })

  // Google → local auto-sync: driven by the main-process timer tick (interval is
  // set in Settings; 0 = off). Also sync once at startup, but only if enabled.
  useEffect(() => {
    Promise.resolve(api.google?.getSyncInterval?.()).then((m) => {
      if (Number(m) > 0) runGoogleAutoSync()
    })
    return api.google?.onAutoSync?.(() => runGoogleAutoSync())
  }, [])

  // assistant "ask the user" popups: route the answer back to the AI together
  // with its own question, and publish whether a question is pending
  const chatRef = useRef(chat)
  chatRef.current = chat
  useEffect(() => {
    setAnswerHandler((q, a) => chatRef.current.send(`[Это мой ответ на твой вопрос «${q}»] ${a}`))
    return subscribeAsk((p) => updateUiState({ ask: p ? { open: true, question: p.question } : { open: false } }))
  }, [])

  // when a note is fullscreen (calendar view) + chat is on, dock the shared chat
  // over the overlay and reserve its real height (--fs-chat-h)
  const [fullscreen, setFullscreen] = useState(false)
  const chatElRef = useRef(null)
  useEffect(() => {
    const apply = (s) => setFullscreen(!!s.fullscreen)
    apply(getUiState())
    return subscribeUi(apply)
  }, [])
  const dockChat = fullscreen && showChat && view === 'calendar'
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('fs-chat', dockChat)
    if (!dockChat) {
      root.style.removeProperty('--fs-chat-h')
      return
    }
    const el = chatElRef.current
    const sync = () => root.style.setProperty('--fs-chat-h', `${el?.offsetHeight || 0}px`)
    sync()
    const ro = el ? new ResizeObserver(sync) : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      root.classList.remove('fs-chat')
      root.style.removeProperty('--fs-chat-h')
    }
  }, [dockChat])

  useEffect(() => {
    const off = api.onReminderOpen?.((dayKey) => runCommand({ kind: 'goto', date: dayKey }))
    Promise.resolve(api.getShowChat?.()).then((v) => setShowChat(!!v))
    Promise.resolve(api.getCalendar?.()).then((c) => {
      const cm = c?.compact
      // object = per-area flags; legacy boolean = all areas on
      if (cm && typeof cm === 'object') setCompact(cm)
      else if (cm) setCompact({ topbar: true, menu: true, calendar: true, chat: true })
    })
    return () => off?.()
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

  const selectView = (name) => {
    setView(name)
    localStorage.setItem('view', name) // reopen on this tab next launch
  }

  return (
    <div className="app">
      <TitleBar
        view={view}
        onSelectView={selectView}
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
          {/* calendar + appointments + mail stay mounted (hidden when inactive — INCLUDING
              while Settings is open) so their scroll position, selection and in-app
              browser survive switching views; Settings just overlays on top */}
          <div className="views" style={{ display: view === 'settings' ? 'none' : undefined }}>
            <div className="view-pane" style={{ display: view === 'calendar' ? undefined : 'none' }}>
              <CalendarView command={command} />
            </div>
            <div className="view-pane" style={{ display: view === 'appointments' ? undefined : 'none' }}>
              <AppointmentsView
                onJump={(day) => runCommand(day === 'everyday' ? { kind: 'everyday' } : { kind: 'goto', date: day })}
              />
            </div>
            <div className="view-pane" style={{ display: view === 'mail' ? undefined : 'none' }}>
              <MailView active={view === 'mail'} onOpenSettings={() => selectView('settings')} />
            </div>
            <div className="view-pane" style={{ display: view === 'pdf' ? undefined : 'none' }}>
              <PdfView />
            </div>
          </div>
          {/* one shared chat under the views (the AI can read/import Google) */}
          {showChat && view !== 'settings' && (
            <div className="app-chat" ref={chatElRef}>
              <ChatPanel messages={chat.messages} busy={chat.busy} onClear={chat.clear} />
              <PromptBar onSend={chat.send} busy={chat.busy} />
            </div>
          )}
          {view === 'settings' && (
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

      {/* AI-opened overlays — the reader (showReader) and the internal browser (openUrl) */}
      {reader && <ArticleReader title={reader.title} text={reader.text} lang={reader.lang} speak={reader.speak} onClose={() => setReader(null)} />}
      {browseUrl && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex' }}>
          <MailWebView url={browseUrl} onClose={() => setBrowseUrl(null)} />
        </div>
      )}
    </div>
  )
}
