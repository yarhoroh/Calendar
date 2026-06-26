import { useState } from 'react'
import { PaperclipIcon } from '../icons'
import MailAttachChip from './MailAttachChip'

// Attachment count badge in a list row; clicking opens a small dropdown of the
// files. Each file downloads + opens in the OS default app on click.
export default function MailAttachBadge({ attachments, account }) {
  const [open, setOpen] = useState(false)
  if (!attachments?.length) return null
  return (
    <span className="mail-attach" onClick={(e) => e.stopPropagation()}>
      <button className="mail-attach__badge" onClick={() => setOpen((o) => !o)} title="Attachments">
        <PaperclipIcon />
        {attachments.length}
      </button>
      {open && (
        <div className="mail-attach__menu" onMouseLeave={() => setOpen(false)}>
          {attachments.map((a, i) => (
            <MailAttachChip key={i} file={a} account={account} />
          ))}
        </div>
      )}
    </span>
  )
}
