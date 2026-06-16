import { pendingAiTasks, markAiTaskDone } from './db'

// Scheduler for AI self-tasks: each pending task has a local datetime `at`. When
// it arrives we mark it done and "pinch" the AI (via the onFire callback) so it
// can act — speak a reminder, add notes, etc. Mirrors the reminder scheduler.

const MAX_DELAY = 2 ** 31 - 1
const timers = new Map()
let onFire = () => {}

export function initAiTasks(opts) {
  onFire = opts.onFire || (() => {})
}

function trigger(task) {
  timers.delete(task.id)
  markAiTaskDone(task.id)
  try {
    onFire(task)
  } catch {
    // ignore — a failed fire shouldn't crash the scheduler
  }
}

function anchorOf(task, everyMs) {
  if (task.at) return new Date(task.at).getTime()
  if (task.winfrom) {
    const [h, m] = String(task.winfrom).split(':').map(Number)
    const d = new Date()
    d.setHours(h || 0, m || 0, 0, 0)
    return d.getTime()
  }
  return Date.now() + everyMs
}

// is the current local time inside the task's daily window [winfrom, winto]?
function inWindow(task) {
  if (!task.winfrom || !task.winto) return true
  const [fh, fm] = String(task.winfrom).split(':').map(Number)
  const [th, tm] = String(task.winto).split(':').map(Number)
  if ([fh, fm, th, tm].some(Number.isNaN)) return true
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const f = fh * 60 + fm
  const t = th * 60 + tm
  return f <= t ? cur >= f && cur <= t : cur >= f || cur <= t // t<f = overnight window
}

function schedule(task) {
  clearTimeout(timers.get(task.id))

  // periodic task: fire every `every` minutes (within its window), never done
  const everyMs = Number(task.every) > 0 ? Number(task.every) * 60000 : 0
  if (everyMs) {
    let next = anchorOf(task, everyMs)
    if (Number.isNaN(next)) next = Date.now() + everyMs
    while (next <= Date.now()) next += everyMs
    const tick = () => {
      if (inWindow(task)) {
        try {
          onFire(task)
        } catch {
          // ignore
        }
      }
      do {
        next += everyMs
      } while (next <= Date.now()) // skip slots missed while asleep
      timers.set(task.id, setTimeout(tick, Math.min(next - Date.now(), MAX_DELAY)))
    }
    timers.set(task.id, setTimeout(tick, Math.min(next - Date.now(), MAX_DELAY)))
    return
  }

  // one-time task
  const delay = new Date(task.at).getTime() - Date.now()
  if (Number.isNaN(delay)) return
  // overdue (app was off when it was due): mark done silently, don't surprise.
  if (delay <= 0) {
    markAiTaskDone(task.id)
    return
  }
  timers.set(task.id, setTimeout(() => trigger(task), Math.min(delay, MAX_DELAY)))
}

export function scheduleAllAiTasks() {
  for (const t of pendingAiTasks()) schedule(t)
}
export function scheduleAiTask(task) {
  if (task) schedule(task)
}
export function cancelAiTask(id) {
  clearTimeout(timers.get(id))
  timers.delete(id)
}
