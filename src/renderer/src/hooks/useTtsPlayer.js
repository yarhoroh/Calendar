import { useEffect, useRef } from 'react'
import api from '../lib/api'

// Plays WAV clips pushed from the main process (TTS) via the Web Audio API.
// We decode the bytes ourselves instead of an <audio src="data:..."> so the
// page's Content-Security-Policy (default-src 'self') doesn't block it.
// Clips are queued and played one after another — a new clip never interrupts
// the one currently speaking. Works even when the window is hidden in tray.

function b64ToArrayBuffer(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

export function useTtsPlayer() {
  const ctxRef = useRef(null)
  const queueRef = useRef([])
  const playingRef = useRef(false)

  useEffect(() => {
    if (!api.onTtsPlay) {
      console.error('[tts] onTtsPlay bridge missing — preload not loaded?')
      return
    }

    const pump = async () => {
      if (playingRef.current) return
      playingRef.current = true
      try {
        if (!ctxRef.current) ctxRef.current = new AudioContext()
        const ctx = ctxRef.current
        if (ctx.state === 'suspended') await ctx.resume()
        while (queueRef.current.length) {
          const wav = queueRef.current.shift()
          const audioBuf = await ctx.decodeAudioData(b64ToArrayBuffer(wav))
          await new Promise((resolve) => {
            const src = ctx.createBufferSource()
            src.buffer = audioBuf
            src.connect(ctx.destination)
            src.onended = resolve
            src.start()
          })
        }
      } catch (e) {
        console.error(`[tts] playback failed: ${e.message}`)
      } finally {
        playingRef.current = false
        if (queueRef.current.length) pump() // picked up an item during the gap
      }
    }

    const off = api.onTtsPlay(({ wav }) => {
      if (!wav) return
      queueRef.current.push(wav)
      pump()
    })
    return () => {
      off?.()
      queueRef.current = []
    }
  }, [])
}
