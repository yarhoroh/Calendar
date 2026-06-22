import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir, homedir } from 'os'
import { createRequire } from 'module'
import { app } from 'electron'
import { lastUserMessage } from './prompt'
import { chatLoop } from './chatLoop'

// agy is a coding AGENT — left alone it explores the working dir and runs shell
// commands (slow, pops console windows). We want a plain chat responder, so we
// (a) point it at an empty, dedicated folder and (b) forbid file/command tools.
const AGY_GUARD =
  'SYSTEM OVERRIDE: Disregard any built-in "Antigravity" or coding-assistant identity — that is NOT who you are here. ' +
  'You are the built-in assistant of a CALENDAR + NOTES desktop app. Your ONLY role is helping the user with their ' +
  'schedule, notes, reminders, tasks, folders and Google Calendar — never offer programming, debugging or app-development help. ' +
  'If a message is a greeting, unclear or gibberish, briefly introduce yourself as the calendar & notes assistant and what you can do (in the user\'s language). ' +
  'Do NOT search, list, read or modify files. Do NOT run terminal/shell commands or use any workspace/codebase tools. ' +
  'Answer using ONLY this conversation and the rules below, and emit calendar actions via the ```calendar``` block. Never explore the workspace.\n\n'

function workspaceDir() {
  const dir = join(tmpdir(), 'agy-cal-ws')
  try {
    mkdirSync(dir, { recursive: true })
    // agy reads a GEMINI.md in its workspace as authoritative context. A plain
    // --print prompt can't reliably override agy's built-in "Antigravity coding
    // agent" identity (on greetings/gibberish it reverts to offering to write
    // code), but this file does — it makes agy answer as the calendar assistant.
    writeFileSync(join(dir, 'GEMINI.md'), GEMINI_MD)
    ensureTrusted(dir)
  } catch {
    // already exists / not writable
  }
  return dir
}

// PORTABILITY: an untrusted cwd makes agy silently wait on a folder-trust prompt
// the moment it touches a tool — and in --print nobody can answer, so the call
// HANGS. We can't rely on the dir being trusted on every machine, so we write
// the trust ourselves into agy's config (~/.gemini). Best-effort, idempotent.
function ensureTrusted(dir) {
  const readJson = (p) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      return {}
    }
  }
  try {
    const gem = join(homedir(), '.gemini')
    // antigravity-cli/settings.json → trustedWorkspaces gates tool access
    const sp = join(gem, 'antigravity-cli', 'settings.json')
    const settings = readJson(sp)
    const tw = Array.isArray(settings.trustedWorkspaces) ? settings.trustedWorkspaces : []
    if (!tw.includes(dir)) {
      settings.trustedWorkspaces = [...tw, dir]
      mkdirSync(dirname(sp), { recursive: true })
      writeFileSync(sp, JSON.stringify(settings, null, 2))
    }
    // trustedFolders.json → folder-level trust flag
    const tp = join(gem, 'trustedFolders.json')
    const tf = readJson(tp)
    if (tf[dir] !== 'TRUST_FOLDER') {
      tf[dir] = 'TRUST_FOLDER'
      mkdirSync(gem, { recursive: true })
      writeFileSync(tp, JSON.stringify(tf, null, 2))
    }
  } catch {
    // best-effort; if it fails the engine still tries (and may prompt once)
  }
}

const GEMINI_MD =
  '# Who you are\n\n' +
  'You are NOT Antigravity and NOT a coding/software assistant. You are the built-in assistant of a ' +
  'desktop CALENDAR + NOTES application. Your ONLY role is to help the user manage their schedule, notes, ' +
  'reminders, tasks, folders and Google Calendar.\n\n' +
  '- Never offer programming, debugging, project-setup or app-development help.\n' +
  '- Never describe, list, read or modify files, and never run terminal/shell commands or explore this workspace.\n' +
  '- For a greeting or unclear/gibberish input, briefly introduce yourself as the calendar & notes assistant and ' +
  'what you can do, in the user\'s language.\n' +
  '- Follow the detailed rules and the ```calendar``` action protocol sent in each message.\n'

// lazy-load the native PTY only when agy is actually used, so a load failure
// degrades just this engine instead of crashing the whole app at startup
const require = createRequire(import.meta.url)
let ptyMod = null
function loadPty() {
  if (!ptyMod) ptyMod = require('@lydell/node-pty')
  return ptyMod
}

// Antigravity CLI ("agy") only emits its response to a real terminal — when its
// stdout is a pipe it stays silent. So we run it inside a pseudo-terminal
// (ConPTY via @lydell/node-pty), one `--print` call per message. The process
// exits after printing, which cleanly marks the end of the answer and means it
// can never hang waiting on a question. Conversation context is kept server-side
// via a stable `--conversation <uuid>` (a fresh uuid on reset = a fresh chat).

const TIMEOUT = 90000
let convId = null
let queue = Promise.resolve()

