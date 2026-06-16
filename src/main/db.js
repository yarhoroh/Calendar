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
      collapsed INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notes_day ON notes(day);
    CREATE INDEX IF NOT EXISTS idx_notes_time ON notes(time);

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
}

function rowToItem(r) {
  return {
    id: r.id,
    title: r.title,
    text: r.text || '',
    status: r.status || 'todo',
    time: r.time || null,
    bold: !!r.bold,
    italic: !!r.italic,
    size: r.size || 1,
    collapsed: !!r.collapsed
  }
}

export function getItems(day) {
  return db.prepare('SELECT * FROM notes WHERE day = ? ORDER BY position').all(day).map(rowToItem)
}

export function saveItems(day, items) {
  const del = db.prepare('DELETE FROM notes WHERE day = ?')
  const ins = db.prepare(`
    INSERT INTO notes (id, day, position, title, text, status, time, bold, italic, size, collapsed)
    VALUES (@id, @day, @position, @title, @text, @status, @time, @bold, @italic, @size, @collapsed)
  `)
  const tx = db.transaction((d, list) => {
    del.run(d)
    list.forEach((it, i) =>
      ins.run({
        id: it.id,
        day: d,
        position: i,
        title: it.title ?? null,
        text: it.text ?? '',
        status: it.status ?? 'todo',
        time: it.time ?? null,
        bold: it.bold ? 1 : 0,
        italic: it.italic ? 1 : 0,
        size: it.size || 1,
        collapsed: it.collapsed ? 1 : 0
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
    .prepare('SELECT id, day, title, text, status, time FROM notes ORDER BY day, position')
    .all()
}

// notes for a date range (YYYY-MM-DD strings; boards like 'everyday' sort
// outside date ranges so they're never included accidentally) — for getNotes
export function getItemsRange(from, to) {
  return db
    .prepare('SELECT id, day, title, text, status, time FROM notes WHERE day >= ? AND day <= ? ORDER BY day, position')
    .all(from, to)
}

export function isEmpty() {
  return db.prepare('SELECT COUNT(*) AS c FROM notes').get().c === 0
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
const TASK_COLS = 'id, at, text, done, every, channel, winfrom, winto, created'
export function allAiTasks() {
  return db.prepare(`SELECT ${TASK_COLS} FROM ai_tasks ORDER BY at`).all()
}
export function pendingAiTasks() {
  return db.prepare(`SELECT ${TASK_COLS} FROM ai_tasks WHERE done = 0 ORDER BY at`).all()
}
export function addAiTask({ at, text, every, channel, from, to }) {
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
    created: new Date().toISOString()
  }
  // need text, and either a time or a repeat interval
  if (!row.text || (!row.at && !row.every)) return null
  db.prepare(
    'INSERT INTO ai_tasks (id, at, text, done, every, channel, winfrom, winto, created) VALUES (@id, @at, @text, @done, @every, @channel, @winfrom, @winto, @created)'
  ).run(row)
  return row
}
export function deleteAiTask(id) {
  db.prepare('DELETE FROM ai_tasks WHERE id = ?').run(id)
}
export function markAiTaskDone(id) {
  db.prepare('UPDATE ai_tasks SET done = 1 WHERE id = ?').run(id)
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
