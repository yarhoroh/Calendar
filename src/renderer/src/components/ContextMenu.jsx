import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './ContextMenu.css'

// Small right-click menu. `items` = [{ label, onClick }] or { label, children: [...] } for a
// hover submenu. Positioned at (x, y), clamped to the viewport; closes on outside click /
// another right-click / blur.
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)
  const [sub, setSub] = useState(null) // index of the item whose submenu is open

  useEffect(() => {
    const close = (e) => {
      if (!ref.current?.contains(e.target)) onClose()
    }
    // attach on the NEXT frame so the right-click that opened this menu (still propagating,
    // and about to fire mousedown) doesn't immediately close it again
    const id = requestAnimationFrame(() => {
      document.addEventListener('mousedown', close)
      document.addEventListener('contextmenu', close)
      window.addEventListener('blur', onClose)
    })
    return () => {
      cancelAnimationFrame(id)
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
        <div key={i} className="ctx-menu__row" onMouseEnter={() => setSub(it.children ? i : null)}>
          <button
            className={'ctx-menu__item' + (it.children ? ' ctx-menu__item--sub' : '')}
            // keep focus in the underlying field (an editor open behind a portal
            // would otherwise blur and auto-commit/close)
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (it.children) { setSub(i); return }
              it.onClick()
              onClose()
            }}
          >
            {it.label}
            {it.children && <span className="ctx-menu__arrow">▸</span>}
          </button>
          {it.children && sub === i && (
            <div className="ctx-menu ctx-menu--sub">
              {it.children.map((c, j) => (
                <button
                  key={j}
                  className="ctx-menu__item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { c.onClick(); onClose() }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>,
    document.body
  )
}
