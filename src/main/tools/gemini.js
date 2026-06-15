import { exec } from 'child_process'
import { promisify } from 'util'

const run = promisify(exec)
const isWin = process.platform === 'win32'

// Detects whether the Gemini CLI is available on the machine.
// Returns { found, version, path }.
export async function detectGemini() {
  try {
    const { stdout } = await run('gemini --version', { timeout: 8000, windowsHide: true })
    const version = stdout.trim().split('\n').pop().trim()

    let path = ''
    try {
      const located = await run(isWin ? 'where gemini' : 'which gemini', {
        timeout: 5000,
        windowsHide: true
      })
      path = located.stdout.trim().split('\n')[0].trim()
    } catch {
      // version worked but locating the binary failed — not fatal
    }

    return { found: true, version, path }
  } catch {
    return { found: false, version: '', path: '' }
  }
}

// Installs the Gemini CLI globally via npm. Returns { ok, error }.
export async function installGemini() {
  try {
    await run('npm install -g @google/gemini-cli', { timeout: 180000, windowsHide: true })
    return { ok: true }
  } catch (e) {
    const error = (e.stderr || e.message || 'Unknown error').toString().trim().slice(0, 600)
    return { ok: false, error }
  }
}
