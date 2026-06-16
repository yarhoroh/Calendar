import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileSync, unlinkSync } from 'fs'
import { lastUserMessage } from './prompt'
import { chatLoop } from './chatLoop'

// Codex has no live-process chat protocol, but `codex exec resume --last`
// continues the previous session server-side, so we don't replay the whole
// conversation each turn. Still spawn-per-message and agentic — not instant.

const TIMEOUT = 180000
let started = false // a session exists → use resume
let seq = 0
let queue = Promise.resolve()

// next turn starts a fresh session (called on clear / engine switch)
export function resetCodex() {
  started = false
}

export function askCodex({ messages, ctx, model, reasoning }) {
  const userMsg = lastUserMessage(messages)
  const run = queue.then(() => {
    const isFresh = !started
    const sendOne = (text) => codexSendOne(text, model, reasoning)
    return chatLoop({ sendOne, isFresh, ctx, userMsg })
  })
  queue = run.catch(() => {})
  return run
}

function codexSendOne(prompt, model, reasoning) {
  const outFile = join(tmpdir(), `cal-codex-${process.pid}-${seq++}.txt`)
  // model + reasoning come from the user-editable ai-config.json (per-call, so
  // the user's global codex config is untouched).
  const fast = ['-m', model || 'gpt-5.4-mini', '-c', `model_reasoning_effort="${reasoning || 'low'}"`]
  // resume accepts -o / --skip-git-repo-check but NOT --sandbox/--color (those
  // are only on the initial exec; the resumed session keeps its read-only mode)
  const args = started
    ? ['exec', ...fast, 'resume', '--last', '--skip-git-repo-check', '-o', outFile, '-']
    : ['exec', ...fast, '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-o', outFile, '-']
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').trim()

  return new Promise((resolve) => {
    let err = ''
    let child
    try {
      child = spawn('codex', args, { shell: true, windowsHide: true })
    } catch (e) {
      resolve({ ok: false, text: '', error: e.message })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
    }, TIMEOUT)
    child.stderr?.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, text: '', error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let text = ''
      try {
        text = readFileSync(outFile, 'utf8')
        unlinkSync(outFile)
      } catch {
        // file missing → codex failed
      }
      text = strip(text)
      if (text) {
        started = true // session established → resume next time
        resolve({ ok: true, text })
      } else {
        resolve({ ok: false, text: '', error: strip(err) || `exit ${code}` })
      }
    })
    try {
      child.stdin.write(prompt)
      child.stdin.end()
    } catch {
      // ignore
    }
  })
}
