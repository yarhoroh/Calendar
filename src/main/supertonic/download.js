import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'

// Downloads the Supertonic-3 assets (one multilingual model, ~380 MB) from Hugging
// Face into userData on first use, reporting progress. No onnxruntime import here so
// the status/download IPC never loads the native lib.

const REPO = 'Supertone/supertonic-3'
const BASE = `https://huggingface.co/${REPO}/resolve/main/`
const VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5']

// everything needed for inference (the 4 onnx models + config + tokenizer + voices)
export const ASSET_FILES = [
  'onnx/tts.json',
  'onnx/unicode_indexer.json',
  'onnx/duration_predictor.onnx',
  'onnx/text_encoder.onnx',
  'onnx/vocoder.onnx',
  'onnx/vector_estimator.onnx',
  ...VOICES.map((v) => `voice_styles/${v}.json`)
]

export function assetsDir() {
  return join(app.getPath('userData'), 'supertonic')
}
const filePath = (rel) => join(assetsDir(), rel)

export function isReady() {
  return ASSET_FILES.every((f) => existsSync(filePath(f)))
}

// per-file sizes from the HF API → a real total for the progress percentage
async function fileSizes() {
  try {
    const r = await fetch(`https://huggingface.co/api/models/${REPO}/tree/main?recursive=true`)
    const list = await r.json()
    const map = {}
    for (const e of list) map[e.path] = e.size != null ? e.size : e.lfs?.size || 0
    return map
  } catch {
    return {}
  }
}

// download every missing file, streaming to a .part then renaming on completion
export async function downloadAssets(onProgress) {
  mkdirSync(assetsDir(), { recursive: true })
  const sizes = await fileSizes()
  const todo = ASSET_FILES.filter((f) => !existsSync(filePath(f)))
  if (!todo.length) return
  const total = todo.reduce((s, f) => s + (sizes[f] || 0), 0) || 1
  let done = 0
  for (const rel of todo) {
    const dest = filePath(rel)
    mkdirSync(dirname(dest), { recursive: true })
    const tmp = dest + '.part'
    const res = await fetch(BASE + rel)
    if (!res.ok || !res.body) throw new Error(`download ${rel}: HTTP ${res.status}`)
    const out = createWriteStream(tmp)
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done: d, value } = await reader.read()
        if (d) break
        await new Promise((ok, no) => out.write(Buffer.from(value), (e) => (e ? no(e) : ok())))
        done += value.length
        onProgress?.(Math.min(0.999, done / total))
      }
    } finally {
      await new Promise((ok) => out.end(ok))
    }
    renameSync(tmp, dest)
  }
  onProgress?.(1)
}

// ---- download state machine (drives the settings UI) ----
let state = { status: 'absent', progress: 0, error: '' } // absent | downloading | ready | error
let inFlight = null
let notify = () => {}

export function initSupertonicDownload({ onState } = {}) {
  if (onState) notify = onState
}

export function getSupertonicStatus() {
  if (state.status === 'absent' && isReady()) state = { status: 'ready', progress: 1, error: '' }
  return { ...state }
}

export function startSupertonicDownload() {
  if (getSupertonicStatus().status === 'ready' || inFlight) return getSupertonicStatus()
  state = { status: 'downloading', progress: 0, error: '' }
  notify(getSupertonicStatus())
  inFlight = downloadAssets((p) => {
    state.progress = p
    notify(getSupertonicStatus())
  })
    .then(() => {
      state = { status: 'ready', progress: 1, error: '' }
    })
    .catch((e) => {
      state = { status: 'error', progress: state.progress, error: e.message }
    })
    .finally(() => {
      inFlight = null
      notify(getSupertonicStatus())
    })
  return getSupertonicStatus()
}
