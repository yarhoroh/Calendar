import { useEffect, useRef, useState } from 'react'
import api from '../lib/api'

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

// Push-to-talk local voice input, shared by the chat bar and the note editor.
// Hold to record, release to transcribe; the transcription is handed to
// onText(text). Mirrors the original PromptBar behaviour exactly.
export function useVoiceInput(onText) {
  const [asr, setAsr] = useState({ enabled: false, lang: 'ru', ready: false })
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recRef = useRef(null) // MediaRecorder
  const chunksRef = useRef([])
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  // local voice input availability (Settings toggle + downloaded model)
  useEffect(() => {
    let alive = true
    const load = async () => {
      const cfg = (await api.asr?.getConfig?.()) || { enabled: false, lang: 'ru' }
      const st = (await api.asr?.status?.()) || {}
      if (alive) setAsr({ enabled: !!cfg.enabled, lang: cfg.lang || 'ru', ready: !!st[cfg.lang || 'ru']?.ready })
    }
    load()
    const off = api.asr?.onChanged?.(load)
    return () => {
      alive = false
      off?.()
    }
  }, [])

  const start = async () => {
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
        if (r?.ok && r.text) onTextRef.current?.(r.text.trim())
      } finally {
        setTranscribing(false)
      }
    }
    recRef.current = mr
    mr.start()
    setRecording(true)
  }

  const stop = () => {
    if (!recording) return
    setRecording(false)
    try {
      recRef.current?.stop()
    } catch {
      // already stopped
    }
  }

  return { available: asr.enabled && asr.ready, recording, transcribing, start, stop }
}
