import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'

// Standalone notification module: owns a small always-on-top window pinned to
// the bottom-right of the screen (near the clock), independent of the main
// window. Exposes a programmatic API so the UI — and later the AI bridge —
// can schedule reminders or push messages.

let win = null
let opts = {}
const timers = new Map()
const stripHtml = (s) => (s || '').replace(/<[^>]*>/g, '').trim()

function ensureWindow() {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: 340,
    height: 120,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: { preload: opts.preload, sandbox: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (opts.rendererUrl) win.loadURL(`${opts.rendererUrl}#toast`)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'toast' })
  return win
}

function placement(height) {
  const wa = screen.getPrimaryDisplay().workArea
  const width = 340
  const h = Math.min(Math.max(height, 1), wa.height - 24)
  return { width, height: h, x: wa.x + wa.width - width - 12, y: wa.y + wa.height - h - 12 }
}

function send(payload) {
  const w = ensureWindow()
  w.showInactive()
  w.webContents.send('reminder:fire', payload)
  if (opts.getSound?.() !== false) shell.beep()
}

export function initNotify(options) {
  opts = options
  ensureWindow()
}

function scheduleOnce(payload, whenMs) {
  const delay = whenMs - Date.now()
  if (!Number.isFinite(delay) || delay <= 0 || delay > 2147483647) return
  timers.set(
    payload.id,
    setTimeout(() => {
      timers.delete(payload.id)
      send(payload)
    }, delay)
  )
}

function nextDaily(hh, mm) {
  const d = new Date()
  d.setHours(hh, mm, 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

// fires every day at hh:mm (used for the "every day" virtual day), but only on
// the configured working days — non-working days are skipped (still rescheduled)
function scheduleDaily(payload, hh, mm) {
  const tick = () => {
    const wd = opts.getWorkingDays?.()
    if (!wd || wd.includes(new Date().getDay())) send(payload)
    timers.set(payload.id, setTimeout(tick, Math.max(1000, nextDaily(hh, mm) - Date.now())))
  }
  timers.set(payload.id, setTimeout(tick, Math.max(1000, nextDaily(hh, mm) - Date.now())))
}

// The reminder is just a time (HH:mm). For a dated note it fires on that note's
// own day; for the "everyday" board it recurs daily. (Old full datetimes are
// tolerated by taking the time part.)
export function setReminder(payload, when) {
  clearReminder(payload.id)
  if (!when) return
  const hhmm = String(when).includes('T') ? String(when).split('T')[1] : String(when)
  const [hh, mm] = hhmm.split(':').map(Number)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return
  if (payload.dayKey === 'everyday') {
    scheduleDaily(payload, hh, mm)
  } else {
    const pad = (n) => String(n).padStart(2, '0')
    scheduleOnce(payload, new Date(`${payload.dayKey}T${pad(hh)}:${pad(mm)}`).getTime())
  }
}

export function clearReminder(id) {
  const t = timers.get(id)
  if (t) {
    clearTimeout(t)
    timers.delete(id)
  }
}

export function scheduleAll(map) {
  for (const key of Object.keys(map)) {
    for (const it of map[key]) {
      if (it.time) {
        setReminder({ id: it.id, dayKey: key, title: it.title || 'Calendar', body: stripHtml(it.text) }, it.time)
      }
    }
  }
}

// programmatic entry point (AI / external): show an immediate message
export function pushMessage({ title, body, dayKey } = {}) {
  send({ id: `msg-${Date.now()}`, dayKey: dayKey || null, title: title || 'Calendar', body: body || '' })
}

// the toast renderer reports its content height so we can size/position the window
export function resizeToContent(height) {
  if (!win || win.isDestroyed()) return
  if (height <= 0) {
    win.hide()
    return
  }
  win.setBounds(placement(height))
  if (!win.isVisible()) win.showInactive()
}

// a toast was clicked → bring up the main window on that day
export function openInMain(dayKey) {
  opts.showMain?.()
  opts.getMain?.()?.webContents.send('reminder:open', dayKey)
}

// keep the notification window's theme in sync with the app
export function sendTheme(theme) {
  if (win && !win.isDestroyed()) win.webContents.send('theme:set', theme)
}
