import { useEffect, useState } from 'react'
import api from '../lib/api'

// Folder tree for one board ('today' | 'everyday' | 'general'). Reloads whenever
// the main process broadcasts a change (so AI edits show up live too).
export function useFolders(board) {
  const [folders, setFolders] = useState([])

  useEffect(() => {
    let alive = true
    const load = () => Promise.resolve(api.listFolders?.(board)).then((f) => alive && setFolders(f || []))
    load()
    const off = api.onFoldersChanged?.(load)
    return () => {
      alive = false
      off?.()
    }
  }, [board])

  return {
    folders,
    add: (name, parentId) => api.addFolder?.({ board, name, parentId: parentId || null }),
    rename: (id, name) => api.renameFolder?.(id, name),
    move: (id, parentId) => api.moveFolder?.(id, parentId || null),
    remove: (id) => api.deleteFolder?.(id)
  }
}
