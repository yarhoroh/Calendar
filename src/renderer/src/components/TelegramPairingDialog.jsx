import { useI18n } from '../i18n/I18nContext'
import './CloseDialog.css'

// Shown when an unrecognized Telegram chat messages the bot for the first time
// (or after re-pairing a new bot token): nothing reaches the AI until the user
// approves it here — reject just drops the held message.
export default function TelegramPairingDialog({ request, onApprove, onReject }) {
  const { t } = useI18n()

  return (
    <div className="overlay" onClick={onReject}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog__title">{t('telegramPairing.title')}</h2>
        <p className="dialog__text">
          {t('telegramPairing.from')}: {request.from || request.chatId}
        </p>
        {request.text && <p className="dialog__text">"{request.text}"</p>}

        <div className="dialog__actions">
          <button className="btn btn--ghost" onClick={onReject}>
            {t('telegramPairing.reject')}
          </button>
          <button className="btn btn--primary" onClick={onApprove}>
            {t('telegramPairing.approve')}
          </button>
        </div>
      </div>
    </div>
  )
}
