import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'
import { CloseIcon, FolderIcon } from '../icons'
import './AttachmentsPopover.css'

// Portal popover listing a note's attached files. Click a file to open it in its
// default app; × to detach; "+ add" opens the native multi-file picker.
export default function AttachmentsPopover({ anchorRef, noteId, onClose }) {
  const { t } = useI18n()
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  const [files, setFiles] = useState([])
  const [icons, setIcons] = useState({}) // id → OS file-type icon (data URL)

  const load = () => Promise.resolve(api.listAttachments?.(noteId)).then((r) => setFiles(r || []))

  useLayoutEffect(() => {
    const a = anchorRef?.current?.getBoundingClientRect()
    const width = 250
    if (a) {
      let left = a.left
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8
      setPos({ top: a.bottom + 4, left: Math.max(8, left) })
    } else {
      setPos({ top: 60, left: 60 })
    }
  }, [anchorRef])

  useEffect(() => {
    load()
    const off = api.onAttachChanged?.((p) => {
      if (!p || p.noteId === noteId) load()
    })
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId])

  // fetch the Windows file-type icon for each file once
  useEffect(() => {
    let alive = true
    files.forEach((f) => {
      if (icons[f.id] !== undefined) return
      Promise.resolve(api.attachmentIcon?.(f.id)).then((d) => alive && setIcons((m) => ({ ...m, [f.id]: d || null })))
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files])

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  if (!pos) return null

  return createPortal(
    <div className="attach-pop" ref={ref} style={{ top: pos.top, left: pos.left }}>
      {files.length === 0 && <div className="attach-pop__empty">{t('attach.empty')}</div>}
      {files.map((f) => (
        <div className="attach-pop__row" key={f.id}>
          {icons[f.id] ? (
            <img className="attach-pop__icon" src={icons[f.id]} alt="" />
          ) : (
            <span className="attach-pop__icon attach-pop__icon--ph" />
          )}
          <button
            className="attach-pop__name"
            title={f.path}
            onClick={() => api.openAttachment?.(f.id)}
          >
            {f.name}
          </button>
          <button
            className="attach-pop__reveal"
            title={t('attach.reveal')}
            onClick={() => api.revealAttachment?.(f.id)}
          >
            <FolderIcon />
          </button>
          <button
            className="attach-pop__del"
            title={t('attach.remove')}
            onClick={() => api.removeAttachment?.(f.id)}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
      <button className="attach-pop__add" onClick={() => api.addAttachments?.(noteId)}>
        + {t('attach.add')}
      </button>
    </div>,
    document.body
  )
}
