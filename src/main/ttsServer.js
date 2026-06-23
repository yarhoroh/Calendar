import { createServer } from 'http'
import { speak } from './tts'

// Local audio server: the calendar listens on 127.0.0.1 so the AI or any other
// local agent can POST text and have it spoken. Bound to loopback
// only — never exposed off the machine.

const PORT = 51273
let server = null

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1e6) req.destroy() // guard against huge payloads
    })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(''))
  })
}

export function startTtsServer() {
  if (server) return
  server = createServer(async (req, res) => {
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }
    if (req.method === 'GET' && req.url === '/status') return json(200, { ok: true, service: 'calendar-tts' })
    if (req.method === 'POST' && req.url === '/speak') {
      let payload = {}
      try {
        payload = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return json(400, { ok: false, error: 'bad json' })
      }
      const result = await speak({ text: payload.text, lang: payload.lang })
      return json(result.ok ? 200 : 400, result)
    }
    json(404, { ok: false, error: 'not found' })
  })
  server.on('error', () => {}) // e.g. port already in use — stay silent
  server.listen(PORT, '127.0.0.1')
}

export function stopTtsServer() {
  try {
    server?.close()
  } catch {
    // ignore
  }
  server = null
}
