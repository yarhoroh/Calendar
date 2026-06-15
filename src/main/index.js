import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { detectGemini, installGemini } from './tools/gemini'
import { initDb, getItems, saveItems, itemsWithTime, isEmpty, importMap } from './db'
import {
  initNotify,
  scheduleReminder,
  clearReminder,
  scheduleAll,
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
      sandbox: false
    }
  })

  if (saved.maximized) mainWindow.maximize()
  if (saved.pinned) mainWindow.setAlwaysOnTop(true)

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
ipcMain.on('items:save', (_e, key, items) => saveItems(key, items))

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
  const map = {}
  for (const it of itemsWithTime()) (map[it.day] = map[it.day] || []).push(it)
  scheduleAll(map)
}

// ---- reminders & notifications (see ./notify) --------------------------
ipcMain.on('reminder:set', (_e, { id, when, dayKey, title, body }) => {
  scheduleReminder({ id, dayKey, title: title || 'Calendar', body: body || '' }, new Date(when).getTime())
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
ipcMain.handle('gemini:detect', () => detectGemini())
ipcMain.handle('gemini:install', () => installGemini())

// ---- single instance + lifecycle ---------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(() => {
    app.setAppUserModelId('com.calendar.app')
    createWindow()
    createTray()
    initDb()
    migrateNotesJson()
    initNotify({
      preload: join(__dirname, '../preload/index.js'),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      getMain: () => mainWindow,
      showMain: showWindow,
      getSound: () => loadSettings().reminderSound !== false
    })
    scheduleStoredReminders()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
