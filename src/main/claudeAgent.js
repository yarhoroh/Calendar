import { spawn } from 'child_process'
import { lastUserMessage, lastUserImages } from './prompt'
import { chatLoop } from './chatLoop'

// Persistent Claude agent over Claude Code's streaming JSON protocol
// (`claude -p --input-format stream-json --output-format stream-json`): one
// long-lived process, messages sent as JSON lines, conversation context kept in
// the live session — so replies are fast and we don't replay history. Tools are
// disabled (chat only).

const TIMEOUT = 120000
const FLAGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--disallowedTools',
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch'
]

let proc = null
let buf = ''
let model = '' // claude model ('' = CLI default)
let onFallback = null // called with '' when the model errors as not-found
const isModelError = (e) => /not.?found|unknown model|invalid model|requested entity/i.test(e || '')
let turns = 0 // prompts sent on the current session (0 = fresh → full preamble)
let queue = Promise.resolve() // serialize turns
let current = null // resolver for the in-flight turn

function cleanup() {
  if (current) {
    current.settle({ ok: false, text: '', error: 'claude process closed' })
    current = null
  }
  proc = null
  buf = ''
  turns = 0
}

function handle(line) {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.type === 'result' && current) {
    const c = current
    current = null
    if (m.is_error) c.settle({ ok: false, text: '', error: typeof m.result === 'string' ? m.result : 'claude error' })
    else c.settle({ ok: true, text: (m.result || '').trim() })
  }
}

function spawnProc() {
  const args = model ? [...FLAGS, '--model', model] : FLAGS
  proc = spawn('claude', args, { shell: true, windowsHide: true })
  proc.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) handle(line)
    }
  })
  proc.stderr.on('data', () => {})
  proc.on('error', cleanup)
  proc.on('close', cleanup)
  return proc
}

export function warmClaude(m = '', cb = null) {
  model = m || ''
  onFallback = cb
  if (!proc) {
    try {
      spawnProc()
    } catch {
      return Promise.resolve(false)
    }
  }
  return Promise.resolve(!!proc)
}

export function stopClaude() {
  const p = proc
  if (p?.pid) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true })
      } else {
        p.kill()
      }
    } catch {
      // ignore
    }
  }
  cleanup()
}

// Wipe memory: a fresh process = a fresh conversation.
export function clearClaude() {
  stopClaude()
  spawnProc()
}

export function askClaude({ messages, ctx }) {
  const userMsg = lastUserMessage(messages)
  const images = lastUserImages(messages)
  const run = queue.then(async () => {
    const isFresh = turns === 0
    const res = await chatLoop({ sendOne: claudeSendOne, isFresh, ctx, userMsg, images })
    if (res?.ok) {
      turns++ // count this user turn (whole loop = one turn)
    } else if (model && isModelError(res?.error)) {
      // bad model → reset to the CLI default, persist, and recycle the process
      model = ''
      try {
        onFallback?.('')
      } catch {
        // ignore
      }
      stopClaude()
    }
    return res
  })
  queue = run.catch(() => {})
  return run
}

function claudeSendOne(text, images) {
  if (!proc) spawnProc()
  return new Promise((resolve) => {
    let done = false
    const settle = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      current = null
      stopClaude() // stuck → recycle
      settle({ ok: false, text: '', error: 'claude timed out' })
    }, TIMEOUT)
    current = { settle }
    const content = [{ type: 'text', text }]
    for (const im of images || [])
      content.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })
    try {
      proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
    } catch (e) {
      current = null
      settle({ ok: false, text: '', error: e.message })
    }
  })
}
