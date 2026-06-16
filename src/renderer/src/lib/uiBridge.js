// Shared snapshot of the app's UI state + a control bus, so the AI knows where
// the user is (tab, fullscreen, editing, selected folder) and can drive it
// (enter edit, fullscreen a note, exit them, …). Components publish their slice
// of state and register control handlers.

let state = { view: 'calendar', board: 'today', folder: null, fullscreen: false, editing: false }
const watchers = new Set() // notified when the state changes (for reactive UI)
const handlers = new Set() // control handlers; each returns a value iff it handled the call

export const updateUiState = (patch) => {
  state = { ...state, ...patch }
  watchers.forEach((w) => w(state))
}
export const getUiState = () => state

// subscribe to state changes; returns an unsubscribe fn
export const subscribeUi = (fn) => {
  watchers.add(fn)
  return () => watchers.delete(fn)
}

// register a control handler `(name, arg) => result | undefined`. Many can be
// registered (e.g. one per day column); the first to return a non-undefined
// value wins, so a handler returns undefined for calls it can't serve.
export const registerUi = (fn) => {
  handlers.add(fn)
  return () => handlers.delete(fn)
}
export const ui = (name, arg) => {
  for (const fn of handlers) {
    const r = fn(name, arg)
    if (r !== undefined) return r
  }
  return undefined
}
