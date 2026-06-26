import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, dialog, shell, clipboard } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { detectClaude, detectCodex, warmUp } from './ai'
import { warmClaude, stopClaude, clearClaude, askClaude, askClaudeRaw } from './claudeAgent'
import { askCodex, resetCodex } from './codex'
import { askAgy, resetAgy, detectAgy, agyAskRaw } from './agy'
import { asrStatus, downloadAsrModel, transcribe as asrTranscribe } from './asr'
import { aiConfigPath, loadAiConfig, ensureAiConfig, saveAiConfig } from './aiConfig'
import { startTelegram, stopTelegram, sendTelegram } from './telegram'
import electronUpdater from 'electron-updater'
import { initTts, speak, synthesize, setTtsEngine, setSupertonicVoice, setPiperVoice, setSpeedResolver } from './tts'
import { getSupertonicStatus, startSupertonicDownload, initSupertonicDownload } from './supertonic/download'
import { startTtsServer, stopTtsServer } from './ttsServer'
import {
  initDb,
  getItems,
  saveItems,
  itemsWithTime,
  isEmpty,
  importMap,
  allNotes,
  listFolders,
  allFolders,
  addFolder,
  renameFolder,
  moveFolder,
  deleteFolder,
  listStatuses,
  addStatus,
  updateStatus,
  deleteStatus,
  allMemory,
  addMemory,
  deleteMemory,
  allAiTasks,
  addAiTask,
  updateAiTask,
  deleteAiTask,
  allMailTasks,
  addMailTask,
  updateMailTask,
  deleteMailTask,
  attachmentsFor,
  allAttachments,
  addAttachment,
  removeAttachment,
  attachmentById,
  importedMap,
  markEventImported,
  getImport,
  unmarkImport,
  listMailMessages,
  clearMailCache,
  getSavedAttachment
} from './db'
import {
  connectAccount as googleConnect,
  removeAccount as googleRemove,
  setSelectedCalendars as googleSetCalendars,
  setAutoSyncCalendars as googleSetAutoSync,
  autoSyncCalendars as googleAutoSyncCalendars,
  listAccountsWithCalendars as googleListAccounts,
  listEventsAllSelected as googleListEvents,
  eventRecurrence as googleEventRecurrence,
  createEvent as googleCreateEvent,
  updateEvent as googleUpdateEvent,
  deleteEvent as googleDeleteEvent,
  eventWritable as googleEventWritable,
  writableCalendars as googleWritableCalendars,
  accountsSummary as googleAccountsSummary
} from './google'
import { getMailAccounts, addMailAccount, removeMailAccount, testInbox, listFolders as mailFolders, cachedMessages, loadMessages, recentMessages, mailFolderStats, mailCategoryStats, setMailImportant, getMailThread, setMailSeen, inlineMailImages, openMailAttachment, deleteMail, markFolderRead, emptyFolder, deleteReadInFolder, searchMessages, bulkDeleteMail, bulkSeenMail, sendMail, mailContacts } from './mail'
import { initAiTasks, scheduleAllAiTasks, scheduleAiTask, cancelAiTask } from './aiTasks'
import { initMailWatch, scheduleAllMailTasks, scheduleMailTask, cancelMailTask } from './mailWatch'
import {
  initNotify,
  setReminder,
  clearReminder,
  scheduleAll,
  pushMessage,
  resizeToContent,
  openInMain,
  sendTheme
} from './notify'

let mainWindow = null
let tray = null
let isQuitting = false

// ---- persisted settings (remembered close action) ----------------------
function settingsFile() {
  return join(app.getPath('userData'), 'settings.json')
}
function loadSettings() {
  try {
    if (existsSync(settingsFile())) {
      return JSON.parse(readFileSync(settingsFile(), 'utf-8'))
    }
  } catch {
    // ignore corrupt settings
  }
  return {}
}
function saveSettings(next) {
  try {
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
  } catch {
    // ignore write errors
  }
}

function appIcon() {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon.png')
  return nativeImage.createFromPath(path)
}

// ---- window position / size persistence --------------------------------
let saveTimer = null

// true if the saved rect still overlaps a connected display (monitor changes)
function boundsVisible(b) {
  if (b.x == null || b.y == null) return false
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return (
      b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
    )
  })
}

function persistWindow() {
  if (!mainWindow || mainWindow.isMinimized()) return
  const s = loadSettings()
  const w = { ...(s.window || {}) }
  if (mainWindow.isMaximized()) {
    w.maximized = true
  } else {
    const b = mainWindow.getBounds()
    w.x = b.x
    w.y = b.y
    w.width = b.width
    w.height = b.height
    w.maximized = false
  }
  s.window = w
  saveSettings(s)
}

function schedulePersist() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persistWindow, 400)
}

function showWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow() {
  const saved = loadSettings().window || {}
  const useBounds = boundsVisible(saved)

  mainWindow = new BrowserWindow({
    width: saved.width || 1040,
    height: saved.height || 720,
    x: useBounds ? saved.x : undefined,
    y: useBounds ? saved.y : undefined,
    minWidth: 240,
    minHeight: 160,
    frame: false,
    show: false,
    backgroundColor: '#0f1117',
    icon: appIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  if (saved.maximized) mainWindow.maximize()
  if (saved.pinned) mainWindow.setAlwaysOnTop(true)

  // allow microphone capture (voice input in the chat); deny everything else
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media' || permission === 'audioCapture')
  )

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized', true)
    persistWindow()
  })
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized', false)
    persistWindow()
  })
  mainWindow.on('resize', schedulePersist)
  mainWindow.on('move', schedulePersist)

  // closing the window: respect remembered choice, otherwise ask the renderer
  mainWindow.on('close', (e) => {
    persistWindow()
    if (isQuitting) return
    const { closeAction } = loadSettings()
    if (closeAction === 'tray') {
      e.preventDefault()
      mainWindow.hide()
    } else if (closeAction === 'quit') {
      // fall through: window really closes
    } else {
      e.preventDefault()
      mainWindow.webContents.send('window:confirm-close')
    }
  })

  mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
    if (level >= 2) console.log(`[renderer] ${message} (${src}:${line})`)
  })

  // the notification window would otherwise keep the app alive
  mainWindow.on('closed', () => {
    mainWindow = null
    if (!isQuitting) app.quit()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const TRAY_LABELS = {
  en: { open: 'Open Calendar', exit: 'Exit' },
  uk: { open: 'Відкрити Calendar', exit: 'Вихід' }
}

function applyTrayMenu() {
  if (!tray) return
  const lang = loadSettings().language || 'en'
  const L = TRAY_LABELS[lang] || TRAY_LABELS.en
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: L.open, click: showWindow },
      { type: 'separator' },
      {
        label: L.exit,
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
}

function createTray() {
  tray = new Tray(appIcon())
  tray.setToolTip('Calendar')
  applyTrayMenu()
  // standard Windows behaviour: a click on the tray icon always brings the
  // window up (never hides it), right-click shows the context menu above.
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
}

// ---- IPC from the custom titlebar / close dialog -----------------------
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())
ipcMain.on('window:set-always-on-top', (_e, flag) => {
  mainWindow?.setAlwaysOnTop(flag)
  const s = loadSettings()
  s.window = { ...(s.window || {}), pinned: flag }
  saveSettings(s)
})
ipcMain.handle('window:get-state', () => ({ pinned: loadSettings().window?.pinned ?? false }))
ipcMain.on('window:hide-to-tray', (_e, remember) => {
  if (remember) {
    const s = loadSettings()
    s.closeAction = 'tray'
    saveSettings(s)
  }
  mainWindow?.hide()
})
ipcMain.on('window:quit', (_e, remember) => {
  if (remember) {
    const s = loadSettings()
    s.closeAction = 'quit'
    saveSettings(s)
  }
  isQuitting = true
  app.quit()
})

ipcMain.handle('settings:get-theme', () => loadSettings().theme || 'dark')
ipcMain.on('settings:set-theme', (_e, theme) => {
  const s = loadSettings()
  s.theme = theme
  saveSettings(s)
  sendTheme(theme)
})

ipcMain.handle('settings:get-calendar', () => loadSettings().calendar || {})
ipcMain.on('settings:set-calendar', (_e, patch) => {
  const s = loadSettings()
  s.calendar = { ...(s.calendar || {}), ...patch }
  saveSettings(s)
})

ipcMain.handle('settings:get-language', () => loadSettings().language || 'en')
ipcMain.on('settings:set-language', (_e, lang) => {
  const s = loadSettings()
  s.language = lang
  saveSettings(s)
  applyTrayMenu()
})

// ---- notes store (local SQLite, see ./db) ------------------------------
ipcMain.handle('items:get', (_e, key) => getItems(key))
ipcMain.on('items:save', (_e, key, items) => {
  try {
    saveItems(key, items)
    mainWindow?.webContents.send('items:changed', key)
  } catch (e) {
    // never let a DB hiccup crash the whole app
    console.error('items:save failed', key, e.message)
  }
})

// ---- folders (per-board note trees) -------------------------------------
const foldersChanged = () => mainWindow?.webContents.send('folders:changed')
ipcMain.handle('folders:list', (_e, board) => listFolders(board))
ipcMain.handle('folders:add', (_e, p) => {
  const r = addFolder(p || {})
  if (r) foldersChanged()
  return r
})
ipcMain.handle('folders:rename', (_e, { id, name }) => {
  const r = renameFolder(id, name)
  if (r.ok) foldersChanged()
  return r
})
ipcMain.handle('folders:move', (_e, { id, parentId }) => {
  const r = moveFolder(id, parentId)
  if (r.ok) foldersChanged()
  return r
})
ipcMain.handle('folders:delete', (_e, id) => {
  const r = deleteFolder(id)
  if (r.ok) foldersChanged()
  return r
})

// ---- custom statuses ----------------------------------------------------
const statusesChanged = () => mainWindow?.webContents.send('statuses:changed')
ipcMain.handle('statuses:list', () => listStatuses())
ipcMain.handle('statuses:add', (_e, p) => {
  const r = addStatus(p || {})
  if (r) statusesChanged()
  return r
})
ipcMain.handle('statuses:update', (_e, { id, patch }) => {
  const r = updateStatus(id, patch)
  if (r.ok) statusesChanged()
  return r
})
ipcMain.handle('statuses:delete', (_e, id) => {
  const r = deleteStatus(id)
  if (r.ok) statusesChanged()
  return r
})

// one-time import of the old notes.json into the database
function migrateNotesJson() {
  const file = join(app.getPath('userData'), 'notes.json')
  if (!existsSync(file) || !isEmpty()) return
  try {
    importMap(JSON.parse(readFileSync(file, 'utf-8')))
    renameSync(file, `${file}.bak`)
  } catch {
    // ignore migration errors
  }
}

function scheduleStoredReminders() {
  const all = itemsWithTime()
  // An "everyday" note owns the weekdays it recurs on. A dated note that merely duplicates it
  // (same title + time, on a day the everyday already covers) must NOT schedule a second
  // reminder — the everyday's daily one already fires that day. (Don't also fire the dated
  // "today" copy.) The notes are left untouched; we just skip the redundant reminder.
  const wd = workingDays()
  const everyday = all.filter((it) => it.day === 'everyday' && it.time)
  const coveredByEveryday = (it) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(it.day)
    if (!m) return false
    const dow = new Date(+m[1], +m[2] - 1, +m[3]).getDay()
    return everyday.some((e) => {
      if ((e.title || '') !== (it.title || '') || (e.time || '') !== (it.time || '')) return false
      const days = Array.isArray(e.days) && e.days.length ? e.days : wd
      return days.includes(dow)
    })
  }
  const map = {}
  for (const it of all) {
    if (it.day !== 'everyday' && coveredByEveryday(it)) continue
    ;(map[it.day] = map[it.day] || []).push(it)
  }
  scheduleAll(map)
}

// ---- reminders & notifications (see ./notify) --------------------------
ipcMain.on('reminder:set', (_e, { id, when, dayKey, title, body, days }) => {
  setReminder({ id, dayKey, title: title || 'Calendar', body: body || '', days }, when)
})
ipcMain.on('reminder:clear', (_e, id) => clearReminder(id))
ipcMain.on('notify:resize', (_e, height) => resizeToContent(height))
ipcMain.on('notify:open', (_e, dayKey) => openInMain(dayKey))

