import { useI18n } from '../i18n/I18nContext'
import { CalendarIcon, SettingsIcon } from './icons'

// Switches between the Calendar and Settings views. Shows the icon of the
// view you'd switch *to*.
export default function ViewSwitch({ view, onToggle }) {
  const { t } = useI18n()
  const toSettings = view === 'calendar'
  return (
    <button className="winbtn" title={toSettings ? t('nav.settings') : t('nav.calendar')} onClick={onToggle}>
      {toSettings ? <SettingsIcon /> : <CalendarIcon />}
    </button>
  )
}
