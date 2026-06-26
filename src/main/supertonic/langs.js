// App language codes → Supertonic language tags. Supertonic ships one multilingual
// model covering these 31 languages; anything else falls back to English.
const SUPPORTED = new Set([
  'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu',
  'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi'
])

export function toSupertonicLang(code) {
  const c = (code || 'en').toLowerCase().slice(0, 2)
  return SUPPORTED.has(c) ? c : 'en'
}
