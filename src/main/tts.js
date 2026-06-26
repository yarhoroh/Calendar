import { app } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { accentuate } from './stress'
import { numbersToWords } from './numbers'

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

// which engine to speak with: 'piper' (bundled, offline) or 'windows' (system SAPI)
let resolveEngine = () => 'piper'
export function setTtsEngine(fn) {
  if (typeof fn === 'function') resolveEngine = fn
}

// selected Supertonic voice preset (F1..F5 / M1..M5), overridable from settings
let resolveSupertonicVoice = () => 'F1'
export function setSupertonicVoice(fn) {
  if (typeof fn === 'function') resolveSupertonicVoice = fn
}

// piper Ukrainian speaker (the only multi-speaker built-in model): 0=lada 1=mykyta 2=tetiana
let resolvePiperVoice = () => 2
export function setPiperVoice(fn) {
  if (typeof fn === 'function') resolvePiperVoice = fn
}

// per-engine speech speed multiplier (1 = normal); resolveSpeed('piper'|'windows'|'supertonic')
let resolveSpeed = () => 1
export function setSpeedResolver(fn) {
  if (typeof fn === 'function') resolveSpeed = fn
}

let seq = 0

// Synthesize with the built-in Windows voices (System.Speech / SAPI) to a WAV,
// so it plays through the same renderer path as Piper (interruption, queue).
// preferred voice cultures per language, with fallbacks. uk has no system voice
// on most machines → fall back to the Russian voice (Cyrillic, intelligible)
// rather than an English one that can't read it.
const CULTURES = { uk: ['uk-UA', 'ru-RU'], ru: ['ru-RU'], en: ['en-US', 'en-GB'] }
function synthWindows(text, lang) {
  return new Promise((resolve, reject) => {
    const out = join(app.getPath('temp'), `cal-tts-${process.pid}-${seq++}.wav`)
    const txt = join(app.getPath('temp'), `cal-tts-${process.pid}-${seq++}.txt`)
    const cultures = CULTURES[lang] || CULTURES.uk
    const psList = cultures.map((c) => `'${c}'`).join(',')
    try {
      writeFileSync(txt, text, 'utf8')
    } catch (e) {
      return reject(e)
    }
    // SAPI rate is -10..10; map the speed multiplier (1 = normal) onto it
    const rate = Math.max(-10, Math.min(10, Math.round((resolveSpeed('windows') - 1) * 10)))
    // single-quoted PS strings are literal — raw Windows paths need no escaping.
    // Try each preferred culture; keep the first that an installed voice matches.
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$s.Rate = ${rate}`,
      `foreach ($c in @(${psList})) { try { $s.SelectVoiceByHints('NotSet','NotSet',0,(New-Object System.Globalization.CultureInfo($c))) } catch {}; if ($s.Voice.Culture.Name -eq $c) { break } }`,
      `$s.SetOutputToWaveFile('${out}')`,
      `$t = [System.IO.File]::ReadAllText('${txt}', [System.Text.Encoding]::UTF8)`,
      '$s.Speak($t)',
      '$s.Dispose()'
    ].join('\n')

    const done = (err, buf) => {
      try {
        unlinkSync(txt)
      } catch {
        // ignore
      }
      err ? reject(err) : resolve(buf)
    }

    let child
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true
      })
    } catch (e) {
      return done(e)
    }
    child.stderr?.on('data', () => {})
    child.on('error', done)
    child.on('close', (code) => {
      if (existsSync(out)) {
        try {
          const buf = readFileSync(out)
          unlinkSync(out)
          done(null, buf)
        } catch (e) {
          done(e)
        }
      } else {
        done(new Error(`windows tts exit ${code}`))
      }
    })
  })
}

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
    // uk is the only multi-speaker built-in model → let the user pick its voice
    const speaker = lang === 'uk' ? resolvePiperVoice() : v.speaker
    if (speaker != null) args.push('--speaker', String(speaker))
    const speed = resolveSpeed('piper') // length_scale is inverse: higher speed → shorter phonemes
    if (speed && speed !== 1) args.push('--length_scale', String((1 / speed).toFixed(3)))

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

// Synthesize `text` in `lang` and RETURN the WAV (base64). Serialized through a single
// chain so overlapping callers (the article reader feeding the queue, /speak, Telegram,
// the AI) never run the Supertonic ONNX sessions concurrently — concurrent runs corrupt
// the output. Order is preserved (FIFO), keeping the article's paragraphs in order too.
let synthChain = Promise.resolve()
export function synthesize(args = {}) {
  const run = synthChain.then(() => doSynthesize(args))
  synthChain = run.catch(() => {}) // keep the chain alive even if one synth fails
  return run
}

async function doSynthesize({ text, lang } = {}) {
  const raw = (text || '').trim()
  if (!raw) return { ok: false, error: 'empty text' }
  const t = numbersToWords(raw, lang || 'uk') // spell out digits for every engine
  try {
    const engine = resolveEngine?.() || 'piper'
    if (engine === 'supertonic') {
      // lazy import so onnxruntime-node loads only when this engine is actually used
      const { synthSupertonic } = await import('./supertonic/synth.js')
      const marked = accentuate(t, lang || 'en') // add ru/uk stress marks for correct prosody
      const wav = await synthSupertonic(marked, lang || 'en', resolveSupertonicVoice(), resolveSpeed('supertonic'))
      return { ok: true, wav: wav.toString('base64') }
    }
    const wav = engine === 'windows' ? await synthWindows(t, lang || 'uk') : await synth(t, lang || 'uk')
    return { ok: true, wav: wav.toString('base64') }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// Speak text aloud. Returns { ok, error }. New speech interrupts the previous
// one (the renderer stops the current clip when a new one arrives).
export async function speak({ text, lang } = {}) {
  const r = await synthesize({ text, lang })
  if (!r.ok) return r
  getMain()?.webContents?.send('tts:play', { id: ++seq, wav: r.wav })
  return { ok: true }
}
