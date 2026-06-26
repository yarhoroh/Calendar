import { useI18n } from '../i18n/I18nContext'
import { CalendarIcon, AppointmentsIcon, MailIcon, SettingsIcon } from './icons'

// Switches between the top-level views. Highlights the active one.
const VIEWS = [
  ['calendar', CalendarIcon, 'nav.calendar'],
  ['appointments', AppointmentsIcon, 'nav.appointments'],
  ['mail', MailIcon, 'nav.mail'],
  ['settings', SettingsIcon, 'nav.settings']
]

export default function ViewSwitch({ view, onSelectView }) {
  const { t } = useI18n()
  return (
    <>
      {VIEWS.map(([name, Icon, label]) => (
        <button
          key={name}
          className={'winbtn' + (view === name ? ' winbtn--active' : '')}
          title={t(label)}
          onClick={() => onSelectView(name)}
        >
          <Icon />
        </button>
      ))}
    </>
  )
}
