import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import './ContextMenu.css'

// Small right-click menu. `items` = [{ label, onClick }]. Positioned at (x, y),
// clamped to the viewport; closes on outside click / another right-click / blur.
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    const close = (e) => {
      if (!ref.current?.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('contextmenu', close)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('contextmenu', close)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const left = Math.min(x, window.innerWidth - 170)
  const top = Math.min(y, window.innerHeight - 12 - items.length * 34)

  return createPortal(
    <div className="ctx-menu" ref={ref} style={{ top: Math.max(8, top), left: Math.max(8, left) }}>
      {items.map((it, i) => (
        <button
          key={i}
          className="ctx-menu__item"
          // keep focus in the underlying field (an editor open behind a portal
          // would otherwise blur and auto-commit/close)
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            it.onClick()
            onClose()
          }}
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
