import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'

// User-editable AI config (plain JSON text in userData) — survives reinstalls
// and can be edited by hand or changed by the assistant via the setModel action.
// Empty model = use that CLI's own default. codexReasoning: low/medium/high/xhigh.
const DEFAULTS = {
  claudeModel: '',
  codexModel: 'gpt-5.4-mini',
  codexReasoning: 'low',
  agyModel: '', // Antigravity CLI model ('' = its default)
  // Gemini API (free tier): key from Google AI Studio (aistudio.google.com/apikey), pasted in
  // Settings — NOT hardcoded. Free tier works on the Flash line (Pro's free quota is zero).
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  // Anthropic API (paid, direct) — key from console.anthropic.com, pasted in Settings, NEVER
  // hardcoded. Used to measure REAL token cost of running the assistant. Prompt caching is on:
  // the big static system prompt is cached, dynamic work is not. Every call's token usage + cost
  // is logged to api-usage.db for the Settings report.
  anthropicApiKey: '',
  anthropicModel: 'claude-sonnet-4-6',
  // price per MILLION tokens, USD (input / output). Cache write = 1.25×input, cache read = 0.1×input
  // (Anthropic's standard multipliers). Editable — update when prices change or add a model.
  anthropicPricing: {
    'claude-opus-4-8': { in: 15, out: 75 },
    'claude-sonnet-4-6': { in: 3, out: 15 },
    'claude-haiku-4-5': { in: 1, out: 5 }
  },
  apiLogText: false, // also store the full request/response TEXT per call (off by default: privacy + DB size)
  anthropicCache: '5m', // prompt cache TTL: 'off' | '5m' (1.25× write) | '1h' (2× write) — for cost A/B testing
  telegramToken: '', // bot token for the Telegram bridge ('' = off)
  // chat_id that owns this bot — the only sender the AI will ever act on. Empty means
  // "awaiting local approval": a message from an unrecognized chat is held and the app
  // asks the user to approve it (see telegram:pairing-request) before the AI sees it.
  // Migrated from an existing telegramChat on upgrade so a prior legitimate user isn't
  // asked to re-approve themselves. Cleared when the token changes (re-pair with approval).
  telegramOwnerChat: '',
  // extra layer on top of the owner-chat lock: once a session expires, even the
  // owner must type the password (as a normal Telegram message) before the AI
  // acts again. Password is encrypted at rest (safeStorage, same as Google
  // refresh tokens) — see encryptSecret/decryptSecret in google.js.
  telegramAuthEnabled: false,
  telegramAuthPasswordEnc: '',
  telegramAuthSessionMinutes: 60,
  // Google Calendar (read-only import). Create a "Desktop app" OAuth client in
  // Google Cloud, enable the Calendar API, set the consent screen to Testing and
  // add your accounts as test users, then paste the client id/secret here.
  googleClientId: '',
  googleClientSecret: '',
  // connected accounts: [{ email, displayName, refreshToken (encrypted), selectedCalendarIds: [], autoSyncCalendarIds: [], needsReconnect }]
  googleAccounts: [],
  // auto-sync Google → local notes, in minutes (0 = off): 5/10/30/60/1440
  googleSyncInterval: 0
}

function file() {
  return join(app.getPath('userData'), 'ai-config.json')
}

export function aiConfigPath() {
  return file()
}

export function loadAiConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

// Write the file on startup so users can find/edit it; merging keeps any values
// they set and fills in newly-added keys (claude/codex/agy…).
export function ensureAiConfig() {
  try {
    writeFileSync(file(), JSON.stringify(loadAiConfig(), null, 2))
  } catch {
    // ignore
  }
}

export function saveAiConfig(patch) {
  const next = { ...loadAiConfig(), ...(patch || {}) }
  try {
    writeFileSync(file(), JSON.stringify(next, null, 2))
  } catch {
    // ignore
  }
  return next
}
