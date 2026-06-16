import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { ChevronLeftIcon, ChevronRightIcon, PinIcon } from './icons'
import './SidePanel.css'

const MIN_W = 160
const MAX_W = 480
const clamp = (v, a, b) => Math.min(Math.max(v, a), b)

// Collapsible / pinnable / resizable left panel. Controlled by the parent:
// `state` = { open, pinned, width }, `onChange` persists a patch. Pinned pushes
// the content (in layout flow); unpinned floats over it (position: absolute).
// Body is empty for now — a menu will live here later.
export default function SidePanel({ state, onChange, children }) {
  const { t } = useI18n()
  const { open, pinned, width } = state
  const [w, setW] = useState(width)

  // follow the persisted width (e.g. when switching tabs), except mid-drag
  useEffect(() => setW(width), [width])

  // drag the right edge to resize; persist once on release (not every move)
  const startResize = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = w
    let latest = startW
    const onMove = (ev) => {
      latest = clamp(startW + (ev.clientX - startX), MIN_W, MAX_W)
      setW(latest)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      onChange({ width: latest })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!open) {
    return (
      <button
        className={`side-panel__open side-panel__open--${pinned ? 'rail' : 'float'}`}
        title={t('panel.open')}
        onClick={() => onChange({ open: true })}
      >
        <ChevronRightIcon />
      </button>
    )
  }

  return (
    <aside className={`side-panel side-panel--${pinned ? 'pinned' : 'float'}`} style={{ width: w }}>
      <div className="side-panel__head">
        <button
          className={`side-panel__btn${pinned ? ' side-panel__btn--on' : ''}`}
          title={t('panel.pin')}
          onClick={() => onChange({ pinned: !pinned })}
        >
          <PinIcon />
        </button>
        <button className="side-panel__btn" title={t('panel.collapse')} onClick={() => onChange({ open: false })}>
          <ChevronLeftIcon />
        </button>
      </div>
      <div className="side-panel__body">{children}</div>
      <div className="side-panel__resize" onMouseDown={startResize} title={t('panel.resize')} />
    </aside>
  )
}
