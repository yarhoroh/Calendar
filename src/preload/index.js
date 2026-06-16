import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  // custom titlebar controls
  getVersion: () => ipcRenderer.invoke('app:version'),
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
  onItemsChanged: (cb) => {
    const handler = (_e, key) => cb(key)
    ipcRenderer.on('items:changed', handler)
    return () => ipcRenderer.removeListener('items:changed', handler)
  },

  // folders (per-board note trees)
  listFolders: (board) => ipcRenderer.invoke('folders:list', board),
  addFolder: (payload) => ipcRenderer.invoke('folders:add', payload),
  renameFolder: (id, name) => ipcRenderer.invoke('folders:rename', { id, name }),
  moveFolder: (id, parentId) => ipcRenderer.invoke('folders:move', { id, parentId }),
  deleteFolder: (id) => ipcRenderer.invoke('folders:delete', id),
  onFoldersChanged: (cb) => {
    const h = () => cb()
    ipcRenderer.on('folders:changed', h)
    return () => ipcRenderer.removeListener('folders:changed', h)
  },

  // custom note statuses
  listStatuses: () => ipcRenderer.invoke('statuses:list'),
  addStatus: (payload) => ipcRenderer.invoke('statuses:add', payload),
  updateStatus: (id, patch) => ipcRenderer.invoke('statuses:update', { id, patch }),
  deleteStatus: (id) => ipcRenderer.invoke('statuses:delete', id),
  onStatusesChanged: (cb) => {
    const h = () => cb()
    ipcRenderer.on('statuses:changed', h)
    return () => ipcRenderer.removeListener('statuses:changed', h)
  },

  // AI chat
  detectClaude: () => ipcRenderer.invoke('ai:detect-claude'),
  detectCodex: () => ipcRenderer.invoke('ai:detect-codex'),
  getAi: () => ipcRenderer.invoke('settings:get-ai'),
  setAi: (v) => ipcRenderer.send('settings:set-ai', v),
  aiSend: (payload) => ipcRenderer.invoke('ai:send', payload),
  aiClear: () => ipcRenderer.invoke('ai:clear'),
  getAiConfig: () => ipcRenderer.invoke('aiConfig:get'),
  setAiConfig: (patch) => ipcRenderer.invoke('aiConfig:set', patch),
  setTelegramToken: (tok) => ipcRenderer.invoke('telegram:set-token', tok),
  getTelegramStatus: () => ipcRenderer.invoke('telegram:status'),
  telegramReply: (chatId, text) => ipcRenderer.send('telegram:reply', { chatId, text }),
  onTelegramMessage: (cb) => {
    const h = (_e, m) => cb(m)
    ipcRenderer.on('telegram:message', h)
    return () => ipcRenderer.removeListener('telegram:message', h)
  },
  getAiConfigPath: () => ipcRenderer.invoke('aiConfig:path'),
  openAiConfig: () => ipcRenderer.invoke('aiConfig:open'),
  revealAiConfig: () => ipcRenderer.invoke('aiConfig:reveal'),
  setModel: (model, reasoning) => ipcRenderer.invoke('ai:set-model', { model, reasoning }),
  ttsSpeak: (payload) => ipcRenderer.invoke('tts:speak', payload),
  getTtsEngine: () => ipcRenderer.invoke('settings:get-tts-engine'),
  setTtsEngine: (engine) => ipcRenderer.send('settings:set-tts-engine', engine),
  notify: (text) => ipcRenderer.send('notify:push', text),
  onTtsPlay: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('tts:play', h)
    return () => ipcRenderer.removeListener('tts:play', h)
  },

  // AI memory + self-tasks
  getMemory: () => ipcRenderer.invoke('memory:get'),
  addMemory: (text) => ipcRenderer.invoke('memory:add', text),
  deleteMemory: (id) => ipcRenderer.invoke('memory:delete', id),
  getAiTasks: () => ipcRenderer.invoke('aiTask:get'),
  addAiTask: (payload) => ipcRenderer.invoke('aiTask:add', payload),
  deleteAiTask: (id) => ipcRenderer.invoke('aiTask:delete', id),
  onAiDataChanged: (cb) => {
    const h = () => cb()
    ipcRenderer.on('aiData:changed', h)
    return () => ipcRenderer.removeListener('aiData:changed', h)
  },
  onAiTaskFire: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('aiTask:fire', h)
    return () => ipcRenderer.removeListener('aiTask:fire', h)
  },

  // attachments (files linked to notes)
  listAttachments: (noteId) => ipcRenderer.invoke('attach:list', noteId),
  addAttachments: (noteId) => ipcRenderer.invoke('attach:add', noteId),
  pathForFile: (file) => webUtils.getPathForFile(file), // OS drag-and-drop → real path
  addAttachmentPath: (noteId, path) => ipcRenderer.invoke('attach:addPath', { noteId, path }),
  removeAttachment: (id) => ipcRenderer.invoke('attach:remove', id),
  openAttachment: (id) => ipcRenderer.invoke('attach:open', id),
  onAttachChanged: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('attach:changed', h)
    return () => ipcRenderer.removeListener('attach:changed', h)
  },
  getAiStatus: () => ipcRenderer.invoke('ai:status'),
  onAiStatus: (cb) => {
    const h = (_e, s) => cb(s)
    ipcRenderer.on('ai:status', h)
    return () => ipcRenderer.removeListener('ai:status', h)
  },

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
  getWorkingDays: () => ipcRenderer.invoke('settings:get-working-days'),
  setWorkingDays: (days) => ipcRenderer.send('settings:set-working-days', days),

  // chat field visibility
  getShowChat: () => ipcRenderer.invoke('settings:get-show-chat'),
  setShowChat: (flag) => ipcRenderer.send('settings:set-show-chat', flag),

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
