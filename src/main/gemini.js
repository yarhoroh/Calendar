import { lastUserMessage, lastUserImages } from './prompt'
import { chatLoop } from './chatLoop'
import { loadAiConfig } from './aiConfig'

// Gemini API backend — the free-tier alternative to the CLI engines. Unlike claude/codex/agy
// (local CLIs), this talks to Google's REST endpoint with an API key (x-goog-api-key). The key +
// model come from ai-config.json (geminiApiKey / geminiModel) — NEVER hardcoded. The free tier
// works on the Flash line (gemini-2.5-flash and friends); Pro's free quota is zero.
//
// The REST API is STATELESS, so — unlike the resumable CLI sessions — we keep the conversation
// ourselves (history[] of Gemini `contents`) and resend it each call. resetGemini() clears it on
// chat-clear / engine switch, exactly like resetCodex/resetAgy.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta'
const TIMEOUT = 120000
const MAX_HISTORY = 80 // safety cap on turns kept (free tier is generous, but don't grow forever)

let history = [] // [{ role: 'user'|'model', parts: [...] }]
let queue = Promise.resolve() // serialize turns (shared history must not interleave)

// next turn starts a fresh conversation (called on clear / engine switch)
export function resetGemini() {
  history = []
}

// Chat entry point — same contract as askClaude/askCodex/askAgy: drive chatLoop with a sendOne
// that maintains the conversation. isFresh = empty history → full system preamble, else a refresh.
export function askGemini({ messages, ctx }) {
  const userMsg = lastUserMessage(messages)
  const images = lastUserImages(messages)
  const run = queue.then(() => {
    const isFresh = history.length === 0
    const sendOne = (text, imgs) => geminiSendOne(text, imgs)
    return chatLoop({ sendOne, isFresh, ctx, userMsg, images })
  })
  queue = run.catch(() => {})
  return run
}

// isolated one-shot — a FRESH throwaway conversation (no chat history, no calendar guard). For
// utility prompts (email translation, article summary) that must not touch the chat.
export function geminiAskRaw(prompt) {
  return callGemini([{ role: 'user', parts: [{ text: prompt }] }])
}

// text (+ optional base64 images) → a Gemini `parts` array. Images ride as inline_data.
function toParts(text, images) {
  const parts = [{ text }]
  for (const im of images || []) {
    if (im?.data && im?.media_type) parts.push({ inline_data: { mime_type: im.media_type, data: im.data } })
  }
  return parts
}

// one chat step: append the user turn, call the API with the whole history, append the model reply
async function geminiSendOne(text, images) {
  history.push({ role: 'user', parts: toParts(text, images) })
  const r = await callGemini(history)
  if (r.ok) {
    history.push({ role: 'model', parts: [{ text: r.text }] })
    // trim oldest COMPLETE pairs so a long chat can't grow unbounded (keep the count even)
    if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY)
  } else {
    history.pop() // a failed turn must not poison the next request
  }
  return r
}

// POST contents to generateContent and pull out the reply text. Returns { ok, text, error }.
async function callGemini(contents) {
  const cfg = loadAiConfig()
  const key = (cfg.geminiApiKey || '').trim()
  const model = cfg.geminiModel || 'gemini-2.5-flash'
  if (!key) return { ok: false, text: '', error: 'no Gemini API key — set it in Settings' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  const t0 = Date.now()
  try {
    const res = await fetch(`${ENDPOINT}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents }),
      signal: ctrl.signal
    })
    const j = await res.json().catch(() => null)
    if (!res.ok) {
      const msg = j?.error?.message || `http ${res.status}`
      console.log(`[gemini] ✗ ${res.status}: ${String(msg).slice(0, 200)}`)
      return { ok: false, text: '', error: msg }
    }
    const cand = j?.candidates?.[0]
    const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim()
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (!text) {
      // blocked / truncated with no text — surface the reason instead of a silent empty reply
      const reason = cand?.finishReason || j?.promptFeedback?.blockReason || 'empty response'
      console.log(`[gemini] ← ${secs}s, no text (${reason})`)
      return { ok: false, text: '', error: String(reason) }
    }
    console.log(`[gemini] ← ${secs}s, ${text.length} chars (${model})`)
    return { ok: true, text }
  } catch (e) {
    const err = e?.name === 'AbortError' ? 'gemini timed out' : e?.message || String(e)
    console.log(`[gemini] ✗ ${err}`)
    return { ok: false, text: '', error: err }
  } finally {
    clearTimeout(timer)
  }
}

// live check the key works (used by Settings): a 1-token ping to the configured model
export async function pingGemini() {
  const cfg = loadAiConfig()
  if (!(cfg.geminiApiKey || '').trim()) return { ok: false, error: 'no key' }
  const r = await callGemini([{ role: 'user', parts: [{ text: 'Reply with: ok' }] }])
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}
