import { spawn } from 'child_process'
import { lastUserMessage, lastUserImages } from './prompt'
import { chatLoop } from './chatLoop'

// Persistent Gemini agent over the Agent Client Protocol (ACP): one long-lived
// `gemini --acp` process, talked to with newline-delimited JSON-RPC. The heavy
// startup (binary load, MCP/tool init) happens once; each chat turn is just a
// `session/prompt` on the live session, so replies are fast and the model keeps
// its own context. Falls back to restarting itself if the process dies.

const PROMPT_TIMEOUT = 120000

let proc = null
let buf = ''
let nextId = 0
let sessionId = null
let ready = null // Promise<boolean> for the initialize + session/new handshake
let turns = 0 // prompts sent on the current session (0 = fresh → full preamble)
let queue = Promise.resolve() // serializes prompts (one in flight at a time)
let chunks = null // accumulator for the in-flight reply's streamed text
let model = '' // gemini model ('' = CLI default 'auto')
let onFallback = null // called with '' when the configured model isn't available
const pending = new Map() // jsonrpc id -> { resolve }

function cleanup() {
  for (const { resolve } of pending.values()) resolve({ __error: { message: 'process closed' } })
  pending.clear()
  proc = null
  buf = ''
  sessionId = null
  ready = null
  turns = 0
  chunks = null
}

function write(obj) {
  try {
    proc.stdin.write(JSON.stringify(obj) + '\n')
  } catch {
    // process gone; pending requests are cleared by the close handler
  }
}

function request(method, params) {
  return new Promise((resolve) => {
    const id = nextId++
    pending.set(id, { resolve })
    write({ jsonrpc: '2.0', id, method, params })
  })
}

function handle(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  // agent -> client request (permission / fs). We run tool-free, so cancel.
  if (msg.method && msg.id !== undefined) {
    write({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } })
    return
  }
  // streamed assistant text
  if (msg.method === 'session/update') {
    const u = msg.params?.update
    if (u?.sessionUpdate === 'agent_message_chunk' && chunks) chunks.push(u.content?.text || '')
    return
  }
  // response to one of our requests
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id)
    pending.delete(msg.id)
    resolve(msg.result || { __error: msg.error })
  }
}

function spawnProc() {
  const args = model ? ['--acp', '-m', model] : ['--acp']
  proc = spawn('gemini', args, {
    shell: true,
    windowsHide: true,
    env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
  })
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

  ready = (async () => {
    try {
      await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
      })
      const sess = await request('session/new', { cwd: process.cwd(), mcpServers: [] })
      if (!sess?.sessionId) return false
      // if the configured model isn't available, fall back to the CLI default
      // (auto), persist the fix, and respawn — so a bad model never breaks startup
      const avail = (sess.models?.availableModels || []).map((x) => x.modelId)
      if (model && avail.length && !avail.includes(model)) {
        model = ''
        try {
          onFallback?.('')
        } catch {
          // ignore
        }
        stopAcp()
        return spawnProc()
      }
      sessionId = sess.sessionId
      turns = 0
      return true
    } catch {
      return false
    }
  })()
  return ready
}

// Ensure the agent is running and warmed up. Returns true once a session is
// live. `m` selects the gemini model ('' = CLI default); `cb` is called with ''
// if `m` isn't an available model (so the caller can persist the fallback).
export function warmAcp(m = '', cb = null) {
  model = m || ''
  onFallback = cb
  if (!proc) return spawnProc()
  return ready || Promise.resolve(!!sessionId)
}

// Wipe the agent's memory: spin up a fresh empty session on the same warm
// process (cheap — no re-init), so the next turn starts with no history.
export function clearAcp() {
  const run = queue.then(async () => {
    if (!proc) {
      await warmAcp()
      return
    }
    try {
      const sess = await request('session/new', { cwd: process.cwd(), mcpServers: [] })
      if (sess?.sessionId) {
        sessionId = sess.sessionId
        turns = 0
      }
    } catch {
      // ignore — a failed clear just leaves the old session in place
    }
  })
  queue = run.catch(() => {})
  return run
}

export function stopAcp() {
  const p = proc
  if (p?.pid) {
    try {
      // spawned with shell:true → kill the whole tree, otherwise the real
      // `gemini` node process orphans and stays loaded after switching engines
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

export function restartAcp() {
  stopAcp()
  return spawnProc()
}

// Send one chat turn and resolve { ok, text }. Serialized so concurrent sends
// never interleave on the single session. The getNotes tool-loop lives in
// chatLoop; acpSendOne just delivers one message to the live session.
export function askAcp({ messages, ctx }) {
  const userMsg = lastUserMessage(messages)
  const images = lastUserImages(messages)
  const run = queue.then(async () => {
    const isFresh = turns === 0
    const res = await chatLoop({ sendOne: acpSendOne, isFresh, ctx, userMsg, images })
    if (res?.ok) turns++ // count this user turn (whole loop = one turn)
    return res
  })
  queue = run.catch(() => {})
  return run
}

async function acpSendOne(text, images) {
  if (!proc) spawnProc()
  const ok = await ready
  if (!ok || !sessionId) {
    stopAcp() // handshake failed — drop the dead process so the next turn retries clean
    return { ok: false, text: '', error: 'gemini ACP session unavailable' }
  }
  chunks = []
  const prompt = [{ type: 'text', text }]
  for (const im of images || []) prompt.push({ type: 'image', mimeType: im.media_type, data: im.data })
  let res
  try {
    res = await Promise.race([
      request('session/prompt', { sessionId, prompt }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PROMPT_TIMEOUT))
    ])
  } catch {
    chunks = null
    restartAcp() // stuck/timed out — recycle the process
    return { ok: false, text: '', error: 'gemini ACP timed out' }
  }
  const out = (chunks || []).join('').trim()
  chunks = null
  if (res?.__error) return { ok: false, text: '', error: res.__error.message || 'ACP error' }
  if (out) return { ok: true, text: out }
  return { ok: false, text: '', error: 'empty response' }
}
