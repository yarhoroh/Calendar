// 2-letter monogram for an email or display name (e.g. gorohov.game → GG,
// "Anna Petrenko" → AP). Used by the collapsed mail menu and the account avatar.
export function monogram(value) {
  const base = String(value || '').split('@')[0]
  const parts = base.split(/[.\s_-]+/).filter(Boolean)
  const s = parts.length >= 2 ? parts[0][0] + parts[1][0] : base.slice(0, 2)
  return s.toUpperCase()
}
