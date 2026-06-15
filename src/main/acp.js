import { spawn } from 'child_process'
import { buildSystem, buildRefresh, lastUserMessage } from './prompt'

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
  proc = spawn('gemini', ['--acp'], {
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
      if (sess?.sessionId) {
        sessionId = sess.sessionId
        turns = 0
        return true
      }
      return false
    } catch {
      return false
    }
  })()
  return ready
}

// Ensure the agent is running and warmed up. Returns true once a session is live.
export function warmAcp() {
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
  try {
    proc?.kill()
  } catch {
    // ignore
  }
  cleanup()
}

export function restartAcp() {
  stopAcp()
  return spawnProc()
}

// Send one chat turn and resolve { ok, text }. Serialized so concurrent sends
// never interleave on the single session.
export function askAcp({ messages, ctx }) {
  const userMsg = lastUserMessage(messages)
  const run = queue.then(() => doAsk(userMsg, ctx))
  queue = run.catch(() => {})
  return run
}

async function doAsk(userMsg, ctx) {
  if (!proc) spawnProc()
  const ok = await ready
  if (!ok || !sessionId) {
    // handshake failed — drop the dead process so the next turn retries clean
    stopAcp()
    return { ok: false, text: '', error: 'gemini ACP session unavailable' }
  }

  const head = turns === 0 ? buildSystem(ctx) : buildRefresh(ctx)
  chunks = []
  let res
  try {
    res = await Promise.race([
      request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${head}\n\n${userMsg}` }] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PROMPT_TIMEOUT))
    ])
  } catch {
    chunks = null
    restartAcp() // stuck/timed out — recycle the process
    return { ok: false, text: '', error: 'gemini ACP timed out' }
  }

  const text = (chunks || []).join('').trim()
  chunks = null
  if (res?.__error) return { ok: false, text: '', error: res.__error.message || 'ACP error' }
  turns++
  if (text) return { ok: true, text }
  return { ok: false, text: '', error: 'empty response' }
}
