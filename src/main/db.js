import Database from 'better-sqlite3'
import { join } from 'path'
import { app } from 'electron'

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
  `)
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

export function isEmpty() {
  return db.prepare('SELECT COUNT(*) AS c FROM notes').get().c === 0
}

// one-time import from the legacy notes.json map { day: [items] }
export function importMap(map) {
  for (const day of Object.keys(map || {})) saveItems(day, map[day] || [])
}
