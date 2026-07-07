import { useI18n } from '../../i18n/I18nContext'
import SettingRow from './SettingRow'

// Visual skin picker (classic | apple). A skin is separate from the light/dark theme — it changes
// the design language and layers on top of whichever theme is active. State lives in App (useSkin);
// this is just the control.
const OPTIONS = [
  { v: 'classic', key: 'classic' },
  { v: 'apple', key: 'apple' }
]

export default function SkinSetting({ skin, onApply }) {
  const { t } = useI18n()
  return (
    <SettingRow title={t('settings.skin.title')} description={t('settings.skin.desc')}>
      <div className="lang-switch">
        {OPTIONS.map((o) => (
          <button
            key={o.v}
            className={'lang-switch__btn' + ((skin || 'classic') === o.v ? ' lang-switch__btn--active' : '')}
            onClick={() => onApply?.(o.v)}
          >
            {t('settings.skin.' + o.key)}
          </button>
        ))}
      </div>
    </SettingRow>
  )
}
