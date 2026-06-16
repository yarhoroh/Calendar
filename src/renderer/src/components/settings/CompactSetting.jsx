import { useI18n } from '../../i18n/I18nContext'

// Mini / compact mode — four independent toggles, one per UI area, laid out in a
// single row to save space. State + the root `cmp-*` classes are owned by App.
const AREAS = [
  ['topbar', 'compactTopbar'],
  ['menu', 'compactMenu'],
  ['calendar', 'compactCalendar'],
  ['chat', 'compactChat']
]

export default function CompactSetting({ compact = {}, onToggle }) {
  const { t } = useI18n()
  return (
    <div className="compact-row">
      <span className="compact-row__label">{t('settings.compactMode')}</span>
      {AREAS.map(([key, label]) => (
        <label key={key} className="compact-row__item">
          <input type="checkbox" checked={!!compact[key]} onChange={() => onToggle(key)} />
          <span>{t(`settings.${label}`)}</span>
        </label>
      ))}
    </div>
  )
}
