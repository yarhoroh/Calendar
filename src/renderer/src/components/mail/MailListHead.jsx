import { ChevronLeftIcon, ChevronRightIcon, ColumnsIcon } from '../icons'
import { useI18n } from '../../i18n/I18nContext'

// The bar above the tabs: page range + prev/next on the left, and the reading-
// pane layout toggle (split beside the list ↔ full, list-replacing) on the right.
// Same height as the left menu's header so the top line is continuous.
export default function MailListHead({ rangeLabel, onPrev, onNext, paneMode, onTogglePane }) {
  const { t } = useI18n()
  return (
    <div className="mail-list__head">
      <div className="mail-list__pager">
        <span className="mail-list__range">{rangeLabel}</span>
        <button className="mail-list__pgbtn" title={t('mail.newer')} onClick={onPrev}>
          <ChevronLeftIcon />
        </button>
        <button className="mail-list__pgbtn" title={t('mail.older')} onClick={onNext}>
          <ChevronRightIcon />
        </button>
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
