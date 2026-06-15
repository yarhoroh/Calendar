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

function schedule(task) {
  clearTimeout(timers.get(task.id))
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
