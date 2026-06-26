import { ColumnsIcon } from '../icons'
import { useI18n } from '../../i18n/I18nContext'

// The bar above the tabs: the loaded/total count on the left (the list infinite-scrolls,
// so there are no page buttons), and the reading-pane layout toggle (split beside the list
// ↔ full, list-replacing) on the right. Same height as the left menu's header.
export default function MailListHead({ rangeLabel, paneMode, onTogglePane }) {
  const { t } = useI18n()
  return (
    <div className="mail-list__head">
      <div className="mail-list__pager">
        <span className="mail-list__range">{rangeLabel}</span>
      </div>
      <button
        className={'mail-list__pane' + (paneMode === 'split' ? ' is-on' : '')}
        title={paneMode === 'split' ? t('mail.paneRight') : t('mail.paneFull')}
        onClick={onTogglePane}
      >
        <ColumnsIcon />
      </button>
    </div>
  )
}
