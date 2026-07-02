// Shared recurrence predicate for "everyday" notes. A note recurs either weekly
// (by weekday) or monthly (by day-of-month) — the two modes are mutually
// exclusive: a non-empty `monthDays` means monthly, otherwise it's weekly.

// day-of-month count for a date's month (28..31)
export const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()

// Does a monthly note (monthDays = days of month, 32 = "last day") fire on this
// date? A selected day past the month's length (e.g. 31 in February, or the 32
// sentinel) falls onto the last day of that month.
export function monthDayMatches(date, monthDays) {
  const dom = date.getDate()
  if (monthDays.includes(dom)) return true
  const dim = daysInMonth(date)
  return dom === dim && monthDays.some((n) => n > dim)
}

// Does an everyday note fire on `date`? monthly (monthDays) wins; otherwise
// weekly — its own `days`, or the global working days when it has none.
export function recurs(date, days, monthDays, workingDays) {
  if (Array.isArray(monthDays) && monthDays.length) return monthDayMatches(date, monthDays)
  const wd = Array.isArray(days) && days.length ? days : workingDays
  return !wd || wd.includes(date.getDay())
}
