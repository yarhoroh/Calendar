// Single channel for talking to the in-app chat. Everything that wants to post
// into the chat log (the assistant proactively, background AI tasks, action
// outcomes) goes through here, instead of each place reaching into chat state.
// useChat registers the sink; callers use pushChat / hasChat.

let sink = null

export const registerChatSink = (fn) => {
  sink = fn
  return () => {
    if (sink === fn) sink = null
  }
}

export const hasChat = () => !!sink

// Append a message to the chat log. role: 'assistant' (default) | 'system'.
export const pushChat = (content, role = 'assistant') => {
  if (!sink || !content) return false
  sink({ role, content })
  return true
}

// ---- cooperative STOP for the multi-round action loop ----
// A long PDF/action chain runs in runActions; the user needs to SEE it AND be able to halt it.
// abortActions() raises a flag the loop checks between rounds; resetAbort() clears it on a new turn.
let aborted = false
export const abortActions = () => { aborted = true }
export const isAborted = () => aborted
export const resetAbort = () => { aborted = false }
