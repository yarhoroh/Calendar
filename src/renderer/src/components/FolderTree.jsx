import { useState } from 'react'
import api from '../lib/api'
import { useI18n } from '../i18n/I18nContext'
import './FolderTree.css'

const NOTE = 'application/x-note'
const FOLDER = 'application/x-folder'
const ROOT = '__root__' // the always-present "General" root (folderId = null)

// Compact, single-column folder tree for one board. Rows are indented by depth
// (not a sprawling tree). Select to filter notes; drag a note onto a row to file
// it there; drag a folder onto a row to reparent. Add / rename / delete inline.
export default function FolderTree({ folders, selected, onSelect, onAdd, onRename, onMove, onRemove }) {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [editing, setEditing] = useState(null) // folder id being renamed
  const [adding, setAdding] = useState(null) // { parentId } while typing a new name
  const [draft, setDraft] = useState('')
  const [overId, setOverId] = useState(null) // drop-highlight target (id or ROOT)
  const [notice, setNotice] = useState('')

  const childrenOf = (pid) => folders.filter((f) => (f.parentId || null) === pid)
  const toggle = (id) =>
    setCollapsed((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const commitAdd = () => {
    const name = draft.trim()
    if (name) onAdd(name, adding.parentId)
    setAdding(null)
    setDraft('')
  }
  const commitRename = (id) => {
    const name = draft.trim()
    if (name) onRename(id, name)
    setEditing(null)
    setDraft('')
  }
  const del = async (id) => {
    const r = await onRemove(id)
    if (r && r.ok === false) setNotice(r.error === 'has-subfolders' ? t('folders.hasSubfolders') : t('folders.hasNotes'))
  }

  // assign a dragged note to a folder (id = null for the General root)
  const dropNote = async (e, folderId) => {
    let data
    try {
      data = JSON.parse(e.dataTransfer.getData(NOTE))
    } catch {
      return
    }
    const src = (await api.getItems?.(data.fromDay)) || []
    api.saveItems?.(data.fromDay, src.map((i) => (i.id === data.id ? { ...i, folderId } : i)))
  }

  const onRowDrop = (e, targetId) => {
    setOverId(null)
    const types = e.dataTransfer.types || []
    if (types.includes(NOTE)) {
      e.preventDefault()
      dropNote(e, targetId === ROOT ? null : targetId)
    } else if (types.includes(FOLDER)) {
      e.preventDefault()
      const id = e.dataTransfer.getData(FOLDER)
      if (id && id !== targetId) onMove(id, targetId === ROOT ? null : targetId)
    }
  }
  const onRowOver = (e, targetId) => {
    const types = e.dataTransfer.types || []
    if (types.includes(NOTE) || types.includes(FOLDER)) {
      e.preventDefault()
      setOverId(targetId)
    }
  }

  const addInput = (parentId) => (
    <div className="folder-tree__add" style={{ paddingLeft: depthPad(parentId, folders) + 22 }}>
      <input
        autoFocus
        className="folder-tree__input"
        value={draft}
        placeholder={t('folders.newName')}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitAdd()
          else if (e.key === 'Escape') {
            setAdding(null)
            setDraft('')
          }
        }}
        onBlur={commitAdd}
      />
    </div>
  )

  const renderNode = (folder, depth) => {
    const kids = childrenOf(folder.id)
    const isOpen = !collapsed.has(folder.id)
    return (
      <div key={folder.id}>
        <div
          className={
            'folder-tree__row' +
            (selected === folder.id ? ' folder-tree__row--active' : '') +
            (overId === folder.id ? ' folder-tree__row--over' : '')
          }
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData(FOLDER, folder.id)
          }}
          onDragOver={(e) => onRowOver(e, folder.id)}
          onDragLeave={() => setOverId((v) => (v === folder.id ? null : v))}
          onDrop={(e) => onRowDrop(e, folder.id)}
          onClick={() => onSelect(folder.id)}
        >
          <button
            style={{ marginLeft: depth * 14 }}
            className={'folder-tree__toggle' + (kids.length ? '' : ' folder-tree__toggle--hidden')}
            onClick={(e) => {
              e.stopPropagation()
              toggle(folder.id)
            }}
          >
            {kids.length ? (isOpen ? '−' : '+') : ''}
          </button>
          {editing === folder.id ? (
            <input
              autoFocus
              className="folder-tree__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(folder.id)
                else if (e.key === 'Escape') {
                  setEditing(null)
                  setDraft('')
                }
              }}
              onBlur={() => commitRename(folder.id)}
            />
          ) : (
            <span className="folder-tree__name" onDoubleClick={(e) => { e.stopPropagation(); setEditing(folder.id); setDraft(folder.name) }}>
              {folder.name}
            </span>
          )}
          <span className="folder-tree__actions">
            <button title={t('folders.addChild')} onClick={(e) => { e.stopPropagation(); setAdding({ parentId: folder.id }); setDraft(''); setCollapsed((s) => { const n = new Set(s); n.delete(folder.id); return n }) }}>＋</button>
            <button title={t('folders.rename')} onClick={(e) => { e.stopPropagation(); setEditing(folder.id); setDraft(folder.name) }}>✎</button>
            <button title={t('folders.delete')} onClick={(e) => { e.stopPropagation(); del(folder.id) }}>✕</button>
          </span>
        </div>
        {adding && adding.parentId === folder.id && addInput(folder.id)}
        {isOpen && kids.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className="folder-tree">
      {notice && (
        <div className="folder-tree__notice" onClick={() => setNotice('')}>
          {notice}
        </div>
      )}
      {/* General root: always present, shows everything */}
      <div
        className={
          'folder-tree__row folder-tree__row--root' +
          (selected === null ? ' folder-tree__row--active' : '') +
          (overId === ROOT ? ' folder-tree__row--over' : '')
        }
        onDragOver={(e) => onRowOver(e, ROOT)}
        onDragLeave={() => setOverId((v) => (v === ROOT ? null : v))}
        onDrop={(e) => onRowDrop(e, ROOT)}
        onClick={() => onSelect(null)}
      >
        <span className="folder-tree__name folder-tree__name--root">{t('calendar.general')}</span>
        <span className="folder-tree__actions">
          <button title={t('folders.addChild')} onClick={(e) => { e.stopPropagation(); setAdding({ parentId: null }); setDraft('') }}>＋</button>
        </span>
      </div>
      {adding && adding.parentId === null && addInput(null)}
      {childrenOf(null).map((f) => renderNode(f, 0))}
    </div>
  )
}

// left padding for an inline add-input placed under a parent (root = null → 0)
function depthPad(parentId, folders) {
  let depth = 0
  let cur = parentId
  const byId = new Map(folders.map((f) => [f.id, f]))
  while (cur) {
    depth++
    cur = byId.get(cur)?.parentId || null
  }
  return parentId === null ? 0 : 6 + depth * 14
}
