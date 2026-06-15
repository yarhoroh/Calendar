import { useEffect, useRef } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { STATUSES } from '../../hooks/useDayItems'
import './StatusMenu.css'

// Small dropdown to choose an item status. Closes on outside click.
export default function StatusMenu({ current, onPick, onClose }) {
  const { t } = useI18n()
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
      {STATUSES.map((s) => (
        <button
          key={s}
          className={'status-menu__item' + (s === current ? ' status-menu__item--active' : '')}
          onClick={() => onPick(s)}
        >
          <span className={`status-mini status-mini--${s}`} />
          {t(`items.status.${s}`)}
        </button>
      ))}
    </div>
  )
}
