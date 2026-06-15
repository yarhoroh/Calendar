import { useI18n } from '../i18n/I18nContext'
import { PinIcon } from './icons'

// Pins the window above all others (always-on-top) or releases it.
export default function PinToggle({ pinned, onToggle }) {
  const { t } = useI18n()
  return (
    <button
      className={pinned ? 'winbtn winbtn--active' : 'winbtn'}
      title={pinned ? t('window.unpin') : t('window.pin')}
      onClick={onToggle}
    >
      <PinIcon />
    </button>
  )
}
