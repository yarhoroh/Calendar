import { useEffect, useState } from 'react'
import api from '../lib/api'

// Custom note statuses (DB-backed). Reloads on the main-process change broadcast
// so the calendar and the settings panel stay in sync.
export function useStatuses() {
  const [statuses, setStatuses] = useState([])

  useEffect(() => {
    let alive = true
    const load = () => Promise.resolve(api.listStatuses?.()).then((s) => alive && setStatuses(s || []))
    load()
    const off = api.onStatusesChanged?.(load)
    return () => {
      alive = false
      off?.()
    }
  }, [])

  return {
    statuses,
    add: (name, color) => api.addStatus?.({ name, color }),
    update: (id, patch) => api.updateStatus?.(id, patch),
    remove: (id) => api.deleteStatus?.(id)
  }
}