ipcMain.handle('settings:get-autostart', () => app.getLoginItemSettings().openAtLogin)
ipcMain.on('settings:set-autostart', (_e, flag) => {
  app.setLoginItemSettings({ openAtLogin: !!flag })
})

ipcMain.handle('settings:get-reminder-sound', () => loadSettings().reminderSound !== false)
ipcMain.on('settings:set-reminder-sound', (_e, flag) => {
  const s = loadSettings()
  s.reminderSound = !!flag
  saveSettings(s)
})

// working days: weekday indices (0=Sun..6=Sat) on which "every day" reminders fire
const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5]
function workingDays() {
  const v = loadSettings().workingDays
  return Array.isArray(v) ? v : DEFAULT_WORKING_DAYS
}
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('settings:get-working-days', () => workingDays())
ipcMain.on('settings:set-working-days', (_e, days) => {
  const s = loadSettings()
  s.workingDays = Array.isArray(days) ? days.filter((d) => d >= 0 && d <= 6) : DEFAULT_WORKING_DAYS
  saveSettings(s)
})

ipcMain.handle('settings:get-show-chat', () => loadSettings().showChat === true)
ipcMain.on('settings:set-show-chat', (_e, flag) => {
  const s = loadSettings()
  s.showChat = !!flag
  saveSettings(s)
})

ipcMain.handle('settings:get-reminder-duration', () => loadSettings().reminderDuration ?? 0)
ipcMain.on('settings:set-reminder-duration', (_e, v) => {
  const s = loadSettings()
  s.reminderDuration = v
  saveSettings(s)
})

// ---- local AI tools ----------------------------------------------------
ipcMain.handle('ai:detect-claude', () => detectClaude())
ipcMain.handle('ai:detect-codex', () => detectCodex())
ipcMain.handle('ai:detect-agy', () => detectAgy())
ipcMain.handle('settings:get-ai', () => loadSettings().ai || 'agy')
ipcMain.on('settings:set-ai', (_e, v) => {
  const s = loadSettings()
  s.ai = v
  saveSettings(s)
  warmAi(v)
})

