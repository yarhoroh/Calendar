import { useEffect, useRef } from 'react'
import api from '../lib/api'
import { setTtsState, activateTts, deactivateTts } from '../lib/ttsBridge'

// Plays WAV clips pushed from the main process (TTS) via the Web Audio API.
// We decode the bytes ourselves instead of an <audio src="data:..."> so the
// page's Content-Security-Policy (default-src 'self') doesn't block it.
// Clips are queued and played one after another — a new clip never interrupts
// the one currently speaking. Works even when the window is hidden in tray.
//
// Volume: a GainNode sits between each clip and the output. Each clip plays at its
// own volume if the caller (/speak) passed one, otherwise at the user's saved base
// volume (Settings → Voice). Output device: AudioContext.setSinkId routes playback
// to the chosen device. Both come from main via tts:get-config + the tts:config
// broadcast. While speaking we ask main to duck (mute) other apps and un-duck when
// the queue drains — main honours the "duck background" setting, so we always call.
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
  const gainRef = useRef(null)
  const queueRef = useRef([]) // [{ wav, volume }]
  const srcRef = useRef(null) // the clip currently playing (so stop/next can abort it)
  const playingRef = useRef(false)
  const stoppedRef = useRef(false)
  const baseVolumeRef = useRef(1) // saved base volume (0..1)
  const sinkIdRef = useRef('') // chosen output device ('' = system default)
  const clipHasOwnVolumeRef = useRef(false) // is the current clip on a per-clip volume?

  useEffect(() => {
    if (!api.onTtsPlay) {
      console.error('[tts] onTtsPlay bridge missing — preload not loaded?')
      return
    }

    // route the AudioContext to the chosen output device (no-op / default on failure)
    const applySink = () => {
      const ctx = ctxRef.current
      if (!ctx || typeof ctx.setSinkId !== 'function') return
      try {
        ctx.setSinkId(sinkIdRef.current || '').catch(() => {})
      } catch {
        /* unsupported → stays on default device */
      }
    }

    // load saved volume + device, and keep them live as the user changes them in Settings
    Promise.resolve(api.getTtsConfig?.()).then((c) => {
      if (!c) return
      if (c.volume != null) baseVolumeRef.current = c.volume
      sinkIdRef.current = c.sinkId || ''
      applySink()
    })
    const offConfig = api.onTtsConfig?.((c) => {
      if (!c) return
      if (c.volume != null) {
        baseVolumeRef.current = c.volume
        // live-apply while a base-volume clip is speaking (e.g. dragging the slider on the test phrase)
        if (gainRef.current && !clipHasOwnVolumeRef.current) gainRef.current.gain.value = c.volume
      }
      if (c.sinkId !== undefined && c.sinkId !== sinkIdRef.current) {
        sinkIdRef.current = c.sinkId || ''
        applySink()
      }
    })

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
      api.ttsDuck?.() // mute other apps for the duration (main no-ops if the setting is off)
      try {
        if (!ctxRef.current) {
          ctxRef.current = new AudioContext()
          gainRef.current = ctxRef.current.createGain()
          gainRef.current.connect(ctxRef.current.destination)
          applySink()
        }
        const ctx = ctxRef.current
        if (ctx.state === 'suspended') await ctx.resume()
        while (queueRef.current.length && !stoppedRef.current) {
          const { wav, volume } = queueRef.current.shift()
          setTtsState({ status: 'playing', queueLen: queueRef.current.length })
          const audioBuf = await ctx.decodeAudioData(b64ToArrayBuffer(wav))
          if (stoppedRef.current) break
          clipHasOwnVolumeRef.current = volume != null
          gainRef.current.gain.value = volume != null ? volume : baseVolumeRef.current
          await new Promise((resolve) => {
            const src = ctx.createBufferSource()
            src.buffer = audioBuf
            src.connect(gainRef.current)
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
        clipHasOwnVolumeRef.current = false
        if (queueRef.current.length && !stoppedRef.current) pump() // picked up during the gap
        else {
          api.ttsUnduck?.() // queue drained → restore other apps' audio
          deactivateTts(ID)
        }
      }
    }

    const off = api.onTtsPlay(({ wav, volume }) => {
      if (!wav) return
      queueRef.current.push({ wav, volume })
      // reflect the new queue length immediately so the top-bar "next" arrow appears as
      // soon as a clip is queued — not only once playback reaches it
      if (playingRef.current) setTtsState({ status: 'playing', queueLen: queueRef.current.length })
      pump()
    })
    return () => {
      off?.()
      offConfig?.()
      queueRef.current = []
      api.ttsUnduck?.()
      deactivateTts(ID)
    }
  }, [])
}
