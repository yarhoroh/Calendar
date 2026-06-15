import { useI18n } from '../i18n/I18nContext'
import { MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon } from './icons'

// Standard minimize / maximize-restore / close cluster.
export default function WindowControls({ maximized, onMinimize, onToggleMaximize, onClose }) {
  const { t } = useI18n()
  return (
    <>
      <button className="winbtn" title={t('window.minimize')} onClick={onMinimize}>
        <MinimizeIcon />
      </button>
      <button
        className="winbtn"
        title={maximized ? t('window.restore') : t('window.maximize')}
        onClick={onToggleMaximize}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button className="winbtn winbtn--close" title={t('window.close')} onClick={onClose}>
        <CloseIcon />
      </button>
    </>
  )
}
