import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // custom titlebar controls
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  setAlwaysOnTop: (flag) => ipcRenderer.send('window:set-always-on-top', flag),
  getWindowState: () => ipcRenderer.invoke('window:get-state'),

  // close dialog actions
  hideToTray: (remember) => ipcRenderer.send('window:hide-to-tray', remember),
  quit: (remember) => ipcRenderer.send('window:quit', remember),

  // theme persistence
  getTheme: () => ipcRenderer.invoke('settings:get-theme'),
  setTheme: (theme) => ipcRenderer.send('settings:set-theme', theme),
  onThemeChange: (cb) => ipcRenderer.on('theme:set', (_e, theme) => cb(theme)),

  // calendar settings persistence
  getCalendar: () => ipcRenderer.invoke('settings:get-calendar'),
  setCalendar: (patch) => ipcRenderer.send('settings:set-calendar', patch),

  // language persistence
  getLanguage: () => ipcRenderer.invoke('settings:get-language'),
  setLanguage: (lang) => ipcRenderer.send('settings:set-language', lang),

  // notes store (per date)
  getItems: (key) => ipcRenderer.invoke('items:get', key),
  saveItems: (key, items) => ipcRenderer.send('items:save', key, items),

  // reminders (in-app toasts)
  setReminder: (payload) => ipcRenderer.send('reminder:set', payload),
  clearReminder: (id) => ipcRenderer.send('reminder:clear', id),
  onReminderFire: (cb) => ipcRenderer.on('reminder:fire', (_e, payload) => cb(payload)),
  onReminderOpen: (cb) => ipcRenderer.on('reminder:open', (_e, dayKey) => cb(dayKey)),
  getReminderDuration: () => ipcRenderer.invoke('settings:get-reminder-duration'),
  setReminderDuration: (v) => ipcRenderer.send('settings:set-reminder-duration', v),
  notifyResize: (height) => ipcRenderer.send('notify:resize', height),
  notifyOpen: (dayKey) => ipcRenderer.send('notify:open', dayKey),

  // autostart
  getAutostart: () => ipcRenderer.invoke('settings:get-autostart'),
  setAutostart: (flag) => ipcRenderer.send('settings:set-autostart', flag),

  // reminder sound
  getReminderSound: () => ipcRenderer.invoke('settings:get-reminder-sound'),
  setReminderSound: (flag) => ipcRenderer.send('settings:set-reminder-sound', flag),

  // local AI tools
  gemini: {
    detect: () => ipcRenderer.invoke('gemini:detect'),
    install: () => ipcRenderer.invoke('gemini:install')
  },

  // events from main
  onConfirmClose: (cb) => ipcRenderer.on('window:confirm-close', () => cb()),
  onMaximized: (cb) => ipcRenderer.on('window:maximized', (_e, value) => cb(value))
}

contextBridge.exposeInMainWorld('api', api)
