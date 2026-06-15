import { useI18n } from '../../i18n/I18nContext'
import { LANGUAGES } from '../../i18n/translations'
import SettingRow from './SettingRow'

export default function LanguageSetting() {
  const { lang, setLang, t } = useI18n()

  return (
    <SettingRow title={t('settings.language')}>
      <div className="lang-switch">
        {LANGUAGES.map((l) => (
          <button
            key={l.code}
            className={'lang-switch__btn' + (lang === l.code ? ' lang-switch__btn--active' : '')}
            onClick={() => setLang(l.code)}
          >
            {l.label}
          </button>
        ))}
      </div>
    </SettingRow>
  )
}
