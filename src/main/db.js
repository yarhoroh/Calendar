import Database from 'better-sqlite3'
import { join, basename } from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'

// Local SQLite store for notes. Reads only the requested day (indexed), so it
// scales regardless of how much history accumulates. The renderer is unaware —
// it talks to the same items IPC as before.

let db = null

export function initDb() {
  db = new Database(join(app.getPath('userData'), 'calendar.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT,
      text TEXT,
      status TEXT,
      time TEXT,
      bold INTEGER,
      italic INTEGER,
      size INTEGER,
      collapsed INTEGER,
      folder_id TEXT,
      days TEXT,
      html TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notes_day ON notes(day);
    CREATE INDEX IF NOT EXISTS idx_notes_time ON notes(time);

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      board TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_id TEXT,
      position INTEGER,
      created TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_folders_board ON folders(board);

    CREATE TABLE IF NOT EXISTS statuses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      position INTEGER,
      created TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_memory (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_tasks (
      id TEXT PRIMARY KEY,
      at TEXT,
      text TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      every INTEGER,
      channel TEXT,
      winfrom TEXT,
      winto TEXT,
      created TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_tasks_at ON ai_tasks(at);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id);

    -- which Google Calendar events were already imported as notes (dedupe).
    -- Keyed by composite google_event_id (email:calId:eventId); authoritative,
    -- independent of the notes table's delete-and-reinsert save model.
    CREATE TABLE IF NOT EXISTS gcal_imports (
      google_event_id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      day TEXT,
      imported_at TEXT
    );
  `)
  // migrate older DBs: add columns added after first release
  try {
    db.exec('ALTER TABLE ai_tasks ADD COLUMN every INTEGER')
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE ai_tasks ADD COLUMN channel TEXT')
  } catch {
    // column already exists
  }
  for (const col of ['winfrom', 'winto']) {
    try {
      db.exec(`ALTER TABLE ai_tasks ADD COLUMN ${col} TEXT`)
    } catch {
      // column already exists
    }
  }
  try {
    db.exec('ALTER TABLE ai_tasks ADD COLUMN notify TEXT') // how an in-app task announces: 'voice','tray','voice,tray'
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN folder_id TEXT')
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN days TEXT')
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN html TEXT')
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN google_event_id TEXT')
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN google_calendar TEXT') // source calendar name (display)
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN google_account TEXT') // source account email (display)
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN google_shared INTEGER') // 1 = local note we pushed to Google (vs imported)
  } catch {
    // column already exists
  }
  try {
    // per-date status overrides for everyday notes projected onto the calendar:
    // JSON map { 'YYYY-MM-DD': '<status>' } so a status set in Today applies to that day only
    db.exec('ALTER TABLE notes ADD COLUMN date_statuses TEXT')
  } catch {
    // column already exists
  }
  // one-time migration: existing plain-text notes get an html body so html is
  // the single source of truth for content going forward (idempotent — only
  // touches notes that have text but no html yet)
  try {
    const rows = db.prepare("SELECT id, text FROM notes WHERE (html IS NULL OR html = '') AND text IS NOT NULL AND text <> ''").all()
    const esc = (s) =>
      String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
    const upd = db.prepare('UPDATE notes SET html = ? WHERE id = ?')
    const tx = db.transaction(() => rows.forEach((r) => upd.run(`<p>${esc(r.text)}</p>`, r.id)))
    tx()
  } catch {
    // ignore migration hiccups
  }
  // index needs the column to exist first (older DBs add it via the ALTER above)
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id)')
  } catch {
    // ignore
  }
}

// plain text from an HTML body — html is the single source of truth; `text` is
// just a derived copy kept for search / the AI
function plainFromHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h1|h2|h3|li|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseDateStatuses(s) {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function rowToItem(r) {
  return {
    id: r.id,
    title: r.title,
    text: r.text || '',
    status: r.status || 'todo',
    dateStatuses: parseDateStatuses(r.date_statuses), // everyday: per-date status overrides
    time: r.time || null,
    bold: !!r.bold,
    italic: !!r.italic,
    size: r.size || 1,
    collapsed: !!r.collapsed,
    folderId: r.folder_id || null,
    days: r.days ? r.days.split(',').map(Number).filter((n) => !Number.isNaN(n)) : null,
    html: r.html || '',
    googleEventId: r.google_event_id || null,
    googleCalendar: r.google_calendar || null,
    googleAccount: r.google_account || null,
    googleShared: !!r.google_shared
  }
}

export function getItems(day) {
  return db.prepare('SELECT * FROM notes WHERE day = ? ORDER BY position').all(day).map(rowToItem)
}

export function saveItems(day, items) {
  const del = db.prepare('DELETE FROM notes WHERE day = ?')
  const ins = db.prepare(`
    INSERT INTO notes (id, day, position, title, text, status, time, bold, italic, size, collapsed, folder_id, days, html, google_event_id, google_calendar, google_account, google_shared, date_statuses)
    VALUES (@id, @day, @position, @title, @text, @status, @time, @bold, @italic, @size, @collapsed, @folder_id, @days, @html, @google_event_id, @google_calendar, @google_account, @google_shared, @date_statuses)
  `)
  const tx = db.transaction((d, list) => {
    del.run(d)
    list.forEach((it, i) =>
      ins.run({
        id: it.id,
        day: d,
        position: i,
        title: it.title ?? null,
        text: it.html ? plainFromHtml(it.html) : it.text ?? '', // keep text in sync with html
        status: it.status ?? 'todo',
        time: it.time ?? null,
        bold: it.bold ? 1 : 0,
        italic: it.italic ? 1 : 0,
        size: it.size || 1,
        collapsed: it.collapsed ? 1 : 0,
        folder_id: it.folderId ?? null,
        days: Array.isArray(it.days) && it.days.length ? it.days.join(',') : null,
        html: it.html ?? null,
        google_event_id: it.googleEventId ?? null,
        google_calendar: it.googleCalendar ?? null,
        google_account: it.googleAccount ?? null,
        google_shared: it.googleShared ? 1 : 0,
        date_statuses:
          it.dateStatuses && Object.keys(it.dateStatuses).length ? JSON.stringify(it.dateStatuses) : null
      })
    )
  })
  tx(day, items || [])
}

// every note that has a reminder time — used to (re)schedule on startup
export function itemsWithTime() {
  return db
    .prepare('SELECT * FROM notes WHERE time IS NOT NULL')
    .all()
    .map((r) => ({ ...rowToItem(r), day: r.day }))
}

// compact dump of every note (for giving the AI context to search/answer)
export function allNotes() {
  return db
    .prepare('SELECT id, day, title, text, status, time, folder_id, html FROM notes ORDER BY day, position')
    .all()
}

// notes for a date range (YYYY-MM-DD strings; boards like 'everyday' sort
// outside date ranges so they're never included accidentally) — for getNotes
export function getItemsRange(from, to) {
  return db
    .prepare('SELECT id, day, title, text, status, time, folder_id, html FROM notes WHERE day >= ? AND day <= ? ORDER BY day, position')
    .all(from, to)
}

export function isEmpty() {
  return db.prepare('SELECT COUNT(*) AS c FROM notes').get().c === 0
}

// ---- Google Calendar import dedupe ----------------------------------------
export function isEventImported(gid) {
  return !!db.prepare('SELECT 1 FROM gcal_imports WHERE google_event_id = ?').get(gid)
}
// resolve an import mark to its note's day, BUT only if the note still exists —
// if the user deleted the imported note, prune the stale mark so the event shows
// as importable again. Returns the day/board string, or undefined if not imported.
function resolveImport(gid) {
  const row = db.prepare('SELECT note_id, day FROM gcal_imports WHERE google_event_id = ?').get(gid)
  if (!row) return undefined
  const exists = db.prepare('SELECT 1 FROM notes WHERE id = ?').get(row.note_id)
  if (exists) return row.day || null
  db.prepare('DELETE FROM gcal_imports WHERE google_event_id = ?').run(gid) // note gone → unmark
  return undefined
}

// given a list of composite ids, return the Set of those still imported
export function importedEventIds(gids) {
  const set = new Set()
  if (!Array.isArray(gids)) return set
  for (const g of gids) if (resolveImport(g) !== undefined) set.add(g)
  return set
}

// map of imported ids → the day/board the note lives on (for the "jump to
// imported note" link). Includes per-instance and per-series ids.
export function importedMap(gids) {
  const out = {}
  if (!Array.isArray(gids)) return out
  for (const g of gids) {
    const day = resolveImport(g)
    if (day !== undefined) out[g] = day
  }
  return out
}
export function markEventImported({ gid, noteId, day }) {
  db.prepare(
    'INSERT OR REPLACE INTO gcal_imports (google_event_id, note_id, day, imported_at) VALUES (?, ?, ?, ?)'
  ).run(gid, noteId, day || null, new Date().toISOString())
}
export function getImport(gid) {
  return db.prepare('SELECT note_id, day FROM gcal_imports WHERE google_event_id = ?').get(gid)
}
export function unmarkImport(gid) {
  db.prepare('DELETE FROM gcal_imports WHERE google_event_id = ?').run(gid)
}

// one-time import from the legacy notes.json map { day: [items] }
export function importMap(map) {
  for (const day of Object.keys(map || {})) saveItems(day, map[day] || [])
}

// ---- AI memory: small persistent facts/preferences the AI keeps -----------
export function allMemory() {
  return db.prepare('SELECT id, text, created FROM ai_memory ORDER BY created').all()
}
export function addMemory(text) {
  const row = { id: randomUUID(), text: String(text || '').trim(), created: new Date().toISOString() }
  if (!row.text) return null
  db.prepare('INSERT INTO ai_memory (id, text, created) VALUES (@id, @text, @created)').run(row)
  return row
}
export function deleteMemory(id) {
  db.prepare('DELETE FROM ai_memory WHERE id = ?').run(id)
}

// ---- AI tasks: scheduled jobs that trigger the AI (one-time or periodic) ---
const TASK_COLS = 'id, at, text, done, every, channel, winfrom, winto, notify, created'
export function allAiTasks() {
  return db.prepare(`SELECT ${TASK_COLS} FROM ai_tasks ORDER BY at`).all()
}
export function pendingAiTasks() {
  return db.prepare(`SELECT ${TASK_COLS} FROM ai_tasks WHERE done = 0 ORDER BY at`).all()
}
export function addAiTask({ at, text, every, channel, from, to, notify }) {
  const mins = Number(every) > 0 ? Math.round(Number(every)) : null
  const row = {
    id: randomUUID(),
    at: String(at || '').trim(), // '' (not null) for periodic — old DBs have at NOT NULL
    text: String(text || '').trim(),
    done: 0,
    every: mins,
    channel: String(channel || '').trim() || null, // e.g. 'telegram:<chatId>'; null = in-app
    winfrom: String(from || '').trim() || null, // daily active window for periodic tasks (HH:mm)
    winto: String(to || '').trim() || null,
    notify: String(notify || '').trim() || null, // in-app announce method: 'voice','tray','voice,tray'; null = AI default
    created: new Date().toISOString()
  }
  // need text, and either a time or a repeat interval
  if (!row.text || (!row.at && !row.every)) return null
  db.prepare(
    'INSERT INTO ai_tasks (id, at, text, done, every, channel, winfrom, winto, notify, created) VALUES (@id, @at, @text, @done, @every, @channel, @winfrom, @winto, @notify, @created)'
  ).run(row)
  return row
}
// edit an existing task (from the manual form). Leaves `channel` untouched so a
// Telegram-sourced task keeps replying to its chat; re-arms it (done=0) so the
// new time/interval fires. Returns the updated row (for rescheduling) or null.
export function updateAiTask(id, { at, text, every, from, to, notify }) {
  const mins = Number(every) > 0 ? Math.round(Number(every)) : null
  const patch = {
    id,
    at: String(at || '').trim(),
    text: String(text || '').trim(),
    every: mins,
    winfrom: String(from || '').trim() || null,
    winto: String(to || '').trim() || null,
    notify: String(notify || '').trim() || null
  }
  if (!patch.text || (!patch.at && !patch.every)) return null
  db.prepare(
    'UPDATE ai_tasks SET at=@at, text=@text, every=@every, winfrom=@winfrom, winto=@winto, notify=@notify, done=0 WHERE id=@id'
  ).run(patch)
  return db.prepare(`SELECT ${TASK_COLS} FROM ai_tasks WHERE id = ?`).get(id) || null
}
export function deleteAiTask(id) {
  db.prepare('DELETE FROM ai_tasks WHERE id = ?').run(id)
}
export function markAiTaskDone(id) {
  db.prepare('UPDATE ai_tasks SET done = 1 WHERE id = ?').run(id)
}

// ---- folders: per-board tree to group/filter notes ------------------------
// board = 'today' | 'everyday' | 'general'; parent_id null = top level (under
// the implicit "General" root). A note's folder_id points at one of these.
function rowToFolder(r) {
  return { id: r.id, board: r.board, name: r.name, parentId: r.parent_id || null, position: r.position || 0 }
}
export function listFolders(board) {
  return db
    .prepare('SELECT id, board, name, parent_id, position FROM folders WHERE board = ? ORDER BY position, name')
    .all(board)
    .map(rowToFolder)
}
export function allFolders() {
  return db.prepare('SELECT id, board, name, parent_id, position FROM folders ORDER BY board, position, name').all().map(rowToFolder)
}
export function addFolder({ board, name, parentId }) {
  const b = String(board || '').trim()
  const nm = String(name || '').trim()
  if (!b || !nm) return null
  const max = db.prepare('SELECT MAX(position) AS m FROM folders WHERE board = ?').get(b)?.m
  const row = {
    id: randomUUID(),
    board: b,
    name: nm,
    parent_id: parentId || null,
    position: (Number(max) || 0) + 1,
    created: new Date().toISOString()
  }
  db.prepare(
    'INSERT INTO folders (id, board, name, parent_id, position, created) VALUES (@id, @board, @name, @parent_id, @position, @created)'
  ).run(row)
  return rowToFolder(row)
}
export function renameFolder(id, name) {
  const nm = String(name || '').trim()
  if (!id || !nm) return { ok: false, error: 'bad-name' }
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(nm, id)
  return { ok: true }
}
// move a folder under a new parent (null = top level), refusing to create a cycle
export function moveFolder(id, parentId) {
  if (!id) return { ok: false, error: 'no-id' }
  const pid = parentId || null
  if (pid === id) return { ok: false, error: 'cycle' }
  // walk up from the new parent; if we reach `id`, the move would loop
  let cur = pid
  const byId = new Map(db.prepare('SELECT id, parent_id FROM folders').all().map((r) => [r.id, r.parent_id || null]))
  while (cur) {
    if (cur === id) return { ok: false, error: 'cycle' }
    cur = byId.get(cur) || null
  }
  db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(pid, id)
  return { ok: true }
}
// delete only if empty: no child folders and no notes attached (move them first)
export function deleteFolder(id) {
  if (!id) return { ok: false, error: 'no-id' }
  const kids = db.prepare('SELECT COUNT(*) AS c FROM folders WHERE parent_id = ?').get(id).c
  if (kids > 0) return { ok: false, error: 'has-subfolders' }
  const notes = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE folder_id = ?').get(id).c
  if (notes > 0) return { ok: false, error: 'has-notes' }
  db.prepare('DELETE FROM folders WHERE id = ?').run(id)
  return { ok: true }
}

// ---- statuses: user-defined custom note statuses (built-ins live in code) --
function rowToStatus(r) {
  return { id: r.id, name: r.name, color: r.color || '#888', position: r.position || 0 }
}
export function listStatuses() {
  return db.prepare('SELECT id, name, color, position FROM statuses ORDER BY position, name').all().map(rowToStatus)
}
export function addStatus({ name, color }) {
  const nm = String(name || '').trim()
  if (!nm) return null
  const max = db.prepare('SELECT MAX(position) AS m FROM statuses').get()?.m
  const row = {
    id: randomUUID(),
    name: nm,
    color: String(color || '#888').trim() || '#888',
    position: (Number(max) || 0) + 1,
    created: new Date().toISOString()
  }
  db.prepare('INSERT INTO statuses (id, name, color, position, created) VALUES (@id, @name, @color, @position, @created)').run(row)
  return rowToStatus(row)
}
export function updateStatus(id, patch = {}) {
  const cur = id && db.prepare('SELECT id, name, color FROM statuses WHERE id = ?').get(id)
  if (!cur) return { ok: false, error: 'not-found' }
  const name = patch.name !== undefined ? String(patch.name || '').trim() || cur.name : cur.name
  const color = patch.color !== undefined ? String(patch.color || '').trim() || cur.color : cur.color
  db.prepare('UPDATE statuses SET name = ?, color = ? WHERE id = ?').run(name, color, id)
  return { ok: true }
}
export function deleteStatus(id) {
  if (!id) return { ok: false }
  db.prepare('DELETE FROM statuses WHERE id = ?').run(id)
  return { ok: true }
}

// ---- attachments: files linked to a note (by reference, not copied) -------
export function attachmentsFor(noteId) {
  return db
    .prepare('SELECT id, note_id, name, path, created FROM attachments WHERE note_id = ? ORDER BY created')
    .all(noteId)
}
export function allAttachments() {
  return db.prepare('SELECT id, note_id, name, path FROM attachments').all()
}
export function addAttachment(noteId, filePath) {
  const p = String(filePath || '').trim()
  if (!noteId || !p) return null
  const row = { id: randomUUID(), note_id: noteId, name: basename(p), path: p, created: new Date().toISOString() }
  db.prepare(
    'INSERT INTO attachments (id, note_id, name, path, created) VALUES (@id, @note_id, @name, @path, @created)'
  ).run(row)
  return row
}
export function removeAttachment(id) {
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id)
}
export function attachmentById(id) {
  return db.prepare('SELECT id, note_id, name, path FROM attachments WHERE id = ?').get(id)
}
