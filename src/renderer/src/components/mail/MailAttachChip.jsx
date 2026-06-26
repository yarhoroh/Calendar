import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { DownloadIcon, FolderIcon } from '../icons'

// One attachment chip: the real OS file-type icon (Word/PDF/Excel…), the name
// (middle-truncated so the extension stays visible), the size, a Save As… arrow
// and — once the file was saved somewhere — a folder button that opens that
// folder. Clicking the icon/name opens the file in the OS default app.

const fmtSize = (n) =>
  !n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`

// split "report-final.pdf" → ["report-final", ".pdf"]
function splitName(name) {
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return [name, '']
  return [name.slice(0, i), name.slice(i)]
}

// per-extension OS icon cache so we ask the main process once per type
const iconCache = new Map()

export default function MailAttachChip({ file, account }) {
  const name = file?.name || 'attachment'
  const [base, ext] = splitName(name)
  const key = ext.slice(1).toLowerCase()
  const [icon, setIcon] = useState(() => iconCache.get(key))
  const [saved, setSaved] = useState(null) // path the file was last saved to

  useEffect(() => {
    if (!key || iconCache.has(key)) return
    let alive = true
    Promise.resolve(api.mail?.fileIcon?.(key)).then((d) => {
      iconCache.set(key, d || null)
      if (alive) setIcon(d || null)
    })
    return () => {
      alive = false
    }
  }, [key])

  // remember if this attachment was already saved (survives cache re-syncs)
  useEffect(() => {
    if (!file?.mid || !file?.part) return
    let alive = true
    Promise.resolve(api.mail?.savedPath?.(account, file.mid, file.part)).then((p) => alive && setSaved(p || null))
    return () => {
      alive = false
    }
  }, [account, file?.mid, file?.part])

  // icon/name → open in default app; arrow → Save As… (and remember the folder)
  const act = (e, saveAs) => {
    e.stopPropagation()
    if (!file?.part) return
    Promise.resolve(api.mail?.openAttachment?.(account, file.mid, file.part, name, saveAs)).then((r) => {
      if (saveAs && r?.ok && r.path) setSaved(r.path)
    })
  }
  const reveal = (e) => {
    e.stopPropagation()
    if (saved) api.mail?.revealSaved?.(saved)
  }

  return (
    <div className="mail-chip">
      <button className="mail-chip__main" title={name} onClick={(e) => act(e, false)}>
        {icon ? <img className="mail-chip__icon" src={icon} alt="" /> : <span className="mail-chip__icon mail-chip__icon--ph" />}
        <span className="mail-chip__name">
          <span className="mail-chip__base">{base}</span>
          {ext && <span className="mail-chip__ext">{ext}</span>}
        </span>
        {file?.size > 0 && <span className="mail-chip__size">{fmtSize(file.size)}</span>}
      </button>
      <button className="mail-chip__dl" title="Save as…" onClick={(e) => act(e, true)}>
        <DownloadIcon />
      </button>
      {saved && (
        <button className="mail-chip__folder" title="Open saved folder" onClick={reveal}>
          <FolderIcon />
        </button>
      )}
    </div>
  )
}
