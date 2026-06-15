// Remembered text format for notes (bold / italic / size). The toolbar toggles
// are "sticky": the last chosen values are stored and become the default for
// the next new note.
const KEY = 'item-format'

export const DEFAULT_FORMAT = { bold: false, italic: false, size: 1 }

export function loadFormat() {
  try {
    return { ...DEFAULT_FORMAT, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }
  } catch {
    return { ...DEFAULT_FORMAT }
  }
}

export function saveFormat(format) {
  try {
    localStorage.setItem(KEY, JSON.stringify(format))
  } catch {
    // ignore
  }
}
