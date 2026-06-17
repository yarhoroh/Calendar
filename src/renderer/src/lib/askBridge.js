// A question the assistant asks the user and waits an answer for. The AI opens
// it (openAsk), a popup shows the question + an input, the user answers
// (submitAsk) and the answer is fed back to the AI WITH the original question
// for context. The AI can also close it itself (closeAsk), and the open state is
// published so it knows a question is pending (e.g. if the user is away).

let pending = null // { question } | null
const subs = new Set()
let answerHandler = null // (question, answer) => void — set by App to route the answer to the AI

const emit = () => subs.forEach((f) => f(pending))

export const subscribeAsk = (fn) => {
  subs.add(fn)
  fn(pending)
  return () => subs.delete(fn)
}
export const getAsk = () => pending

export const openAsk = (question) => {
  pending = { question: String(question || '') }
  emit()
}
export const closeAsk = () => {
  if (!pending) return false
  pending = null
  emit()
  return true
}

export const setAnswerHandler = (fn) => {
  answerHandler = fn
}
export const submitAsk = (answer) => {
  const q = pending?.question
  pending = null
  emit()
  if (q != null) answerHandler?.(q, answer)
}
