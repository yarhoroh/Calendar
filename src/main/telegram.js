// Telegram bridge via the official Bot API using long-polling (getUpdates) —
// works from a desktop app behind NAT, no public webhook needed. Incoming text
// is handed to onMessage; replies go back through sendTelegram.

const API = 'https://api.telegram.org/bot'

let token = ''
let offset = 0
let running = false
let onMessage = () => {}

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

// Download a Telegram photo (largest size) as a base64 image the AI can see.
async function downloadPhoto(photos) {
  const ph = photos[photos.length - 1] // last entry = highest resolution
  if (!ph?.file_id) return null
  const f = await call('getFile', { file_id: ph.file_id })
  const path = f?.result?.file_path
  if (!path) return null
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const media_type = path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
  return { media_type, data: buf.toString('base64') }
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
          if (m.photo?.length) {
            const img = await downloadPhoto(m.photo).catch(() => null)
            onMessage({
              chatId: m.chat.id,
              from: m.from?.first_name || '',
              text: m.caption || '',
              images: img ? [img] : []
            })
          } else if (m.text) {
            onMessage({ chatId: m.chat.id, text: m.text, from: m.from?.first_name || '' })
          }
        }
      } else if (r && r.ok === false) {
        // bad token / API error — stop polling to avoid a tight error loop
        running = false
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
