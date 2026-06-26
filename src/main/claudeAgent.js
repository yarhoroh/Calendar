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
  // speed: minimal reasoning + drop cwd/git/env from the system prompt — this is
  // a chat/translation assistant, none of that context is needed and it costs tokens
  '--effort',
  'low',
  '--exclude-dynamic-system-prompt-sections',
  // the safe parts of --bare (faster, more predictable startup) WITHOUT its auth
  // change: --bare forces ANTHROPIC_API_KEY-only auth and never reads OAuth/keychain,
  // which would break the subscription login. These flags don't touch auth.
  // NOTE: --no-session-persistence is intentionally NOT here — it targets one-shot
  // --print runs and destabilises this long-lived multi-turn chat process; it lives
  // in ONESHOT_FLAGS instead.
  '--strict-mcp-config', // ignore all MCP servers (we pass none) → skip their startup
  '--no-chrome', // no Claude-in-Chrome integration
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

// one-shot, text in/out — for isolated utility calls (translation / article reading)
// that must NOT share the chat's conversation. Same speed flags, no stream-json.
const ONESHOT_FLAGS = [
  '-p',
  // replace Claude Code's whole preamble (tools/agent instructions) with a tiny one —
  // these calls are pure text processing, none of that context is wanted and it only
  // slows things down and muddies the output format
  '--system-prompt',
  'You are a precise text-processing engine. Do exactly what the user asks and output only the requested result — nothing else.',
  '--effort',
  'low',
  '--exclude-dynamic-system-prompt-sections',
  '--strict-mcp-config',
  '--no-chrome',
  '--no-session-persistence',
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

// Isolated one-shot prompt → reply text. Spawns a fresh `claude -p` that does NOT
// share the persistent chat session, so utility tasks (translate / summarize) are
// never polluted by — or pollute — the chat conversation. Returns { ok, text }.
export function askClaudeRaw(prompt) {
  return new Promise((resolve) => {
    const args = model ? [...ONESHOT_FLAGS, '--model', model] : ONESHOT_FLAGS
    let p
    try {
      p = spawn('claude', args, { shell: true, windowsHide: true })
    } catch (e) {
      return resolve({ ok: false, text: '', error: e.message })
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        p.kill()
      } catch {
        // ignore
      }
      resolve({ ok: false, text: '', error: 'claude timed out' })
    }, TIMEOUT)
    p.stdout.on('data', (d) => (out += d.toString()))
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, text: '', error: e.message })
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve(out.trim() ? { ok: true, text: out.trim() } : { ok: false, text: '', error: err.trim() || 'claude exited ' + code })
    })
    try {
      p.stdin.end(prompt)
    } catch (e) {
      clearTimeout(timer)
      resolve({ ok: false, text: '', error: e.message })
    }
  })
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
