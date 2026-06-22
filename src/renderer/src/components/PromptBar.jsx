import { useEffect, useRef, useState } from 'react'
import api from '../lib/api'
import { useI18n } from '../i18n/I18nContext'
import { useAutosizeTextarea } from '../hooks/useAutosizeTextarea'
import { useAiStatus } from '../hooks/useAiStatus'
import { SendIcon, MicIcon } from './icons'
import './PromptBar.css'

// decode a recorded audio Blob (webm/opus) to the 16kHz mono Float32 the local
// ASR model expects (the renderer can decode audio; the main process can't)
const decodeTo16kMono = async (arrayBuffer) => {
  const Ac = window.AudioContext || window.webkitAudioContext
  const ac = new Ac()
  const decoded = await ac.decodeAudioData(arrayBuffer)
  ac.close()
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const rendered = await off.startRendering()
  return rendered.getChannelData(0)
}

// Read an image File/Blob into the { media_type, data } shape the AI expects.
const fileToImage = (file) =>
  new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => {
      const [head, data] = String(r.result).split(',')
      resolve({ media_type: head.match(/data:(.*?);/)?.[1] || 'image/png', data, name: file.name || 'image' })
    }
    r.readAsDataURL(file)
  })

// Chat input. Enter sends, Ctrl+Enter inserts a new line. Sending is handled by
// the parent (useChat); while a reply is pending the send button is disabled.
export default function PromptBar({ onSend, busy }) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [images, setImages] = useState([])
  const [dragging, setDragging] = useState(false)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [asr, setAsr] = useState({ enabled: false, lang: 'ru', ready: false })
  const recRef = useRef(null) // MediaRecorder
  const chunksRef = useRef([])
  const fileRef = useRef(null)

  // local voice input availability (Settings toggle + downloaded model)
  useEffect(() => {
    let alive = true
    const load = async () => {
      const cfg = (await api.asr?.getConfig?.()) || { enabled: false, lang: 'ru' }
      const st = (await api.asr?.status?.()) || {}
      if (alive) setAsr({ enabled: !!cfg.enabled, lang: cfg.lang || 'ru', ready: !!st[cfg.lang || 'ru']?.ready })
    }
    load()
    return api.asr?.onChanged?.(load)
  }, [])
  const ref = useAutosizeTextarea(text, 8)
  const { state, cli, model } = useAiStatus()
  const statusLabel =
    state === 'ready' ? t('chat.ready') : state === 'offline' ? t('chat.offline') : t('chat.starting')
  const cliLabel = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' }[cli] || 'Antigravity'
  const modelLabel = model && model !== 'default' && model !== 'auto' ? ` · ${model}` : ''

  const canSend = (text.trim().length > 0 || images.length > 0) && !busy

  const addFiles = async (files) => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    const loaded = await Promise.all(imgs.map(fileToImage))
    setImages((prev) => [...prev, ...loaded])
  }

  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean)
    if (files.length) {
      e.preventDefault()
      addFiles(files)
    }
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
  }

  const onDragOver = (e) => {
    if ([...(e.dataTransfer?.items || [])].some((it) => it.kind === 'file')) {
      e.preventDefault()
      setDragging(true)
    }
  }

  const submit = () => {
    if (!canSend) return
    onSend(text, images)
    setText('')
    setImages([])
  }

  // push-to-talk: hold the mic to record, release to transcribe + insert text
  const startRec = async () => {
    if (recording || transcribing) return
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return // mic denied / unavailable
    }
    const mr = new MediaRecorder(stream)
    chunksRef.current = []
    mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data)
    mr.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop())
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
      if (blob.size < 1200) return // too short → ignore
      setTranscribing(true)
      try {
        const samples = await decodeTo16kMono(await blob.arrayBuffer())
        const r = await api.asr?.transcribe?.(asr.lang, samples)
        if (r?.ok && r.text) insertAtCursor(r.text.trim())
      } finally {
        setTranscribing(false)
      }
    }
    recRef.current = mr
    mr.start()
    setRecording(true)
  }
  const stopRec = () => {
    if (!recording) return
    setRecording(false)
    try {
      recRef.current?.stop()
    } catch {
      // already stopped
    }
  }

  const insertNewline = () => {
    const el = ref.current
    const start = el.selectionStart
    const end = el.selectionEnd
    setText((prev) => prev.slice(0, start) + '\n' + prev.slice(end))
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 1
    })
  }

  // insert text at the caret (used by voice input); falls back to append
  const insertAtCursor = (str) => {
    const el = ref.current
    if (!el || el.selectionStart == null) {
      setText((p) => p + str)
      return
    }
    const start = el.selectionStart
    const end = el.selectionEnd
    setText((prev) => prev.slice(0, start) + str + prev.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = start + str.length
    })
  }

  const onKeyDown = (e) => {
    if (e.key !== 'Enter') return
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      insertNewline()
    } else if (!e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="promptbar">
      {images.length > 0 && (
        <div className="promptbar__thumbs">
          {images.map((im, i) => (
            <div key={i} className="promptbar__thumb">
              <img src={`data:${im.media_type};base64,${im.data}`} alt={im.name} />
              <button
                className="promptbar__thumb-x"
                title={t('prompt.removeImage')}
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`promptbar__box${dragging ? ' promptbar__box--drag' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
      >
        <button
          className="promptbar__attach"
          title={t('prompt.attachImage')}
          onClick={() => fileRef.current?.click()}
        >
          +
        </button>
        {asr.enabled && asr.ready && (
          <button
            className={'promptbar__attach promptbar__mic' + (recording ? ' promptbar__mic--rec' : '')}
            title={recording ? t('prompt.recording') : transcribing ? t('prompt.transcribing') : t('prompt.mic')}
            disabled={transcribing}
            onPointerDown={(e) => {
              e.preventDefault()
              startRec()
            }}
            onPointerUp={stopRec}
            onPointerLeave={stopRec}
          >
            <MicIcon />
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <span className="promptbar__engine" title={statusLabel}>
          <span className={`promptbar__dot promptbar__dot--${state}`} />
          {cliLabel}
          {modelLabel}
        </span>
        <textarea
          ref={ref}
          className="promptbar__input"
          rows={1}
          placeholder={t('prompt.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button
          className="promptbar__send"
          title={t('prompt.send')}
          onClick={submit}
          disabled={!canSend}
        >
          <SendIcon />
        </button>
      </div>
    </div>
  )
}
