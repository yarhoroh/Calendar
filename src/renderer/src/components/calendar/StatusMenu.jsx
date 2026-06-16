import { useEffect, useRef } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { BUILTIN_STATUSES, useCustomStatuses } from '../../lib/statuses'
import './StatusMenu.css'

// Small dropdown to choose an item status — built-in ones plus any custom
// statuses the user defined in Settings. Closes on outside click.
export default function StatusMenu({ current, onPick, onClose }) {
  const { t } = useI18n()
  const custom = useCustomStatuses()
  const ref = useRef(null)

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  return (
    <div className="status-menu" ref={ref}>
      {BUILTIN_STATUSES.map((s) => (
        <button
          key={s}
          className={'status-menu__item' + (s === current ? ' status-menu__item--active' : '')}
          onClick={() => onPick(s)}
        >
          <span className={`status-mini status-mini--${s}`} />
          {t(`items.status.${s}`)}
        </button>
      ))}
      {custom.map((c) => (
        <button
          key={c.id}
          className={'status-menu__item' + (c.id === current ? ' status-menu__item--active' : '')}
          onClick={() => onPick(c.id)}
        >
          <span className="status-mini status-mini--custom" style={{ '--sc': c.color }} />
          {c.name}
        </button>
      ))}
    </div>
  )
}
