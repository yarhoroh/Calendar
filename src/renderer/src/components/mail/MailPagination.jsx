import { ChevronLeftIcon, ChevronRightIcon } from '../icons'
import { useI18n } from '../../i18n/I18nContext'

// ALWAYS 7 slots so the pager never changes width (no jumping): first + last are
// fixed, with a sliding window and ellipsis dots in stable positions.
function pageWindow(page, count) {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1)
  if (page <= 4) return [1, 2, 3, 4, 5, '…', count]
  if (page >= count - 3) return [1, '…', count - 4, count - 3, count - 2, count - 1, count]
  return [1, '…', page - 1, page, page + 1, '…', count]
}

// Numbered pagination under the list, derived from the total page count.
export default function MailPagination({ page, pageCount, onPage }) {
  const { t } = useI18n()
  if (pageCount <= 1) return null
  return (
    <div className="mail-pagination">
      <button className="mail-pagination__nav" disabled={page <= 1} onClick={() => onPage(page - 1)} title={t('mail.prev')}>
        <ChevronLeftIcon />
      </button>
      {pageWindow(page, pageCount).map((it, i) =>
        it === '…' ? (
          <span key={'gap' + i} className="mail-pagination__gap">…</span>
        ) : (
          <button
            key={it}
            className={'mail-pagination__pg' + (it === page ? ' is-active' : '')}
            onClick={() => onPage(it)}
          >
            {it}
          </button>
        )
      )}
      <button className="mail-pagination__nav" disabled={page >= pageCount} onClick={() => onPage(page + 1)} title={t('mail.next')}>
        <ChevronRightIcon />
      </button>
    </div>
  )
}
