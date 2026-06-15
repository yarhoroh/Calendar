import { app } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync, unlinkSync } from 'fs'

// Embedded text-to-speech: bundled standalone piper.exe (no Python) synthesizes
// a WAV from text, which the renderer plays. The voice is chosen per language so
// the AI (or any external caller) can say which language a phrase is in.

function ttsRoot() {
  return app.isPackaged
    ? join(process.resourcesPath, 'tts')
    : join(app.getAppPath(), 'resources', 'tts')
}
const piperExe = () => join(ttsRoot(), 'piper', 'piper.exe')
const voicePath = (file) => join(ttsRoot(), 'voices', file)

// language -> { model, speaker }. ru/en are added once their voices ship; until
// then they fall back to whatever is available. Overridable from settings.
const DEFAULT_VOICES = {
  uk: { model: 'uk_UA-ukrainian_tts-medium.onnx', speaker: 2 },
  ru: { model: 'ru_RU-irina-medium.onnx', speaker: null },
  en: { model: 'en_US-amy-medium.onnx', speaker: null }
}

let resolveVoices = () => DEFAULT_VOICES
export function setVoiceResolver(fn) {
  if (typeof fn === 'function') resolveVoices = fn
}

let getMain = () => null
export function initTts(opts) {
  getMain = opts.getMain
}

let seq = 0

// Synthesize `text` in `lang`, resolving to the WAV bytes.
function synth(text, lang) {
  return new Promise((resolve, reject) => {
    const voices = resolveVoices() || DEFAULT_VOICES
    const v = voices[lang] || voices.uk || DEFAULT_VOICES.uk
    const model = voicePath(v.model)
    if (!existsSync(piperExe())) return reject(new Error('piper.exe missing'))
    if (!existsSync(model)) return reject(new Error(`voice missing: ${v.model}`))

    const out = join(app.getPath('temp'), `cal-tts-${process.pid}-${seq++}.wav`)
    const args = ['-m', model, '-f', out]
    if (v.speaker != null) args.push('--speaker', String(v.speaker))

    let child
    try {
      child = spawn(piperExe(), args, { windowsHide: true })
    } catch (e) {
      return reject(e)
    }
    child.stderr?.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 && existsSync(out)) {
        try {
          const buf = readFileSync(out)
          unlinkSync(out)
          resolve(buf)
        } catch (e) {
          reject(e)
        }
      } else {
        reject(new Error(`piper exit ${code}`))
      }
    })
    try {
      child.stdin.write(text)
      child.stdin.end()
    } catch (e) {
      reject(e)
    }
  })
}

// Speak text aloud. Returns { ok, error }. New speech interrupts the previous
// one (the renderer stops the current clip when a new one arrives).
export async function speak({ text, lang } = {}) {
  const t = (text || '').trim()
  if (!t) return { ok: false, error: 'empty text' }
  try {
    const wav = await synth(t, lang || 'uk')
    getMain()?.webContents?.send('tts:play', { id: ++seq, wav: wav.toString('base64') })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
