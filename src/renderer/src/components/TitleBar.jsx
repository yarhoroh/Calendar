import { useEffect, useState } from 'react'
import api from '../lib/api'
import PinToggle from './PinToggle'
import ViewSwitch from './ViewSwitch'
import ThemeToggle from './ThemeToggle'
import WindowControls from './WindowControls'
import './TitleBar.css'

// Custom (frameless) title bar: brand on the left, app + window controls on
// the right. It only wires children to handlers — no logic of its own.
export default function TitleBar({
  view,
  onSelectView,
  theme,
  onToggleTheme,
  pinned,
  onTogglePin,
  maximized,
  onMinimize,
  onToggleMaximize,
  onClose
}) {
  const [version, setVersion] = useState('')
  useEffect(() => {
    Promise.resolve(api.getVersion?.()).then((v) => v && setVersion(v))
  }, [])

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <span className="titlebar__logo">📅</span>
        <span className="titlebar__name">Calendar</span>
        {version && <span className="titlebar__version">v{version}</span>}
      </div>

      <div className="titlebar__controls">
        {import.meta.env.DEV && (
          <button className="titlebar__dev" title="DevTools" onClick={() => api.openDevTools?.()}>
            {'</>'}
          </button>
        )}
        <PinToggle pinned={pinned} onToggle={onTogglePin} />
        <ViewSwitch view={view} onSelectView={onSelectView} />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <WindowControls
          maximized={maximized}
          onMinimize={onMinimize}
          onToggleMaximize={onToggleMaximize}
          onClose={onClose}
        />
      </div>
    </header>
  )
}
