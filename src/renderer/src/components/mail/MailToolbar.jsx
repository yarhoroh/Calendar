import { useEffect, useRef, useState } from 'react'
import { RefreshIcon, SearchIcon } from '../icons'
import { useI18n } from '../../i18n/I18nContext'

// Action bar above the message rows: select-all, refresh, sort, filter, search.
// The search box shrinks with the toolbar and, when there's no room, collapses to
// a loupe button that opens a search field overlaying the whole row.
export default function MailToolbar({
  allChecked,
  someChecked,
  onToggleAll,
  selectedCount,
  onRefresh,
  busy,
  filter,
  onFilter,
  search,
  onSearch
}) {
  const { t } = useI18n()
  const rootRef = useRef(null)
  const [compact, setCompact] = useState(false) // narrow toolbar → search is just a loupe
  const [searchOpen, setSearchOpen] = useState(false) // overlay open in compact mode

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < 520))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="mail-toolbar" ref={rootRef}>
      <label className="mail-toolbar__check" title={t('mail.selectAll')}>
        <input
          type="checkbox"
          checked={allChecked}
          ref={(el) => el && (el.indeterminate = !allChecked && someChecked)}
          onChange={onToggleAll}
        />
      </label>

      <button
        className={'mail-toolbar__btn' + (busy ? ' mail-toolbar__btn--busy' : '')}
        title={t('mail.refresh')}
        onClick={onRefresh}
      >
        <RefreshIcon />
      </button>

      {selectedCount > 0 && <span className="mail-toolbar__count">{selectedCount} {t('mail.selected')}</span>}

      <select className="select mail-toolbar__select" value={filter} onChange={(e) => onFilter(e.target.value)}>
        <option value="all">{t('mail.filter.all')}</option>
        <option value="unread">{t('mail.filter.unread')}</option>
        <option value="attachments">{t('mail.filter.attachments')}</option>
      </select>

      {compact ? (
        <button
          className="mail-toolbar__btn mail-toolbar__search-btn"
          title={t('mail.search')}
          onClick={() => setSearchOpen(true)}
        >
          <SearchIcon />
        </button>
      ) : (
        <div className="mail-toolbar__search">
          <SearchIcon />
          <input type="text" placeholder={t('mail.search')} value={search} onChange={(e) => onSearch(e.target.value)} />
          {search && (
            <button className="mail-toolbar__search-clear" title={t('mail.close')} onClick={() => onSearch('')}>
              ✕
            </button>
          )}
        </div>
      )}

      {searchOpen && (
        <div className="mail-toolbar__search-overlay">
          <SearchIcon />
          <input
            autoFocus
            type="text"
            placeholder={t('mail.search')}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setSearchOpen(false)}
          />
          <button
            className="mail-toolbar__btn"
            title={t('mail.close')}
            onClick={() => {
              onSearch('')
              setSearchOpen(false)
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
