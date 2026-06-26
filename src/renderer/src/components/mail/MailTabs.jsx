import { useEffect, useRef, useState } from 'react'
import { StarIcon, ChevronLeftIcon, ChevronRightIcon } from '../icons'
import { useI18n } from '../../i18n/I18nContext'

// Category tabs above the list. Order (per request): Updates, Primary, Starred,
// Promotions, Social, then "All" (no filter — shows everything). `counts` is
// { tabId: unreadCount } for the badges.
export const MAIL_TABS = [
  { id: 'updates' },
  { id: 'primary' },
  { id: 'starred', star: true },
  { id: 'promotions' },
  { id: 'social' },
  { id: 'all' }
]

export default function MailTabs({ active, counts = {}, onSelect }) {
  const { t } = useI18n()
  const stripRef = useRef(null)
  // when the tabs overflow we show left/right scroll arrows instead of wrapping
  const [arrows, setArrows] = useState({ left: false, right: false })

  const update = () => {
    const el = stripRef.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setArrows((a) => (a.left === left && a.right === right ? a : { left, right }))
  }
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [])

  const scroll = (dir) => stripRef.current?.scrollBy({ left: dir * 160, behavior: 'smooth' })

  return (
    <div className="mail-tabs">
      <button
        className={'mail-tabs__arrow' + (arrows.left ? '' : ' is-hidden')}
        onClick={() => scroll(-1)}
        tabIndex={-1}
      >
        <ChevronLeftIcon />
      </button>

      <div className="mail-tabs__strip" ref={stripRef}>
        {MAIL_TABS.map((tab) => (
          <button
            key={tab.id}
            className={'mail-tabs__tab' + (active === tab.id ? ' mail-tabs__tab--active' : '')}
            onClick={() => onSelect(tab.id)}
          >
            {tab.star && <StarIcon />}
            <span>{t('mail.tab.' + tab.id)}</span>
            {counts[tab.id] > 0 && <span className="mail-tabs__badge">{counts[tab.id]}</span>}
          </button>
        ))}
      </div>

      <button
        className={'mail-tabs__arrow' + (arrows.right ? '' : ' is-hidden')}
        onClick={() => scroll(1)}
        tabIndex={-1}
      >
        <ChevronRightIcon />
      </button>
    </div>
  )
}
