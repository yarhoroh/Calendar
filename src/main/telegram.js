// Telegram bridge via the official Bot API using long-polling (getUpdates) —
// works from a desktop app behind NAT, no public webhook needed. Incoming text
// is handed to onMessage; replies go back through sendTelegram.

import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

const API = 'https://api.telegram.org/bot'

let token = ''
let offset = 0
let running = false
let onMessage = () => {}
let fileSeq = 0

async function call(method, body, signal) {
  const res = await fetch(`${API}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  return res.json()
}

export function sendTelegram(chatId, text) {
  if (!token || !chatId || !text) return
  return call('sendMessage', { chat_id: chatId, text }).catch(() => {})
}

// Send a local file to a Telegram chat as a document (original quality, any type).
// multipart upload via the global FormData/Blob (Node 20+). Returns the API result.
export async function sendTelegramFile(chatId, filePath, caption) {
  if (!token || !chatId || !filePath) return { ok: false, description: 'missing chat or file' }
  if (!existsSync(filePath)) return { ok: false, description: 'file not found on disk' }
  try {
    const buf = readFileSync(filePath)
    const name = String(filePath).split(/[\\/]/).pop() || 'file'
    const form = new FormData()
    form.append('chat_id', String(chatId))
    if (caption) form.append('caption', String(caption).slice(0, 1000))
    form.append('document', new Blob([buf]), name)
    const res = await fetch(`${API}${token}/sendDocument`, { method: 'POST', body: form })
    return res.json()
  } catch (e) {
    return { ok: false, description: e?.message || 'send file failed' }
  }
}

// where incoming Telegram files are saved — persisted under userData (attachments are
// linked by PATH, not copied, so a temp dir that gets cleaned would break the link)
function incomingDir() {
  const d = join(app.getPath('userData'), 'telegram-files')
  try {
    mkdirSync(d, { recursive: true })
  } catch {
    /* already exists */
  }
  return d
}
const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120)
const mediaTypeOf = (p) => (p.endsWith('.png') ? 'image/png' : p.endsWith('.webp') ? 'image/webp' : 'image/jpeg')

// download a Telegram file by file_id ONCE → { buf, path } (path = Telegram's, for the ext)
async function fetchFile(fileId) {
  if (!fileId) return null
  const f = await call('getFile', { file_id: fileId })
  const path = f?.result?.file_path
  if (!path) return null
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`)
  if (!res.ok) return null
  return { buf: Buffer.from(await res.arrayBuffer()), path }
}
// save a downloaded buffer to the incoming dir under a unique, safe name → absolute path
function saveIncoming(buf, name) {
  const dest = join(incomingDir(), `${Date.now()}-${fileSeq++}-${safeName(name)}`)
  writeFileSync(dest, buf)
  return dest
}

async function poll() {
  while (running) {
    try {
      const r = await call('getUpdates', { offset, timeout: 30 })
      if (!running) break
      if (r?.ok && Array.isArray(r.result)) {
        for (const u of r.result) {
          offset = u.update_id + 1
          const m = u.message || u.edited_message
          if (!m) continue
          const from = m.from?.first_name || ''
          if (m.document) {
            // a real file (any type) → save to disk; the AI can attach it to a note by path
            const d = await fetchFile(m.document.file_id).catch(() => null)
            const files = d ? [{ name: safeName(m.document.file_name || d.path.split('/').pop()), path: saveIncoming(d.buf, m.document.file_name || d.path.split('/').pop()) }] : []
            onMessage({ chatId: m.chat.id, from, text: m.caption || '', files, updateId: u.update_id })
          } else if (m.photo?.length) {
            // a photo → download once; give the AI BOTH the base64 (so it can SEE it) and a saved
            // file path (so it can attach it to a note, same as a document)
            const ph = m.photo[m.photo.length - 1] // highest resolution
            const d = await fetchFile(ph?.file_id).catch(() => null)
            const images = d ? [{ media_type: mediaTypeOf(d.path), data: d.buf.toString('base64') }] : []
            const files = d ? [{ name: safeName(`photo-${ph?.file_unique_id || fileSeq}.jpg`), path: saveIncoming(d.buf, `photo-${ph?.file_unique_id || fileSeq}.jpg`) }] : []
            onMessage({ chatId: m.chat.id, from, text: m.caption || '', images, files, updateId: u.update_id })
          } else if (m.text) {
            onMessage({ chatId: m.chat.id, text: m.text, from, updateId: u.update_id })
          }
        }
      } else if (r && r.ok === false) {
        if (r.error_code === 401 || r.error_code === 404) {
          running = false // bad token — retrying can't help
        } else {
          // transient API error: 409 = another instance is polling this bot
          // (installed + dev running together), 429/5xx = flood/outage — back
          // off and keep polling instead of dying silently until restart
          console.warn(`[telegram] getUpdates ${r.error_code}: ${r.description || 'error'} — retry in 5s`)
          await new Promise((res) => setTimeout(res, (r.parameters?.retry_after || 5) * 1000))
        }
      }
    } catch {
      await new Promise((res) => setTimeout(res, 3000)) // network hiccup → back off
    }
  }
}

// Start the bridge. Returns true if the token is valid (getMe succeeds).
export async function startTelegram(t, handler) {
  stopTelegram()
  token = (t || '').trim()
  onMessage = handler || (() => {})
  if (!token) return false
  let ok = false
  try {
    const me = await call('getMe', {})
    ok = !!me?.ok
  } catch {
    ok = false
  }
  if (!ok) {
    token = ''
    return false
  }
  running = true
  poll()
  return true
}

export function stopTelegram() {
  running = false
  token = ''
}
