import { useState } from 'react'
import { useI18n } from '../i18n/I18nContext'
import './CloseDialog.css'

// Asked when the user closes the window: minimize to tray or really quit,
// with an option to remember the choice.
export default function CloseDialog({ onTray, onQuit, onCancel }) {
  const { t } = useI18n()
  const [remember, setRemember] = useState(false)

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog__title">{t('close.title')}</h2>
        <p className="dialog__text">{t('close.text')}</p>

        <label className="dialog__remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          {t('close.remember')}
        </label>

        <div className="dialog__actions">
          <button className="btn btn--ghost" onClick={onCancel}>
            {t('close.cancel')}
          </button>
          <button className="btn btn--danger" onClick={() => onQuit(remember)}>
            {t('close.quit')}
          </button>
          <button className="btn btn--primary" onClick={() => onTray(remember)}>
            {t('close.tray')}
          </button>
        </div>
      </div>
    </div>
  )
}
