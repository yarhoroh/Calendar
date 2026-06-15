// Small date helpers for the calendar. Formatting follows the current locale,
// which is set from the active UI language (see i18n).

const DAY_MS = 86400000

let locale = 'en-US'
let wkShort
let moShort
let moLong

function buildFormatters() {
  wkShort = new Intl.DateTimeFormat(locale, { weekday: 'short' })
  moShort = new Intl.DateTimeFormat(locale, { month: 'short' })
  moLong = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' })
}
buildFormatters()

export function setDateLocale(next) {
  locale = next
  buildFormatters()
}

export function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

export function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

// whole-day difference between two midnight dates
export function daysDiff(date, base) {
  return Math.round((date.getTime() - base.getTime()) / DAY_MS)
}

// short weekday names Monday..Sunday in the current locale
export function weekdayShortList() {
  const monday = new Date(2024, 0, 1) // a known Monday
  const out = []
  for (let i = 0; i < 7; i++) out.push(wkShort.format(addDays(monday, i)))
  return out
}

// stable per-day key, e.g. "2026-06-15"
export function dateKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// parse "2026-06-15" back to a midnight Date
export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// numeric date, e.g. "01.06.2026"
export function dateNumeric(d) {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getFullYear()}`
}

export const weekday = (d) => wkShort.format(d)
export const monthShort = (d) => moShort.format(d)
export const dayNum = (d) => d.getDate()
export const monthLabel = (d) => moLong.format(d)
export const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6
