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
