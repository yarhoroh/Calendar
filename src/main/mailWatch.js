import { enabledMailTasks, getMailWatermark, setMailWatermark } from './db'
import { newMessagesSince, getMailAccounts } from './mail'

// Mail watcher: each enabled mail task watches an account+folder on an interval and,
// using the per-mailbox high-water mark, fetches ONLY new mail since last time — it
// never re-scans the whole mailbox. When genuinely new messages arrive it "pinches"
// the AI (onFire) with the task's standing prompt + the new messages, so the AI can
// decide what matters and tell the user. Mirrors aiTasks.js.

const MAX_DELAY = 2 ** 31 - 1
const timers = new Map()
const running = new Set() // skip a tick if the previous check for that task is still in flight
let onFire = () => {}

export function initMailWatch(opts) {
  onFire = opts.onFire || (() => {})
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

// the real mailboxes a task covers — one email, or every account when set to "all"
function accountsFor(task) {
  if (task.account && task.account !== 'all') return [task.account]
  return getMailAccounts().map((a) => a.email)
}

// fetch only-new mail for one mailbox and advance its watermark (so the next check,
// with nothing new, returns nothing and does no work)
async function checkAccount(account, folder) {
  const wm = getMailWatermark(account, folder)
  const r = await newMessagesSince({ account, folder, lastUid: wm?.last_uid || 0, uidValidity: wm?.uid_validity || 0 })
  if (!r.ok) return []
  setMailWatermark(account, folder, r.lastUid, r.uidValidity)
  return r.messages || []
}

async function runWatch(task) {
  if (running.has(task.id)) return // previous (slow) IMAP check still running → skip this tick
  running.add(task.id)
  try {
    const folder = task.folder || 'INBOX'
    const fresh = []
    for (const account of accountsFor(task)) {
      try {
        fresh.push(...(await checkAccount(account, folder)))
      } catch {
        /* one account failing shouldn't stop the others */
      }
    }
    if (fresh.length) {
      fresh.sort((a, b) => a.date - b.date)
      try {
        onFire(task, fresh)
      } catch {
        /* a failed fire shouldn't crash the scheduler */
      }
    }
  } finally {
    running.delete(task.id)
  }
}

function schedule(task) {
  clearTimeout(timers.get(task.id))
  const everyMs = Math.max(1, Number(task.every) || 10) * 60000
  // run once now: on the very first use this just records the baseline (no notifications);
  // on later app starts it catches up on mail that arrived while the app was off
  runWatch(task)
  const tick = () => {
    if (inWindow(task)) runWatch(task)
    timers.set(task.id, setTimeout(tick, Math.min(everyMs, MAX_DELAY)))
  }
  timers.set(task.id, setTimeout(tick, Math.min(everyMs, MAX_DELAY)))
}

export function scheduleAllMailTasks() {
  for (const t of enabledMailTasks()) schedule(t)
}
export function scheduleMailTask(task) {
  if (task && task.enabled !== 0) schedule(task)
}
export function cancelMailTask(id) {
  clearTimeout(timers.get(id))
  timers.delete(id)
}
