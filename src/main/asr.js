import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync, createWriteStream, createReadStream } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import bz2 from 'unbzip2-stream'
import tarStream from 'tar-stream'

// Local offline speech-to-text via sherpa-onnx. Models are downloaded at runtime
// into userData (NOT bundled in the installer): a small ru zipformer and the
// whisper-tiny.en for English. Only the int8 files are kept (~27–40 MB).

const require = createRequire(import.meta.url)
let sherpaMod = null
function sherpa() {
  if (!sherpaMod) sherpaMod = require('sherpa-onnx-node') // lazy: a load failure stays contained
  return sherpaMod
}

const REL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models'
export const ASR_LANGS = {
  ru: { label: 'Русский', url: `${REL}/sherpa-onnx-small-zipformer-ru-2024-09-18.tar.bz2`, mb: 105 },
  en: { label: 'English', url: `${REL}/sherpa-onnx-whisper-tiny.en.tar.bz2`, mb: 118 }
}

function langDir(lang) {
  return join(app.getPath('userData'), 'asr', lang) // download target
}
function findIn(dir, re) {
  if (!existsSync(dir)) return null
  const f = readdirSync(dir).find((x) => re.test(x))
  return f ? join(dir, f) : null
}
// where the model actually lives: downloaded copy in userData, or (in dev) a
// local copy under the project's resources/asr (which is NOT shipped)
function readDir(lang) {
  const ud = langDir(lang)
  if (findIn(ud, /encoder\.int8\.onnx$/)) return ud
  const dev = join(process.cwd(), 'resources', 'asr', lang)
  if (findIn(dev, /encoder\.int8\.onnx$/)) return dev
  return ud
}

// a model is ready if its int8 encoder + tokens are present
export function asrModelReady(lang) {
  const d = readDir(lang)
  return !!findIn(d, /encoder\.int8\.onnx$/) && !!findIn(d, /tokens\.txt$/)
}

export function asrStatus() {
  return Object.fromEntries(
    Object.entries(ASR_LANGS).map(([k, v]) => [k, { label: v.label, mb: v.mb, ready: asrModelReady(k) }])
  )
}

// download the model tarball (with progress 0..1), extract only the int8 files
export async function downloadAsrModel(lang, onProgress) {
  const m = ASR_LANGS[lang]
  if (!m) throw new Error('unknown asr language')
  const dir = langDir(lang)
  mkdirSync(dir, { recursive: true })
  const tmp = join(app.getPath('temp'), `asr-${lang}-${Date.now()}.tar.bz2`)
  const res = await fetch(m.url)
  if (!res.ok) throw new Error(`download failed (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let recv = 0
  const ws = createWriteStream(tmp)
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    recv += value.length
    ws.write(Buffer.from(value))
    if (total) onProgress?.(recv / total)
  }
  await new Promise((r) => ws.end(r))
  await extractInt8(tmp, dir)
  try {
    rmSync(tmp, { force: true })
  } catch {
    // ignore
  }
  return asrModelReady(lang)
}

// extract the .tar.bz2 entirely in JS — a plain Windows install may have no
// `tar` at all, so we decompress (unbzip2-stream) and untar (tar-stream)
// ourselves. We flatten the top folder and write ONLY the int8 onnx files +
// tokens.txt (skipping the heavy fp32 .onnx and sample wavs), so there is no
// post-cleanup to do.
function extractInt8(tarPath, dir) {
  return new Promise((resolve, reject) => {
    const ex = tarStream.extract()
    ex.on('entry', (header, stream, next) => {
      const base = (header.name || '').split('/').pop()
      const keep = header.type === 'file' && (/\.int8\.onnx$/.test(base) || /tokens\.txt$/.test(base))
      if (keep) {
        const out = createWriteStream(join(dir, base))
        out.on('error', reject)
        out.on('finish', next)
        stream.pipe(out)
      } else {
        stream.on('end', next)
        stream.resume() // drain & skip this entry
      }
    })
    ex.on('finish', resolve)
    ex.on('error', reject)
    createReadStream(tarPath).on('error', reject).pipe(bz2()).on('error', reject).pipe(ex)
  })
}

const recognizers = {}
function recognizer(lang) {
  if (recognizers[lang]) return recognizers[lang]
  const dir = readDir(lang)
  const encoder = findIn(dir, /encoder\.int8\.onnx$/)
  const decoder = findIn(dir, /decoder\.int8\.onnx$/)
  const joiner = findIn(dir, /joiner\.int8\.onnx$/)
  const tokens = findIn(dir, /tokens\.txt$/)
  if (!encoder || !tokens) throw new Error('asr model not downloaded')
  const modelConfig = { tokens, numThreads: 1, provider: 'cpu', debug: 0 }
  if (joiner) modelConfig.transducer = { encoder, decoder, joiner }
  else modelConfig.whisper = { encoder, decoder } // whisper has no joiner
  const r = new (sherpa().OfflineRecognizer)({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig })
  recognizers[lang] = r
  return r
}

// transcribe 16kHz mono Float32 samples → text
export function transcribe(lang, samples) {
  const r = recognizer(lang)
  const stream = r.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  r.decode(stream)
  return (r.getResult(stream).text || '').trim()
}
