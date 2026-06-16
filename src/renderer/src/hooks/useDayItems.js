import { useEffect, useState } from 'react'
import api from '../lib/api'

// Notes for a single day. Stored in the main process (notes.json in app data),
// read by date and kept in order. This hook is the only place that knows where
// notes live — swapping to a local SQLite database later won't touch the UI.

export const STATUSES = ['todo', 'doing', 'done']

export function newItem(text = '') {
  return {
    id: crypto.randomUUID(),
    text,
    status: 'todo',
    time: null,
    title: null,
    collapsed: false,
    bold: false,
    italic: false,
    size: 1
  }
}

// heals items whose `text` got stored as an object by an older save
function normalize(list) {
  return (list || []).map((it) => {
    if (it && it.text && typeof it.text === 'object') {
      const o = it.text
      return {
        ...it,
        text: typeof o.text === 'string' ? o.text : '',
        title: typeof o.title === 'string' ? o.title : it.title ?? null,
        bold: !!o.bold,
        italic: !!o.italic,
        size: o.size || 1
      }
    }
    return {
      ...it,
      text: typeof it.text === 'string' ? it.text : '',
      title: typeof it.title === 'string' ? it.title : null
    }
  })
}

export function useDayItems(key) {
  const [items, setItems] = useState([])

  useEffect(() => {
    let alive = true
    const load = () =>
      Promise.resolve(api.getItems?.(key)).then((arr) => {
        if (alive) setItems(normalize(arr))
      })
    load()
    const off = api.onItemsChanged?.((changedKey) => {
      if (changedKey === key) load()
    })
    return () => {
      alive = false
      off?.()
    }
  }, [key])

  const mutate = (fn) =>
    setItems((prev) => {
      const next = fn(prev)
      api.saveItems?.(key, next)
      return next
    })

  return {
    items,
    add: (item) => mutate((prev) => [...prev, item]),
    update: (id, patch) => mutate((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i))),
    remove: (id) => mutate((prev) => prev.filter((i) => i.id !== id)),
    // move an item to a specific insertion index (index is in the original array)
    moveToIndex: (fromId, index) =>
      mutate((prev) => {
        const from = prev.findIndex((i) => i.id === fromId)
        if (from < 0) return prev
        const arr = prev.slice()
        const [moved] = arr.splice(from, 1)
        let idx = from < index ? index - 1 : index
        idx = Math.max(0, Math.min(idx, arr.length))
        arr.splice(idx, 0, moved)
        return arr
      }),
    // insert an item (e.g. dragged in from another day) at an index
    insertAt: (item, index) =>
      mutate((prev) => {
        if (prev.some((i) => i.id === item.id)) return prev
        const arr = prev.slice()
        const idx = Math.max(0, Math.min(index, arr.length))
        arr.splice(idx, 0, item)
        return arr
      })
  }
}
