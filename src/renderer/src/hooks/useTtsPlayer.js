import { useEffect, useRef } from 'react'
import api from '../lib/api'
import { setTtsState, activateTts, deactivateTts } from '../lib/ttsBridge'

// Plays WAV clips pushed from the main process (TTS) via the Web Audio API.
// We decode the bytes ourselves instead of an <audio src="data:..."> so the
// page's Content-Security-Policy (default-src 'self') doesn't block it.
// Clips are queued and played one after another — a new clip never interrupts
// the one currently speaking. Works even when the window is hidden in tray.
//
// Exposes pause/resume/stop/next through ttsBridge, so the top-bar controls can
// drive it: stop clears the whole queue, next skips to the next clip.

function b64ToArrayBuffer(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

const ID = 'queue'

export function useTtsPlayer() {
  const ctxRef = useRef(null)
  const queueRef = useRef([])
  const srcRef = useRef(null) // the clip currently playing (so stop/next can abort it)
  const playingRef = useRef(false)
  const stoppedRef = useRef(false)

  useEffect(() => {
    if (!api.onTtsPlay) {
      console.error('[tts] onTtsPlay bridge missing — preload not loaded?')
      return
    }

    const controls = {
      id: ID,
      pause: () => {
        ctxRef.current?.suspend()
        setTtsState({ status: 'paused', queueLen: queueRef.current.length })
      },
      resume: () => {
        ctxRef.current?.resume()
        setTtsState({ status: 'playing', queueLen: queueRef.current.length })
      },
      stop: () => {
        queueRef.current = []
        stoppedRef.current = true
        try {
          srcRef.current?.stop() // ends the current clip → the loop sees the empty queue and exits
        } catch {
          /* already stopped */
        }
      },
      // skip the current clip: stop it so onended fires and the loop advances to the next
      next: () => {
        try {
          srcRef.current?.stop()
        } catch {
          /* already stopped */
        }
      }
    }

    const pump = async () => {
      if (playingRef.current) return
      playingRef.current = true
      stoppedRef.current = false
      activateTts(controls) // become the active source (stops the reader if it was playing)
      try {
        if (!ctxRef.current) ctxRef.current = new AudioContext()
        const ctx = ctxRef.current
        if (ctx.state === 'suspended') await ctx.resume()
        while (queueRef.current.length && !stoppedRef.current) {
          const wav = queueRef.current.shift()
          setTtsState({ status: 'playing', queueLen: queueRef.current.length })
          const audioBuf = await ctx.decodeAudioData(b64ToArrayBuffer(wav))
          if (stoppedRef.current) break
          await new Promise((resolve) => {
            const src = ctx.createBufferSource()
            src.buffer = audioBuf
            src.connect(ctx.destination)
            src.onended = resolve // also fires when stop()/next() calls src.stop()
            srcRef.current = src
            src.start()
          })
          srcRef.current = null
        }
      } catch (e) {
        console.error(`[tts] playback failed: ${e.message}`)
      } finally {
        playingRef.current = false
        srcRef.current = null
        if (queueRef.current.length && !stoppedRef.current) pump() // picked up during the gap
        else deactivateTts(ID)
      }
    }

    const off = api.onTtsPlay(({ wav }) => {
      if (!wav) return
      queueRef.current.push(wav)
      // reflect the new queue length immediately so the top-bar "next" arrow appears as
      // soon as a clip is queued — not only once playback reaches it
      if (playingRef.current) setTtsState({ status: 'playing', queueLen: queueRef.current.length })
      pump()
    })
    return () => {
      off?.()
      queueRef.current = []
      deactivateTts(ID)
    }
  }, [])
}
