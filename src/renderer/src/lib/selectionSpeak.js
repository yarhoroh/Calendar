import { speakArticle } from './ttsBridge'

// Shared "speak the selected text" logic, used by every place that mounts a
// <SelectionPlayButton>: the article reader (plain DOM), the email body (sandboxed
// iframe) and the internal browser (webview). Each host detects its own selection
// (the mechanisms genuinely differ); this module owns the text→speech part.

// split text into TTS-sized chunks so the first clip synthesizes fast (playback starts
// quickly) and the rest stream in the background. Splits on paragraphs; a long paragraph
// is further packed by sentence up to ~max chars.
export function splitForTts(text, max = 600) {
  const paras = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
  const chunks = []
  for (const p of paras) {
    if (p.length <= max) {
      chunks.push(p)
      continue
    }
    const sentences = p.match(/[^.!?…]+[.!?…]*\s*/g) || [p]
    let cur = ''
    for (const s of sentences) {
      if (cur && cur.length + s.length > max) {
        chunks.push(cur.trim())
        cur = ''
      }
      cur += s
    }
    if (cur.trim()) chunks.push(cur.trim())
  }
  return chunks
}

// best-effort language pick when the host doesn't know it (internal browser, raw email):
// Ukrainian-only letters → uk, any other Cyrillic → ru, otherwise en.
export function detectTtsLang(text) {
  const s = String(text || '')
  if (/[іїєґ]/i.test(s)) return 'uk'
  if (/[а-яё]/i.test(s)) return 'ru'
  return 'en'
}

// speak an arbitrary selected fragment through the GLOBAL queue (survives navigation).
// lang: a TTS code ('ru'|'uk'|'en') or 'auto'/falsy to detect from the text. A user
// selection is spoken as ONE piece — no chunking — so it reads as a single continuous clip
// (chunking is only for long articles, where it makes the first clip start sooner).
// Returns false when there's nothing speakable.
export function speakSelection(text, lang) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return false
  speakArticle([clean], !lang || lang === 'auto' ? detectTtsLang(clean) : lang)
  return true
}