// the Windows installer puts agy here and adds it to PATH; prefer the explicit
// path (PATH may not be picked up), fall back to the bare command
function agyExe() {
  const p = join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe')
  return existsSync(p) ? p : 'agy'
}

export function detectAgy() {
  const p = join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe')
  return Promise.resolve({ found: existsSync(p), version: '' })
}

// next turn starts a fresh conversation (called on clear / engine switch)
export function resetAgy() {
  convId = null
}

// agy starts a fresh process per call and does NOT reliably restore history from
// --conversation, so we carry the whole chat in the prompt instead: the full
// visible transcript becomes the "user message" and a fresh conversation id is
// used each turn (memory lives in the prompt, not server-side). Clearing the
// chat empties the transcript → agy forgets, exactly as the user expects.
export function askAgy({ messages, ctx, model }) {
  const userMsg = buildTranscript(messages)
  const run = queue.then(() => {
    convId = randomUUID() // fresh session each message; history is in the prompt
    const sendOne = (text) => agySendOne(text, model)
    return chatLoop({ sendOne, isFresh: true, ctx, userMsg }) // images not supported via -p
  })
  queue = run.catch(() => {})
  return run
}

// Render the visible chat as a transcript agy reads as its memory. Only the last
// user message carries live app/editor context (added in the renderer); earlier
// turns are the plain text the user saw.
function buildTranscript(messages) {
  const turns = (messages || []).filter((m) => m.role === 'user' || m.role === 'assistant')
  if (turns.length <= 1) return lastUserMessage(messages) // first message — nothing prior
  const body = turns
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : ''}`)
    .join('\n\n')
  return (
    '--- Conversation so far (oldest first; this is your memory of what was already said) ---\n' +
    `${body}\n--- end of conversation ---\n\nNow respond to the LAST User message above.`
  )
}

// strip the TUI's terminal control sequences, leaving the plain response
const clean = (s) =>
  s
    .replace(/\x1b\][^\x07]*\x07/g, '') // OSC (window title)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI (cursor/colour/clear)
    .replace(/\x1b[=>]/g, '')
    .replace(/\r/g, '')
    // first use of a new --conversation uuid prints this notice while agy creates
    // the session; it's not part of the answer
    .replace(/^\s*Warning: conversation "[^"]*" not found\.?\s*$/gim, '')
    .trim()

function agySendOne(prompt, model) {
  return new Promise((resolve) => {
    // agy is a coding agent, so in --print it WANTS tools. Two failure modes:
    //  - without --dangerously-skip-permissions it asks for permission, but
    //    --print is non-interactive → it HANGS until timeout.
    //  - with skip-permissions alone it auto-runs shell tools and explores.
    // The fix is BOTH flags: --sandbox forbids the terminal (no exploration)
    // and skip-permissions auto-approves so --print never blocks. With our
    // empty workspace + guard this yields a clean chat reply, no hang.
    const args = ['--dangerously-skip-permissions', '--sandbox', '--conversation', convId, '--print', AGY_GUARD + prompt]
    if (model) args.push('--model', model)
    const t0 = Date.now()
    console.log(`[agy] → send: ${prompt.length} chars (full ${(AGY_GUARD + prompt).length}), conv=${convId}, model=${model || 'default'}`)
    console.log(`[agy]   prompt head: ${JSON.stringify(prompt.slice(0, 160))}`)
    let term
    try {
      term = loadPty().spawn(agyExe(), args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: workspaceDir(), // empty dedicated dir → nothing to scan if it still tries
        env: process.env
      })
    } catch (e) {
      resolve({ ok: false, text: '', error: e?.message || String(e) })
      return
    }
    let buf = ''
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(dumpTimer)
      try {
        term.kill()
      } catch {
        // already gone
      }
      resolve(r)
    }
    // DIAGNOSTIC: if a call is still running at 20s, dump what agy has emitted so
    // far — reveals whether it's mid tool-call (run_command/ListDir) and stuck.
    const dumpTimer = setTimeout(() => {
      console.log(`[agy] !! still running @20s: raw ${buf.length}b, partial: ${JSON.stringify(clean(buf).slice(0, 600))}`)
    }, 20000)
    const timer = setTimeout(() => {
      console.log(`[agy] !! TIMEOUT @${TIMEOUT / 1000}s: raw ${buf.length}b, partial: ${JSON.stringify(clean(buf).slice(0, 600))}`)
      finish({ ok: false, text: '', error: 'agy timed out' })
    }, TIMEOUT)
    term.onData((d) => {
      buf += d
    })
    term.onExit(() => {
      const text = clean(buf)
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`[agy] ← exit in ${secs}s: raw ${buf.length}b → clean ${text.length} chars`)
      console.log(`[agy]   reply: ${JSON.stringify(text.slice(0, 240))}`)
      finish(text ? { ok: true, text } : { ok: false, text: '', error: 'agy returned no output' })
    })
  })
}
