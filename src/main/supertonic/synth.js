import { join } from 'path'
import * as ort from 'onnxruntime-node'
import { loadTextToSpeech, loadVoiceStyle } from './helper.js'
import { assetsDir, isReady } from './download.js'
import { toSupertonicLang } from './langs.js'

// Native Supertonic inference (onnxruntime-node). Lazy-loaded by tts.js only when the
// engine is actually 'supertonic', so the native lib isn't pulled in at startup.

let ttsCache = null // loaded TextToSpeech (4 ONNX sessions) — kept warm after first use
const styleCache = new Map() // voice id → loaded style
let providersLog = ''

// best-effort GPU: probe DirectML (bundled on Windows) then CUDA on the smallest
// model; fall back to CPU. DML is tried first because this onnxruntime-node build
// ships DirectML but not CUDA. (Vulkan is not an onnxruntime EP, so it can't be here.)
async function pickProviders() {
  const probe = join(assetsDir(), 'onnx', 'duration_predictor.onnx')
  for (const ep of ['dml', 'cuda']) {
    try {
      const s = await ort.InferenceSession.create(probe, { executionProviders: [ep] })
      await s.release?.()
      return [ep, 'cpu']
    } catch {
      /* provider not available in this build */
    }
  }
  return ['cpu']
}

async function getTts() {
  if (ttsCache) return ttsCache
  const providers = await pickProviders()
  providersLog = providers.join(',')
  console.log('[supertonic] execution providers:', providersLog) // GPU (dml/cuda) or cpu
  ttsCache = await loadTextToSpeech(join(assetsDir(), 'onnx'), { executionProviders: providers })
  return ttsCache
}

const VOICES = new Set(['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'])
function getStyle(voice) {
  const v = VOICES.has(voice) ? voice : 'F1' // all 10 presets are downloaded
  if (!styleCache.has(v)) styleCache.set(v, loadVoiceStyle([join(assetsDir(), 'voice_styles', v + '.json')], false))
  return styleCache.get(v)
}

// raw float samples → 16-bit PCM mono WAV Buffer (same format as helper.writeWavFile)
function wavToBuffer(audioData, sampleRate) {
  const dataSize = audioData.length * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < audioData.length; i++) {
    const s = Math.max(-1, Math.min(1, audioData[i]))
    buf.writeInt16LE(Math.floor(s * 32767), 44 + i * 2)
  }
  return buf
}

// Synthesize `text` in `langCode` with `voice` at `speed` → WAV Buffer. Throws if not downloaded.
export async function synthSupertonic(text, langCode, voice, speed) {
  if (!isReady()) throw new Error('Supertonic model not downloaded')
  const tts = await getTts()
  const style = getStyle(voice)
  const { wav, duration } = await tts.call(text, toSupertonicLang(langCode), style, 8, speed || 1.05)
  const len = Math.min(wav.length, Math.floor(tts.sampleRate * duration[0]))
  return wavToBuffer(wav.slice(0, len), tts.sampleRate)
}

export function supertonicProviders() {
  return providersLog
}
