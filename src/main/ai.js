import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { buildFullPrompt } from './prompt'

const run = promisify(exec)

// Detect the Claude CLI (mirrors the Gemini detector).
export async function detectClaude() {
  try {
    const { stdout } = await run('claude --version', { timeout: 8000, windowsHide: true })
    return { found: true, version: stdout.trim().split('\n').pop().trim() }
  } catch {
    return { found: false, version: '' }
  }
}

const CMD = { gemini: 'gemini', claude: 'claude' }

// Spawn the CLI once (cheap --version) at startup / engine switch so the node
// runtime and binary are warm in the OS cache and the first real reply is fast.
// Resolves true once the CLI responded (i.e. it exists and is ready to use).
export function warmUp(cli) {
  const cmd = CMD[cli] || 'gemini'
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, ['--version'], { shell: true, windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

// One-shot headless run (used for claude). gemini uses the persistent ACP
// session in acp.js instead. Feeds the prompt via stdin to avoid shell escaping.
export function runAgent({ cli, messages, ctx }) {
  const cmd = CMD[cli] || 'gemini'
  const args = cli === 'claude' ? ['-p'] : ['--skip-trust']
  const prompt = buildFullPrompt(messages, ctx)
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').trim()

  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(cmd, args, {
        shell: true,
        windowsHide: true,
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
      })
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
    }, 120000)

    child.stdout?.on('data', (d) => (out += d.toString()))
    child.stderr?.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, text: '', error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = strip(out)
      if (text) resolve({ ok: true, text })
      else resolve({ ok: false, text: '', error: strip(err) || `exit code ${code}` })
    })
    try {
      child.stdin.write(prompt)
      child.stdin.end()
    } catch {
      // ignore
    }
  })
}
