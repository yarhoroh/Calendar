import { StarIcon, ImportantIcon, TrashIcon } from '../icons'
import { monogram } from '../../lib/monogram'
import { useI18n } from '../../i18n/I18nContext'
import MailAttachBadge from './MailAttachBadge'

// wrap every (case-insensitive) occurrence of `q` in <mark> so search matches stand out
function highlight(text, q) {
  if (!q || !text) return text
  const parts = []
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  let i = 0
  let idx
  while ((idx = lower.indexOf(ql, i)) !== -1) {
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(
      <mark className="mail-hl" key={idx}>
        {text.slice(idx, idx + q.length)}
      </mark>
    )
    i = idx + q.length
  }
  if (i < text.length) parts.push(text.slice(i))
  return parts
}

// One message row. `showAccount` adds the source-account column (unified views).
// Presentational — selection/star toggles are handled by the parent.
export default function MailRow({ msg, query, selected, showAccount, showRecipient, onToggleSelect, onToggleStar, onToggleImportant, onDelete, onOpen }) {
  const { t } = useI18n()
  return (
    <div
      className={'mail-row' + (msg.unread ? ' mail-row--unread' : '') + (selected ? ' mail-row--selected' : '')}
      onClick={() => onOpen?.(msg)}
    >
      <label className="mail-row__check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={() => onToggleSelect(msg.id)} />
      </label>

      <button
        className={'mail-row__star' + (msg.starred ? ' is-on' : '')}
        title={t('mail.star')}
        onClick={(e) => {
          e.stopPropagation()
          onToggleStar(msg.id)
        }}
      >
        <StarIcon />
      </button>

      <button
        className={'mail-row__important' + (msg.important ? ' is-on' : '')}
        title={msg.important ? t('mail.important') : t('mail.notImportant')}
        onClick={(e) => {
          e.stopPropagation()
          onToggleImportant?.(msg.id, msg.account, !msg.important)
        }}
      >
        <ImportantIcon filled={msg.important} />
      </button>

      {showAccount && (
        <span className="mail-row__avatar" title={msg.account}>
          {monogram(showRecipient ? msg.to || msg.account : msg.account)}
        </span>
      )}

      {/* in Sent, the meaningful name is the recipient, not me (the sender) */}
      <span className="mail-row__from">{highlight(showRecipient ? msg.to || msg.from : msg.from, query)}</span>
      {msg.count > 1 && <span className="mail-row__count">{msg.count}</span>}

      <span className="mail-row__text">
        <span className="mail-row__subject">{highlight(msg.subject, query)}</span>
        {msg.snippet && <span className="mail-row__snippet"> — {highlight(msg.snippet, query)}</span>}
      </span>

      <MailAttachBadge attachments={msg.attachments} account={msg.account} />

      <button
        className="mail-row__trash"
        title={t('mail.delete')}
        onClick={(e) => {
          e.stopPropagation()
          onDelete?.(msg)
        }}
      >
        <TrashIcon />
      </button>

      <span className="mail-row__date">{msg.date}</span>
    </div>
  )
}
