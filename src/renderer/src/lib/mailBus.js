// Tiny pub/sub so AI mail actions (executed in execAction via IPC) can tell an open
// MailList to update instantly — the AI deletes/marks straight through the backend, which
// the list wouldn't otherwise notice, so its rows would linger until the next reload.
// Mirrors how a manual delete/mark updates the list optimistically.
const subs = new Set()

export function onMailChanged(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function emitMailChanged(evt) {
  for (const fn of subs) {
    try {
      fn(evt)
    } catch {
      /* a bad subscriber shouldn't break the others */
    }
  }
}