// Warm the chosen CLI and tell the renderer its state, so the chat can show a
// "starting / ready / not found" indicator instead of leaving the user guessing.
let aiState = 'warming' // 'warming' | 'ready' | 'offline'
function activeModel(cli) {
  const cfg = loadAiConfig()
  if (cli === 'claude') return cfg.claudeModel || 'default'
  if (cli === 'agy') return cfg.agyModel || 'default'
  return cfg.codexModel || 'default'
}
function broadcastAiStatus() {
  const cli = loadSettings().ai || 'agy'
  mainWindow?.webContents?.send('ai:status', { state: aiState, cli, model: activeModel(cli) })
}
function warmAi(cli) {
  aiState = 'warming'
  broadcastAiStatus()
  // unload whatever persistent process isn't the chosen engine, then start the
  // chosen one — same as a fresh start. claude = streaming process, codex =
  // resumable one-shot, agy = per-call --print (just warm the binary + reset).
  if (cli !== 'claude') stopClaude()
  resetCodex()
  resetAgy()
  const cfg = loadAiConfig()
  // if a configured model turns out to be unavailable, the engine falls back to
  // the CLI default and calls back so we persist the fix (so it never re-breaks)
  let warming
  if (cli === 'claude') {
    warming = warmClaude(cfg.claudeModel, (m) => {
      saveAiConfig({ claudeModel: m })
      broadcastAiStatus()
    })
  } else if (cli === 'agy') {
    warming = detectAgy().then((r) => r.found) // no persistent process to warm; just confirm it's installed
  } else {
    warming = warmUp('codex')
  }
  Promise.resolve(warming).then((ok) => {
    aiState = ok ? 'ready' : 'offline'
    broadcastAiStatus()
  })
}
ipcMain.handle('ai:status', () => {
  const cli = loadSettings().ai || 'agy'
  return { state: aiState, cli, model: activeModel(cli) }
})
function aiContext() {
  // notes are fetched on demand via the getNotes tool — only the small,
  // always-relevant data lives in the prompt. done tasks included (marked
  // [done]) so the AI can see and delete them.
  return {
    memory: allMemory(),
    tasks: allAiTasks(),
    folders: allFolders(),
    statuses: listStatuses(),
    configPath: aiConfigPath(),
    googleAccounts: googleAccountsSummary(), // emails + selected calendar names only (no tokens)
    mailAccounts: getMailAccounts(), // IMAP mailboxes the AI can search/read/act on (no passwords)
    mailTasks: allMailTasks(), // mail watchers the AI can create/list/delete
    // "everyday" notes are projected onto calendar days when this is on; getNotes
    // surfaces them on the requested dates so the AI sees what the user sees
    everydayInCal: !!(loadSettings().calendar?.everydayInCal),
    workingDays: workingDays()
  }
}
ipcMain.handle('ai:send', (_e, { messages }) => {
  const cli = loadSettings().ai || 'agy'
  const ctx = aiContext()
  if (cli === 'claude') return askClaude({ messages, ctx })
  if (cli === 'codex') {
    const cfg = loadAiConfig()
    return askCodex({ messages, ctx, model: cfg.codexModel, reasoning: cfg.codexReasoning })
  }
  return askAgy({ messages, ctx, model: loadAiConfig().agyModel }) // default engine
})
// ---- local voice input (sherpa-onnx offline ASR) -----------------------
ipcMain.handle('asr:status', () => asrStatus())
ipcMain.handle('asr:get-config', () => loadSettings().asr || { enabled: false, lang: 'ru' })
ipcMain.on('asr:set-config', (_e, patch) => {
  const s = loadSettings()
  s.asr = { enabled: false, lang: 'ru', ...(s.asr || {}), ...patch }
  saveSettings(s)
  mainWindow?.webContents?.send('asr:changed')
})
ipcMain.handle('asr:download', async (_e, lang) => {
  try {
    const ok = await downloadAsrModel(lang, (p) =>
      mainWindow?.webContents?.send('asr:progress', { lang, progress: p })
    )
    mainWindow?.webContents?.send('asr:changed')
    return { ok }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
})
ipcMain.handle('asr:transcribe', (_e, { lang, samples }) => {
  try {
    const pcm = samples instanceof Float32Array ? samples : Float32Array.from(samples || [])
    return { ok: true, text: asrTranscribe(lang, pcm) }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
})
ipcMain.handle('aiConfig:get', () => loadAiConfig())
ipcMain.handle('aiConfig:set', (_e, patch) => saveAiConfig(patch))
// ---- Telegram bridge ----------------------------------------------------
let telegramOk = false
let lastTelegramChat = null // remember who last messaged the bot, for proactive sends
function syncTelegram() {
  const tok = loadAiConfig().telegramToken
  return startTelegram(tok, (msg) => {
    console.log(`[telegram] in from ${msg.from || msg.chatId}: ${msg.text}`)
    if (msg.chatId && msg.chatId !== lastTelegramChat) {
      lastTelegramChat = msg.chatId
      saveAiConfig({ telegramChat: msg.chatId }) // remember across restarts for proactive sends
    }
    mainWindow?.webContents?.send('telegram:message', msg)
  }).then((ok) => {
    telegramOk = ok
    console.log(`[telegram] bridge ${ok ? 'connected' : 'off'}`)
    return ok
  })
}
ipcMain.handle('telegram:set-token', (_e, tok) => {
  saveAiConfig({ telegramToken: (tok || '').trim() })
  return syncTelegram() // true if the token is valid
})
ipcMain.handle('telegram:status', () => ({ on: telegramOk, hasToken: !!loadAiConfig().telegramToken }))
ipcMain.on('telegram:reply', (_e, { chatId, text }) => sendTelegram(chatId, text))
// proactive send (from the in-app assistant) to the last chat that messaged the bot
ipcMain.handle('telegram:send', async (_e, text) => {
  if (!telegramOk) return { ok: false, error: 'telegram bridge is off (no/invalid token)' }
  const chat = lastTelegramChat || loadAiConfig().telegramChat
  if (!chat) return { ok: false, error: 'no Telegram chat yet — message the bot once so I know where to send' }
  const res = await sendTelegram(chat, text) // await the API so we report real delivery, not a false success
  if (res && res.ok) return { ok: true }
  return { ok: false, error: res?.description || 'Telegram did not confirm delivery (message not sent)' }
})

// ---- Google Calendar (read-only import) ---------------------------------
ipcMain.handle('google:connect', () => googleConnect())
ipcMain.handle('google:list-accounts', () => googleListAccounts())
ipcMain.handle('google:disconnect', (_e, email) => googleRemove(email))
ipcMain.handle('google:set-calendars', (_e, { email, ids }) => googleSetCalendars(email, ids))
ipcMain.handle('google:list-events', async (_e, { from, to, email }) => {
  const events = await googleListEvents(email || 'all', from, to)
  // an instance counts as imported if its own id OR its series id was imported
  const seriesGid = (ev) => (ev.recurringEventId ? `${ev.account}:${ev.calendarId}:${ev.recurringEventId}` : null)
  const gids = []
  for (const ev of events) {
    gids.push(ev.googleEventId)
    const s = seriesGid(ev)
    if (s) gids.push(s)
  }
  const map = importedMap(gids)
  return events.map((ev) => {
    const s = seriesGid(ev)
    const day = map[ev.googleEventId] ?? (s ? map[s] : undefined)
    return { ...ev, imported: day !== undefined, importedDay: day ?? null }
  })
})
ipcMain.handle('google:event-recurrence', (_e, { email, calId, recurringEventId }) =>
  googleEventRecurrence(email, calId, recurringEventId)
)
// after we change anything ON Google, tell the renderer so the Appointments
// agenda re-fetches that range (the new/updated/removed event shows at once)
const broadcastGoogleChanged = () => mainWindow?.webContents?.send('google:changed')
ipcMain.handle('google:create-event', async (_e, { email, calendarId, event }) => {
  const r = await googleCreateEvent(email, calendarId, event)
  if (r?.ok) broadcastGoogleChanged()
  return r
})
ipcMain.handle('google:update-event', async (_e, { gid, event }) => {
  const r = await googleUpdateEvent(gid, event)
  if (r?.ok && !r.skipped) broadcastGoogleChanged()
  return r
})
ipcMain.handle('google:delete-event', async (_e, gid) => {
  const r = await googleDeleteEvent(gid)
  if (r?.ok && !r.skipped) broadcastGoogleChanged()
  return r
})
ipcMain.handle('google:writable-calendars', () => googleWritableCalendars())
ipcMain.handle('google:event-writable', (_e, gid) => googleEventWritable(gid))

// ---- Mail (IMAP, app-password) — independent of the calendar OAuth ---------
ipcMain.handle('mail:list-accounts', () => getMailAccounts())
ipcMain.handle('mail:send', (_e, payload) => sendMail(payload || {}))
ipcMain.handle('mail:contacts', () => mailContacts())
ipcMain.handle('mail:add', (_e, payload) => addMailAccount(payload || {}))
ipcMain.handle('mail:remove', (_e, email) => removeMailAccount(email))
ipcMain.handle('mail:test', (_e, email) => testInbox(email))
ipcMain.handle('mail:folders', (_e, email) => mailFolders(email))
ipcMain.handle('mail:messages', (_e, { account, label, limit }) => listMailMessages(account, label, limit))
ipcMain.handle('mail:cached', (_e, p) => cachedMessages(p || {}))
ipcMain.handle('mail:load', (_e, p) => {
  // a `token` opts the caller into progressive loading: a fast approximate page is pushed
  // via 'mail:load-partial' first, then this promise resolves with the exact full page
  const token = p?.token
  const onPartial = token != null ? (r) => mainWindow?.webContents?.send('mail:load-partial', { token, ...r }) : null
  return loadMessages(p || {}, onPartial)
})
ipcMain.handle('mail:recent', (_e, p) => recentMessages(p || {}))
ipcMain.handle('mail:folder-stats', (_e, { email, paths }) => mailFolderStats(email, paths))
ipcMain.handle('mail:category-stats', (_e, account) => mailCategoryStats(account))
ipcMain.handle('mail:set-important', (_e, p) => setMailImportant(p || {}))
ipcMain.handle('mail:thread', (_e, p) => {
  // a `token` opts into streaming: each message is pushed via 'mail:thread-message' as its
  // body downloads (newest first), so the UI shows the first one without waiting for the chain
  const token = p?.token
  const onMessage = token != null ? (m, total) => mainWindow?.webContents?.send('mail:thread-message', { token, message: m, total }) : null
  return getMailThread(p || {}, onMessage)
})
ipcMain.handle('mail:clear-cache', () => ({ ok: true, removed: clearMailCache() }))
ipcMain.handle('mail:set-seen', (_e, p) => setMailSeen(p || {}))
ipcMain.handle('mail:inline-images', (_e, { html }) => inlineMailImages({ html }))
ipcMain.handle('mail:open-attachment', (_e, p) => openMailAttachment(p || {}))
ipcMain.handle('mail:delete', (_e, p) => deleteMail(p || {}))
ipcMain.handle('mail:bulk-delete', (_e, p) => bulkDeleteMail(p || {}))
ipcMain.handle('mail:bulk-seen', (_e, p) => bulkSeenMail(p || {}))
// whole-folder search, streaming matches to the renderer in batches (token drops stale)
ipcMain.handle('mail:search', async (_e, { account, folder, query, token }) => {
  const send = (messages, done) => mainWindow?.webContents?.send('mail:search-result', { token, messages, done })
  try {
    await searchMessages({ account, folder, query }, (metas) => send(metas, false))
    send([], true)
    return { ok: true }
  } catch (e) {
    send([], true)
    return { ok: false, error: e.message }
  }
})
// mark a whole folder read in the background, streaming progress to the renderer
ipcMain.handle('mail:mark-folder-read', async (_e, { account, folder }) => {
  const send = (done, total, running) =>
    mainWindow?.webContents?.send('mail:mark-progress', { account, folder, done, total, running })
  send(0, 0, true)
  try {
    const r = await markFolderRead({ account, folder }, (done, total) => send(done, total, true))
    send(r.marked, r.total || r.marked, false)
    return r
  } catch (e) {
    send(0, 0, false)
    return { ok: false, error: e.message }
  }
})
// permanently empty Trash in the background (reuses the mark-progress channel → same
// spinner+% next to the folder)
ipcMain.handle('mail:empty-folder', async (_e, { account, folder }) => {
  const send = (done, total, running) =>
    mainWindow?.webContents?.send('mail:mark-progress', { account, folder, done, total, running })
  send(0, 0, true)
  try {
    const r = await emptyFolder({ account, folder }, (done, total) => send(done, total, true))
    send(r.deleted || 0, r.deleted || 0, false)
    return r
  } catch (e) {
    send(0, 0, false)
    return { ok: false, error: e.message }
  }
})
// move all READ messages in a folder to Trash (same spinner+% via mark-progress)
ipcMain.handle('mail:delete-read', async (_e, { account, folder }) => {
  const send = (done, total, running) =>
    mainWindow?.webContents?.send('mail:mark-progress', { account, folder, done, total, running })
  send(0, 0, true)
  try {
    const r = await deleteReadInFolder({ account, folder }, (done, total) => send(done, total, true))
    send(r.deleted || 0, r.total || r.deleted || 0, false)
    return r
  } catch (e) {
    send(0, 0, false)
    return { ok: false, error: e.message }
  }
})
// translate email text via the built-in AI — uses whichever engine is selected
ipcMain.handle('mail:translate', async (_e, { segments, lang }) => {
  const cli = loadSettings().ai || 'agy'
  const target = lang || 'English'
  const prompt =
    `You are a translation engine. Translate each text segment below into ${target}. ` +
    `Detect each segment's source language automatically and keep the meaning, tone and any punctuation/emoji. ` +
    `Return ONLY a minified JSON object mapping each segment's number (as a string key) to its translated text — ` +
    `no markdown, no code fences, no commentary. If a segment is already in ${target}, return it unchanged.\n\n` +
    `Segments:\n${JSON.stringify(segments)}`
  let res
  // isolated one-shot per engine — translation must NOT share the chat conversation
  // (a shared session lets the chat persona bleed in and breaks the JSON output)
  if (cli === 'claude') res = await askClaudeRaw(prompt)
  else if (cli === 'codex') {
    const cfg = loadAiConfig()
    res = await askCodex({ messages: [{ role: 'user', content: prompt }], ctx: '', model: cfg.codexModel, reasoning: cfg.codexReasoning })
  } else {
    res = await agyAskRaw(prompt, loadAiConfig().agyModel) // agy: isolated, no calendar guard
  }
  const reply = typeof res === 'string' ? res : res?.text || ''
  if (!reply) return { ok: false, error: res?.error || 'translate failed' }
  const m = reply.match(/\{[\s\S]*\}/)
  if (!m) return { ok: false, error: 'no JSON in reply' }
  try {
    return { ok: true, map: JSON.parse(m[0]) }
  } catch {
    return { ok: false, error: 'bad JSON in reply' }
  }
})

// one-shot AI call, no calendar guard — used for article reading/summarizing
async function askRawAI(prompt) {
  const cli = loadSettings().ai || 'agy'
  // isolated one-shot (NOT the shared chat session) — otherwise the calendar system
  // prompt bleeds in and the summary ends with a stray ```calendar [...]``` block
  if (cli === 'claude') return askClaudeRaw(prompt)
  if (cli === 'codex') {
    const cfg = loadAiConfig()
    return askCodex({ messages: [{ role: 'user', content: prompt }], ctx: '', model: cfg.codexModel, reasoning: cfg.codexReasoning })
  }
  return agyAskRaw(prompt, loadAiConfig().agyModel)
}

// read an in-app-browser article through the AI: translate to `lang` (or keep the
// source language) and condense to `level` (full / medium / brief / key points).
// Returns clean plain text — ready to show in the reader panel and to read aloud.
ipcMain.handle('mail:read-article', async (_e, { title, text, lang, level }) => {
  const target = lang && lang !== 'original' ? lang : null
  const body = `${title ? 'TITLE: ' + title + '\n\n' : ''}${text || ''}`.slice(0, 24000)
  if (!body.trim()) return { ok: false, error: 'no article text' }
  const langLine = target
    ? `Write EVERYTHING in ${target} — including the title and every heading. Translate from whatever language the article is in; do NOT leave the title, any heading or any phrase in the original language.`
    : 'Write the result in the same language as the article.'
  const levelLine = {
    full: 'Reproduce the full article faithfully — do not shorten, just clean it into readable paragraphs.',
    medium: 'Condense the article to about half its length, keeping all the important details.',
    brief: 'Summarize the article briefly in a few short paragraphs — the key facts only.',
    key: 'Extract only the key points as a short bullet list (start each line with "• ").'
  }[level || 'full']
  const prompt =
    'You are a reading assistant. Below is the text of a web article (it may include menu/ads noise — ignore any non-article text). ' +
    `${levelLine} ${langLine} ` +
    'It will be read aloud, so write every number, unit and abbreviation as full words in the correct grammatical form ' +
    '— use ORDINALS for years and dates (e.g. "2026 год" → "две тысячи двадцать шестой год"), and make units agree with the number ' +
    '(e.g. "5 МБ" → "пять мегабайт", "2 КБ" → "два килобайта", "10 %" → "десять процентов", "3 km" → "three kilometers"). ' +
    `Begin with the article's title${target ? ' (also in ' + target + ')' : ''} on the first line. ` +
    'Return ONLY the resulting plain text — no markdown headers, no code fences, no commentary.\n\n' +
    `ARTICLE:\n${body}`
  const res = await askRawAI(prompt)
  const reply = typeof res === 'string' ? res : res?.text || ''
  if (!reply) return { ok: false, error: res?.error || 'failed' }
  return { ok: true, text: reply.trim() }
})

// our language names → Google Translate codes (for the in-app browser's fast translate)
const GLANG = {
  Ukrainian: 'uk', English: 'en', Russian: 'ru', German: 'de', French: 'fr', Spanish: 'es',
  Polish: 'pl', Italian: 'it', Portuguese: 'pt', Chinese: 'zh-CN', Japanese: 'ja'
}

// fast, free web-page translation via Google's public gtx endpoint (no API key) — used
// by the in-app browser so switching language is instant (summarizing still uses the AI).
// Segments are joined with \n into length-capped batches; the endpoint preserves the line
// boundaries, so the result splits back 1:1. If a batch's boundaries don't line up, it
// falls back to translating that batch one segment at a time.
ipcMain.handle('mail:web-translate', async (_e, { segments, lang }) => {
  const tl = GLANG[lang]
  if (!tl) return { ok: false, error: 'unsupported language' }
  const entries = Object.entries(segments || {})
  if (!entries.length) return { ok: true, map: {} }
  const MAX = 900 // raw chars per request — the URL-encoded query then stays under the limit
  const call = async (text) => {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`
    const r = await fetch(url)
    if (!r.ok) throw new Error('http ' + r.status)
    const j = await r.json()
    return (j[0] || []).map((s) => s[0]).join('')
  }
  // split an over-long segment into <=MAX pieces on a space boundary
  const splitLong = (s) => {
    const out = []
    let rest = s
    while (rest.length > MAX) {
      let cut = rest.lastIndexOf(' ', MAX)
      if (cut < MAX * 0.5) cut = MAX
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    if (rest) out.push(rest)
    return out
  }
  const map = {}
  let batch = [] // small segments translated together (joined by \n; boundaries survive)
  let len = 0
  const flush = async () => {
    if (!batch.length) return
    const out = (await call(batch.map((b) => b.t).join('\n'))).split('\n')
    if (out.length === batch.length) batch.forEach((b, i) => (map[b.k] = out[i]))
    else for (const b of batch) map[b.k] = await call(b.t)
    batch = []
    len = 0
  }
  try {
    for (const [k, v] of entries) {
      const t = String(v).replace(/\s*\n\s*/g, ' ') // inner newlines would desync the split
      if (t.length > MAX) {
        await flush() // long segment on its own: translate its chunks, then join back
        const tr = []
        for (const p of splitLong(t)) tr.push(await call(p))
        map[k] = tr.join('')
        continue
      }
      if (len + t.length > MAX) await flush()
      batch.push({ k, t })
      len += t.length + 1
    }
    await flush()
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
  return { ok: true, map }
})
ipcMain.handle('mail:saved-path', (_e, { account, mid, part }) => getSavedAttachment(account, mid, part))
ipcMain.handle('mail:reveal-saved', (_e, path) => {
  if (path) shell.showItemInFolder(path)
  return true
})
ipcMain.handle('google:set-autosync', (_e, { email, ids }) => googleSetAutoSync(email, ids))
ipcMain.handle('google:autosync-calendars', () => googleAutoSyncCalendars())
ipcMain.handle('settings:get-sync-interval', () => loadAiConfig().googleSyncInterval || 0)
ipcMain.on('settings:set-sync-interval', (_e, minutes) => {
  saveAiConfig({ googleSyncInterval: Number(minutes) || 0 })
  rescheduleGoogleSync()
})

// periodic Google → local sync: every N minutes, ask the renderer to pull
// auto-sync calendars into notes (it reuses the import logic). 0 = off.
let googleSyncTimer = null
function rescheduleGoogleSync() {
  if (googleSyncTimer) clearInterval(googleSyncTimer)
  googleSyncTimer = null
  const min = loadAiConfig().googleSyncInterval || 0
  if (min > 0) googleSyncTimer = setInterval(() => mainWindow?.webContents?.send('google:autosync'), min * 60000)
}
// cheap (DB-only, no network) re-check of import status — used to refresh the
// Appointments tab the instant a note is added/deleted
ipcMain.handle('google:imported-status', (_e, items) => {
  const seriesGid = (it) => (it.recurringEventId ? `${it.account}:${it.calendarId}:${it.recurringEventId}` : null)
  const gids = []
  for (const it of items || []) {
    gids.push(it.googleEventId)
    const s = seriesGid(it)
    if (s) gids.push(s)
  }
  const map = importedMap(gids)
  const out = {}
  for (const it of items || []) {
    const s = seriesGid(it)
    const day = map[it.googleEventId] ?? (s ? map[s] : undefined)
    out[it.googleEventId] = { imported: day !== undefined, importedDay: day ?? null }
  }
  return out
})
ipcMain.handle('google:mark-imported', (_e, p) => {
  markEventImported(p)
  return { ok: true }
})
// undo an import: delete the linked note and clear the mark (instance or series)
ipcMain.handle('google:unimport', (_e, it) => {
  const seriesGid = it?.recurringEventId ? `${it.account}:${it.calendarId}:${it.recurringEventId}` : null
  for (const gid of [it?.googleEventId, seriesGid].filter(Boolean)) {
    const row = getImport(gid)
    if (!row) continue
    const arr = (getItems(row.day) || []).filter((x) => x.id !== row.note_id)
    saveItems(row.day, arr)
    clearReminder(row.note_id)
    unmarkImport(gid)
    mainWindow?.webContents?.send('items:changed', row.day)
  }
  return { ok: true }
})

// open an external https URL in the system browser (e.g. Google Calendar)
ipcMain.handle('app:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url)
  return true
})

ipcMain.handle('aiConfig:path', () => aiConfigPath())
ipcMain.handle('aiConfig:open', () => shell.openPath(aiConfigPath()))
ipcMain.handle('aiConfig:reveal', () => {
  shell.showItemInFolder(aiConfigPath())
  return true
})
// change the CURRENT engine's model, then restart it so the change takes effect
ipcMain.handle('ai:set-model', (_e, { model, reasoning } = {}) => {
  const cli = loadSettings().ai || 'agy'
  const key = { claude: 'claudeModel', codex: 'codexModel', agy: 'agyModel' }[cli] || 'agyModel'
  const patch = { [key]: model || '' }
  if (cli === 'codex' && reasoning) patch.codexReasoning = reasoning
  saveAiConfig(patch)
  warmAi(cli)
  return loadAiConfig()
})

// ---- AI memory + self-tasks (viewable/editable in Settings) -------------
function broadcastAiData() {
  mainWindow?.webContents?.send('aiData:changed')
}
ipcMain.handle('memory:get', () => allMemory())
ipcMain.handle('memory:add', (_e, text) => {
  const row = addMemory(text)
  broadcastAiData()
  return row
})
ipcMain.handle('memory:delete', (_e, id) => {
  deleteMemory(id)
  broadcastAiData()
})
ipcMain.handle('aiTask:get', () => allAiTasks())
ipcMain.handle('aiTask:add', (_e, payload) => {
  const row = addAiTask(payload)
  if (row) scheduleAiTask(row)
  broadcastAiData()
  return row
})

ipcMain.handle('aiTask:update', (_e, { id, payload }) => {
  const row = updateAiTask(id, payload || {})
  if (row) {
    cancelAiTask(id) // drop the old timer, then re-arm with the new schedule
    scheduleAiTask(row)
  }
  broadcastAiData()
  return row
})
ipcMain.handle('aiTask:delete', (_e, id) => {
  cancelAiTask(id)
  deleteAiTask(id)
  broadcastAiData()
})

// ---- mail watcher tasks (viewable/editable in Settings) -----------------
ipcMain.handle('mailTask:get', () => allMailTasks())
ipcMain.handle('mailTask:add', (_e, payload) => {
  const row = addMailTask(payload)
  if (row) scheduleMailTask(row)
  broadcastAiData()
  return row
})
ipcMain.handle('mailTask:update', (_e, { id, payload }) => {
  const row = updateMailTask(id, payload || {})
  cancelMailTask(id) // drop the old timer, then re-arm (or leave off if now disabled)
  if (row) scheduleMailTask(row)
  broadcastAiData()
  return row
})
ipcMain.handle('mailTask:delete', (_e, id) => {
  cancelMailTask(id)
  deleteMailTask(id)
  broadcastAiData()
})

// ---- attachments: files linked to notes ---------------------------------
function broadcastAttach(noteId) {
  mainWindow?.webContents?.send('attach:changed', { noteId })
}
ipcMain.handle('attach:list', (_e, noteId) => attachmentsFor(noteId))
ipcMain.handle('attach:add', async (_e, noteId) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach files'
  })
  if (!r.canceled) {
    for (const p of r.filePaths) addAttachment(noteId, p)
    broadcastAttach(noteId)
  }
  return attachmentsFor(noteId)
})
ipcMain.handle('attach:addPath', (_e, { noteId, path }) => {
  const row = addAttachment(noteId, path)
  if (row) broadcastAttach(noteId)
  return row
})
ipcMain.handle('attach:remove', (_e, id) => {
  const a = attachmentById(id)
  removeAttachment(id)
  broadcastAttach(a?.note_id)
  return true
})
ipcMain.handle('attach:open', (_e, id) => {
  const a = attachmentById(id)
  return a?.path ? shell.openPath(a.path) : 'not found'
})
ipcMain.on('dev:devtools', () => mainWindow?.webContents?.toggleDevTools())
// navigator.clipboard.writeText is blocked in Electron → use the native module
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text ?? '')))
ipcMain.handle('attach:reveal', (_e, id) => {
  const a = attachmentById(id)
  if (a?.path) shell.showItemInFolder(a.path) // open the containing folder in Explorer
  return true
})
// the OS file-type icon (by extension) as a data URL, for the attachments list
ipcMain.handle('attach:icon', async (_e, id) => {
  const a = attachmentById(id)
  if (!a?.path) return null
  try {
    const img = await app.getFileIcon(a.path, { size: 'small' })
    return img.isEmpty() ? null : img.toDataURL()
  } catch {
    return null
  }
})
// OS icon for a file TYPE (by extension) — for mail attachments that aren't on
// disk yet. Probes with an empty temp file of that extension; cached per type.
const mailIconCache = new Map()
ipcMain.handle('mail:file-icon', async (_e, ext) => {
  const key = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!key) return null
  if (mailIconCache.has(key)) return mailIconCache.get(key)
  try {
    const dir = join(app.getPath('temp'), 'calendar-iconprobe')
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `probe.${key}`)
    if (!existsSync(probe)) writeFileSync(probe, '')
    const img = await app.getFileIcon(probe, { size: 'small' })
    const url = img.isEmpty() ? null : img.toDataURL()
    mailIconCache.set(key, url)
    return url
  } catch {
    mailIconCache.set(key, null)
    return null
  }
})
ipcMain.handle('ai:clear', () => {
  const cli = loadSettings().ai || 'agy'
  if (cli === 'claude') return clearClaude()
  if (cli === 'codex') {
    resetCodex() // codex: next turn starts a fresh session
    return true
  }
  resetAgy() // agy (default): next turn starts a fresh conversation
  return true
})

// ---- text-to-speech ----------------------------------------------------
ipcMain.handle('tts:speak', (_e, payload) => speak(payload))
ipcMain.handle('tts:synth', (_e, payload) => synthesize(payload))
ipcMain.handle('supertonic:status', () => getSupertonicStatus())
ipcMain.handle('supertonic:download', () => startSupertonicDownload())
ipcMain.handle('settings:get-tts-engine', () => loadSettings().ttsEngine || 'piper')
ipcMain.on('settings:set-tts-engine', (_e, engine) => {
  const s = loadSettings()
  s.ttsEngine = ['windows', 'supertonic'].includes(engine) ? engine : 'piper'
  saveSettings(s)
})
ipcMain.handle('settings:get-supertonic-voice', () => loadSettings().supertonicVoice || 'F1')
ipcMain.on('settings:set-supertonic-voice', (_e, voice) => {
  const ok = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'].includes(voice)
  const s = loadSettings()
  s.supertonicVoice = ok ? voice : 'F1'
  saveSettings(s)
})
ipcMain.handle('settings:get-piper-voice', () => {
  const v = loadSettings().piperVoice
  return v == null ? 2 : v
})
ipcMain.on('settings:set-piper-voice', (_e, voice) => {
  const s = loadSettings()
  s.piperVoice = [0, 1, 2].includes(voice) ? voice : 2
  saveSettings(s)
})
ipcMain.handle('settings:get-tts-speed', (_e, engine) => {
  const v = loadSettings()[engine + 'Speed']
  return v == null ? 1 : v
})
ipcMain.on('settings:set-tts-speed', (_e, { engine, value }) => {
  if (!['piper', 'windows', 'supertonic'].includes(engine)) return
  const s = loadSettings()
  s[engine + 'Speed'] = Math.max(0.5, Math.min(2, Number(value) || 1))
  saveSettings(s)
})
// silent text notification (toast near the clock, no voice)
ipcMain.on('notify:push', (_e, text) => pushMessage({ title: 'Calendar', body: String(text || '') }))

// ---- auto-update (electron-updater, reads the GitHub release) -----------
const { autoUpdater } = electronUpdater
const UPDATE_TXT = {
  en: (v) => ({ msg: `Version ${v} is ready to install.`, restart: 'Restart now', later: 'Later', title: 'Update' }),
  uk: (v) => ({ msg: `Версія ${v} готова до встановлення.`, restart: 'Перезапустити', later: 'Пізніше', title: 'Оновлення' })
}
function initAutoUpdate() {
  if (!app.isPackaged) return // only the built app has a release to update from
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', async (info) => {
    const lang = loadSettings().language === 'uk' ? 'uk' : 'en'
    const t = (UPDATE_TXT[lang] || UPDATE_TXT.en)(info.version)
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: [t.restart, t.later],
      defaultId: 0,
      cancelId: 1,
      title: t.title,
      message: t.msg
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })
  autoUpdater.on('error', () => {}) // never let an update hiccup crash the app
  autoUpdater.checkForUpdates().catch(() => {})
}

// a > b for "1.2.3"-style versions
function isNewerVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  }
  return false
}

// manual "check for updates" (Settings button). If a newer release exists, the
// download starts (autoDownload) and the usual "restart to install" dialog
// appears when it finishes — this just reports what was found.
ipcMain.handle('update:check', async () => {
  const version = app.getVersion()
  if (!app.isPackaged) return { status: 'dev', version }
  try {
    const r = await autoUpdater.checkForUpdates()
    const latest = r?.updateInfo?.version
    if (latest && isNewerVersion(latest, version)) return { status: 'available', version: latest }
    return { status: 'latest', version }
  } catch {
    return { status: 'error', version }
  }
})

// ---- single instance + lifecycle ---------------------------------------
// allow the app to start audio (TTS) WITHOUT a prior click — the webPreferences
// autoplayPolicy isn't reliably applied to the Web Audio API, but this Chromium
// command-line switch is. Must be set before the app is ready. So the говорилка
// (local TTS server / Telegram / AI) plays immediately, even right after a restart.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(() => {
    app.setAppUserModelId('com.calendar.app')

    // harden the in-app mail browser <webview>: no node access / no preload, and
    // keep popups (target=_blank, window.open) inside the viewer instead of spawning
    // OS windows
    app.on('will-attach-webview', (_e, webPreferences) => {
      delete webPreferences.preload
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
    })
    app.on('web-contents-created', (_e, contents) => {
      if (contents.getType() !== 'webview') return
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) contents.loadURL(url)
        return { action: 'deny' }
      })
    })

    createWindow()
    createTray()
    initDb()
    ensureAiConfig()
    migrateNotesJson()
    initNotify({
      preload: join(__dirname, '../preload/index.js'),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      getMain: () => mainWindow,
      showMain: showWindow,
      getSound: () => loadSettings().reminderSound !== false,
      getWorkingDays: () => workingDays()
    })
    scheduleStoredReminders()
    initAiTasks({
      onFire: (task) =>
        mainWindow?.webContents?.send('aiTask:fire', { text: task.text, channel: task.channel, notify: task.notify })
    })
    scheduleAllAiTasks()
    // mail watcher: new mail (only) → pinch the AI with the task prompt + the new messages
    initMailWatch({
      onFire: (task, messages) =>
        mainWindow?.webContents?.send('mailTask:fire', {
          prompt: task.prompt,
          account: task.account,
          folder: task.folder,
          messages: messages.map((m) => ({
            account: m.account,
            threadId: m.threadId,
            id: m.id,
            from: m.from,
            subject: m.subject,
            date: m.date,
            unread: m.unread
          }))
        })
    })
    scheduleAllMailTasks()
    rescheduleGoogleSync()
    initTts({ getMain: () => mainWindow })
    initSupertonicDownload({ onState: (s) => mainWindow?.webContents?.send('supertonic:progress', s) })
    setTtsEngine(() => loadSettings().ttsEngine || 'piper')
    setSupertonicVoice(() => loadSettings().supertonicVoice || 'F1')
    setPiperVoice(() => {
      const v = loadSettings().piperVoice
      return v == null ? 2 : v
    })
    setSpeedResolver((engine) => {
      const v = loadSettings()[engine + 'Speed']
      return v == null ? 1 : v
    })
    startTtsServer()
    syncTelegram()
    warmAi(loadSettings().ai || 'agy')
    initAutoUpdate()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    stopClaude()
    stopTtsServer()
    stopTelegram()
  })
}
