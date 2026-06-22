import { spawn, exec } from 'child_process'
import { promisify } from 'util'

const run = promisify(exec)

async function detect(cmd) {
  try {
    const { stdout } = await run(`${cmd} --version`, { timeout: 8000, windowsHide: true })
    return { found: true, version: stdout.trim().split('\n').pop().trim() }
  } catch {
    return { found: false, version: '' }
  }
}
export const detectClaude = () => detect('claude')
export const detectCodex = () => detect('codex')

const CMD = { claude: 'claude', codex: 'codex' }

// Spawn the CLI once (cheap --version) at startup / engine switch so the node
// runtime and binary are warm in the OS cache. Resolves true if the CLI exists.
// (claude → claudeAgent.js, codex → codex.js, agy → agy.js handle the chat.)
export function warmUp(cli) {
  const cmd = CMD[cli] || 'codex'
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
