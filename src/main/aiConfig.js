import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'

// User-editable AI config (plain JSON text in userData) — survives reinstalls
// and can be edited by hand or changed by the assistant via the setModel action.
// Empty model = use that CLI's own default. codexReasoning: low/medium/high/xhigh.
const DEFAULTS = {
  geminiModel: 'gemini-2.5-flash',
  claudeModel: '',
  codexModel: 'gpt-5.4-mini',
  codexReasoning: 'low',
  telegramToken: '' // bot token for the Telegram bridge ('' = off)
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
// they set and fills in newly-added keys (gemini/claude/codex…).
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
