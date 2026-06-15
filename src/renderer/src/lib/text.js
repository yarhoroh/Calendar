// Tiny helpers for the lightweight rich text stored in notes.
const DISALLOWED = /<(?!\/?(b|strong|i|em|u|br|div|span)\b)[^>]*>/gi

export const stripHtml = (s) => (s || '').replace(/<[^>]*>/g, '').trim()

export function sanitizeHtml(html) {
  return (html || '')
    .replace(/ on\w+="[^"]*"/gi, '')
    .replace(DISALLOWED, '')
    .replace(/<(b|strong|i|em|u|br|div|span)\b[^>]*>/gi, '<$1>')
}
