import api from './api'

// Shared TTS playback controller — a singleton store so the top-bar controls, the
// queue player (useTtsPlayer) and the article reader (MailWebView) all share ONE state
// and ONE set of pause/resume/stop/next actions. Mirrors the uiBridge pattern.
//
// Only one source sounds at a time: when a new source starts, the previous one is stopped.

let state = { status: 'idle', queueLen: 0 } // status: 'idle' | 'playing' | 'paused'
const subs = new Set()

export function getTtsState() {
  return state
}
export function subscribeTts(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}
export function setTtsState(patch) {
  const next = { ...state, ...patch }
  if (next.status === state.status && next.queueLen === state.queueLen) return
  state = next
  for (const f of subs) f(state)
}

// the currently-sounding source registers its controls here; starting a new source
// stops the previous one (one global говорилка at a time)
let active = null // { id, pause, resume, stop, next }

export function activateTts(controls) {
  if (active && active.id !== controls.id) {
    try {
      active.stop?.()
    } catch {
      /* ignore */
    }
  }
  active = controls
}
export function deactivateTts(id) {
  if (active?.id === id) {
    active = null
    setTtsState({ status: 'idle', queueLen: 0 })
  }
}
// invoked by the top-bar buttons; routed to whatever source is currently active.
// 'stop' also cancels the article driver below, so no more paragraphs get queued.
export function ttsAction(name) {
  if (name === 'stop') cancelArticle()
  try {
    active?.[name]?.()
  } catch {
    /* ignore */
  }
}

// ---- article driver: feed a long text into the GLOBAL queue paragraph-by-paragraph ----
// Lives at module level (not in any component), so playback keeps going as the user
// navigates the app — the reader panel can unmount and the queue keeps speaking.
// Each ttsSpeak synthesizes on the backend and pushes one clip to useTtsPlayer's queue;
// awaiting them serializes synthesis (no overlapping ONNX sessions) and keeps order.
let articleRun = 0
export async function speakArticle(paragraphs, lang) {
  const run = ++articleRun
  for (const p of paragraphs) {
    if (run !== articleRun) return // cancelled (stop pressed / a newer article started)
    try {
      await api.ttsSpeak?.({ text: p, lang })
    } catch {
      /* skip a paragraph that failed to synthesize */
    }
  }
}
export function cancelArticle() {
  articleRun++ // any in-flight driver loop sees the bump and stops queuing more
}
