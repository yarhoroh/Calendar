// Topic-overlap check for AI memory: when a new "remember" is clearly about the
// same thing as an existing fact, the old one should stop being shown to the AI
// instead of sitting next to the new one forever (the classic "told it aisle
// seats, then window seats, it still sees both" bug).
//
// Same idea as mnem (github.com/JustVugg/mnem) — IDF-weighted overlap coefficient,
// reimplemented in plain JS (no Python runtime) and made Unicode-aware so Russian/
// Ukrainian facts tokenize too (mnem's tokenizer is ASCII-only: `[a-z0-9]+`).

const TOKEN_RE = /[\p{L}\p{N}]+/gu

function tokenize(text) {
  return new Set(String(text || '').toLowerCase().match(TOKEN_RE) || [])
}

function idf(token, docFreq, docCount) {
  return Math.log((1 + docCount) / (1 + (docFreq.get(token) || 0))) + 1
}

function weightSum(tokens, docFreq, docCount) {
  let sum = 0
  for (const t of tokens) sum += idf(t, docFreq, docCount)
  return sum
}

// rows: [{id, text}] of current (non-superseded) facts.
// Returns the id of the row `newText` should supersede, or null.
export function pickSupersededId(newText, rows, threshold = 0.55) {
  if (!rows || !rows.length) return null
  const newTokens = tokenize(newText)
  if (!newTokens.size) return null

  const tokenSets = rows.map((r) => tokenize(r.text))
  const docFreq = new Map()
  for (const set of tokenSets) {
    for (const t of set) docFreq.set(t, (docFreq.get(t) || 0) + 1)
  }
  const docCount = tokenSets.length

  let bestId = null
  let bestScore = 0
  for (let i = 0; i < rows.length; i++) {
    const shared = [...newTokens].filter((t) => tokenSets[i].has(t))
    if (!shared.length) continue
    const num = shared.reduce((s, t) => s + idf(t, docFreq, docCount), 0)
    const denom =
      Math.min(weightSum(newTokens, docFreq, docCount), weightSum(tokenSets[i], docFreq, docCount)) || 1
    const score = num / denom
    if (score > bestScore) {
      bestScore = score
      bestId = rows[i].id
    }
  }
  return bestScore >= threshold ? bestId : null
}
