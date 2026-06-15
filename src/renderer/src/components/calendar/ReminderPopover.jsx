import { useEffect, useRef } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import './ReminderPopover.css'

// Pick a date+time for a reminder. Closes on outside click.
export default function ReminderPopover({ value, onChange, onClear, onClose }) {
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
    <div className="reminder-pop" ref={ref}>
      <input
        className="reminder-pop__input"
        type="datetime-local"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button className="reminder-pop__clear" onClick={onClear}>
          {t('items.clearReminder')}
        </button>
      )}
    </div>
  )
}
