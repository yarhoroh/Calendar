import { lastUserMessage, lastUserImages } from './prompt'
import { chatLoop } from './chatLoop'
import { loadAiConfig } from './aiConfig'
import { recordUsage } from './apiUsage'

// Direct Anthropic API engine — like gemini.js (a keyed REST endpoint, not a local CLI), but its
// whole point is COST MEASUREMENT: every call's exact token usage (input / output / cache) comes
// back from the API and is logged to api-usage.db with the computed USD price. Key + model come from
// ai-config.json (anthropicApiKey / anthropicModel) — NEVER hardcoded.
//
// PROMPT CACHING: chatLoop bakes the big static system prompt into the first message's text. We
// split it back out into the `system` field with cache_control:ephemeral, so Anthropic caches those
// ~thousands of "how to work" tokens and later turns pay the 0.1× cache-read price instead of full.
// The dynamic work (user requests, tool results, PDF/calendar data) rides in `messages`, uncached.

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const VERSION = '2023-06-01'
const TIMEOUT = 120000
const MAX_TOKENS = 4096
const MAX_HISTORY = 60 // cap conversation turns kept (resent every call — must not grow forever)

let system = null // the cached system prompt (set on the first turn of a conversation)
let messages = [] // [{ role:'user'|'assistant', content }]
let curChannel = 'chat' // where the active turn came from (for the ledger)
let queue = Promise.resolve()

export function resetAnthropic() {
  system = null
  messages = []
}

// Chat entry — same contract as askClaude/askGemini. userMsg is captured so sendOne can split it off
// the system-prefixed first message for caching.
export function askAnthropic({ messages: msgs, ctx }) {
  const userMsg = lastUserMessage(msgs)
  const images = lastUserImages(msgs)
  curChannel = ctx?.channel || 'chat'
  const run = queue.then(() => {
    const isFresh = messages.length === 0
    const sendOne = (text, imgs) => anthropicSendOne(text, imgs, userMsg)
    return chatLoop({ sendOne, isFresh, ctx, userMsg, images })
  })
  queue = run.catch(() => {})
  return run
}

// isolated one-shot — a throwaway conversation (no chat history). For utility prompts (email
// translation, article summary). Logged under channel 'raw'.
export function anthropicAskRaw(prompt, channel = 'raw') {
  return callAnthropic(null, [{ role: 'user', content: prompt }], channel)
}

// build a message `content` from text + optional base64 images (Anthropic block format)
function contentOf(text, images) {
  if (!images || !images.length) return text
  const blocks = [{ type: 'text', text }]
  for (const im of images) {
    if (im?.data && im?.media_type) blocks.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })
  }
  return blocks
}

// one chat step. On the FIRST turn the incoming text is "<systemPrompt>\n\n<userMsg>" — peel the
// system prompt off (it ends exactly with "\n\n"+userMsg) into the cached `system` field. Later
// turns (refresh + tool feeds) go straight in as a user message.
async function anthropicSendOne(text, images, userMsg) {
  if (system === null && userMsg && text.endsWith(`\n\n${userMsg}`)) {
    system = text.slice(0, text.length - userMsg.length - 2) // the static "how to work" preamble → cached
    messages.push({ role: 'user', content: contentOf(userMsg, images) })
  } else {
    if (system === null) system = '' // couldn't split (unexpected format) → no cache, still works
    messages.push({ role: 'user', content: contentOf(text, images) })
  }
  const r = await callAnthropic(system, messages, curChannel)
  if (r.ok) {
    messages.push({ role: 'assistant', content: r.text })
    if (messages.length > MAX_HISTORY) messages = messages.slice(messages.length - MAX_HISTORY)
  } else {
    messages.pop() // a failed turn must not poison the next request
  }
  return r
}

// USD price of one call from the token usage and the editable pricing table. Cache write = 1.25×in,
// cache read = 0.1×in (Anthropic's standard multipliers).
function costOf(model, u, pricing) {
  const p = (pricing || {})[model] || { in: 3, out: 15 }
  const M = 1e6
  return (u.input_tokens || 0) / M * p.in +
    (u.output_tokens || 0) / M * p.out +
    (u.cache_creation_input_tokens || 0) / M * (p.in * 1.25) +
    (u.cache_read_input_tokens || 0) / M * (p.in * 0.1)
}

// POST to the Messages API. `sys` (string|null) → cached system block; `msgs` → the conversation.
// Returns { ok, text, error } and LOGS the token usage + cost to api-usage.db.
async function callAnthropic(sys, msgs, channel) {
  const cfg = loadAiConfig()
  const key = (cfg.anthropicApiKey || '').trim()
  const model = cfg.anthropicModel || 'claude-sonnet-4-6'
  if (!key) return { ok: false, text: '', error: 'no Anthropic API key — set it in Settings' }
  const body = { model, max_tokens: MAX_TOKENS, messages: msgs }
  if (sys) body.system = [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }] // cache the preamble
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  const t0 = Date.now()
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    const j = await res.json().catch(() => null)
    if (!res.ok) {
      const msg = j?.error?.message || `http ${res.status}`
      console.log(`[anthropic] ✗ ${res.status}: ${String(msg).slice(0, 200)}`)
      return { ok: false, text: '', error: msg }
    }
    const text = (j?.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim()
    const u = j?.usage || {}
    const cost = costOf(model, u, cfg.anthropicPricing)
    // LOG every call — tokens as the API reports them + the computed price
    recordUsage({
      engine: 'anthropic', model, channel,
      in_tok: u.input_tokens || 0, out_tok: u.output_tokens || 0,
      cw_tok: u.cache_creation_input_tokens || 0, cr_tok: u.cache_read_input_tokens || 0,
      cost,
      req: cfg.apiLogText ? JSON.stringify(msgs).slice(0, 200000) : null,
      resp: cfg.apiLogText ? text.slice(0, 200000) : null
    })
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`[anthropic] ← ${secs}s ${text.length} chars | in ${u.input_tokens || 0} out ${u.output_tokens || 0} cacheW ${u.cache_creation_input_tokens || 0} cacheR ${u.cache_read_input_tokens || 0} → $${cost.toFixed(4)} (${model})`)
    if (!text) return { ok: false, text: '', error: j?.stop_reason || 'empty response' }
    return { ok: true, text }
  } catch (e) {
    const err = e?.name === 'AbortError' ? 'anthropic timed out' : e?.message || String(e)
    console.log(`[anthropic] ✗ ${err}`)
    return { ok: false, text: '', error: err }
  } finally {
    clearTimeout(timer)
  }
}

// live key check for Settings — a 1-token ping to the configured model (logged under 'ping')
export async function pingAnthropic() {
  const cfg = loadAiConfig()
  if (!(cfg.anthropicApiKey || '').trim()) return { ok: false, error: 'no key' }
  const r = await callAnthropic(null, [{ role: 'user', content: 'Reply with: ok' }], 'ping')
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}
