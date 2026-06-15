import { useI18n } from '../i18n/I18nContext'
import { MoonIcon, SunIcon } from './icons'

// Toggles light/dark. Shows the icon of the theme you'd switch *to*.
export default function ThemeToggle({ theme, onToggle }) {
  const { t } = useI18n()
  const dark = theme === 'dark'
  return (
    <button className="winbtn" title={dark ? t('window.themeLight') : t('window.themeDark')} onClick={onToggle}>
      {dark ? <MoonIcon /> : <SunIcon />}
    </button>
  )
}
