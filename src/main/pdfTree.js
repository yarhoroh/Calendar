import { app, dialog, shell } from 'electron'
import { readFileSync, writeFileSync, readdirSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'

// ---- live watch of linked real folders: a file added/removed in Explorer reflects at once ----
let pdfWatchers = []
let pdfWatchTimer = null
export function watchPdfFolders(paths, onChange) {
  for (const w of pdfWatchers) {
    try {
      w.close()
    } catch {
      /* already closed */
    }
  }
  pdfWatchers = []
  for (const p of [...new Set(paths || [])]) {
    try {
      const w = watch(p, { recursive: true }, () => {
        clearTimeout(pdfWatchTimer)
        pdfWatchTimer = setTimeout(onChange, 300) // debounce a burst of fs events into one reload
      })
      pdfWatchers.push(w)
    } catch {
      /* unwatchable path (gone / no perms) — skip it */
    }
  }
  return { ok: true }
}

// Backing store + disk access for the PDF section's left tree. The VIRTUAL structure (folders
// the user makes in-app, plus links to real folders/files and their nesting) is persisted as
// JSON; the contents of a linked real folder are scanned live (not stored), either as the real
// hierarchy or flattened to every PDF recursively, per the folder's mode.

const treeFile = () => join(app.getPath('userData'), 'pdf-tree.json')

export function getPdfTree() {
  try {
    return JSON.parse(readFileSync(treeFile(), 'utf-8'))
  } catch {
    return { roots: [] }
  }
}
export function setPdfTree(tree) {
  try {
    writeFileSync(treeFile(), JSON.stringify(tree || { roots: [] }))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export async function pickPdfFolder() {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return r.canceled ? null : r.filePaths[0]
}
export async function pickPdfFile() {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  return r.canceled ? [] : r.filePaths
}

// A minimal valid one-page A4 PDF (empty content stream, correct xref) — the "New PDF" canvas the
// in-app editor (and the AI) then draws an invoice/contract onto from scratch.
function blankPdfBytes() {
  let out = '%PDF-1.4\n'
  const offsets = []
  const add = (s) => { offsets.push(out.length); out += s }
  add('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n')
  add('2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n')
  add('3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 595.28 841.89]/Resources<<>>/Contents 4 0 R>>\nendobj\n')
  add('4 0 obj\n<</Length 1>>\nstream\n\nendstream\nendobj\n')
  const xref = out.length
  out += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  out += `trailer\n<</Size ${offsets.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// "Create new PDF": ask where to put it, write the blank page, hand the path back so the caller
// opens it in a tab (same flow as opening from disk)
export async function createBlankPdf() {
  const r = await dialog.showSaveDialog({
    title: 'New PDF',
    defaultPath: 'new.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (r.canceled || !r.filePath) return null
  try {
    writeFileSync(r.filePath, blankPdfBytes())
    return r.filePath
  } catch {
    return null
  }
}

// "Save" dialog for the editor: starts in the source file's folder with its name preselected.
// Keeping the same name → the OS itself asks to confirm the overwrite; a new name → a copy.
export async function savePdfDialog(defaultPath) {
  const r = await dialog.showSaveDialog({
    defaultPath: defaultPath || undefined,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  return r.canceled ? null : r.filePath
}

const isPdf = (n) => /\.pdf$/i.test(n)
const byName = (a, b) => a.name.localeCompare(b.name)

// immediate children of a real folder: subfolders + PDF files (for the "real hierarchy" mode)
export function scanFolder(path) {
  const folders = []
  const files = []
  try {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const p = join(path, e.name)
      if (e.isDirectory()) folders.push({ name: e.name, path: p })
      else if (isPdf(e.name)) files.push({ name: e.name, path: p })
    }
  } catch {
    /* unreadable / gone */
  }
  return { folders: folders.sort(byName), files: files.sort(byName) }
}

// EVERY pdf under a folder, recursively (for the "flat" mode) — depth/count-capped for safety
export function scanFolderFlat(path) {
  const files = []
  const walk = (dir, depth) => {
    if (depth > 24 || files.length > 8000) return
    let ents = []
    try {
      ents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (isPdf(e.name)) files.push({ name: e.name, path: p })
    }
  }
  walk(path, 0)
  return { files: files.sort(byName) }
}

// classify an OS-dropped path: folder → link a folder; PDF file → link a file
export function statPath(path) {
  try {
    const s = statSync(path)
    return { isDir: s.isDirectory(), isPdf: s.isFile() && isPdf(path), size: s.size, mtime: s.mtimeMs }
  } catch {
    return { isDir: false, isPdf: false }
  }
}

export function openPdfPath(path) {
  try {
    shell.openPath(path)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// open the OS file manager with the file selected ("show in folder")
export function revealPdfPath(path) {
  try {
    shell.showItemInFolder(path)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// raw bytes for the in-app PDF editor (open) and saving the edited document back (save)
export function readPdfBytes(path) {
  try {
    return { ok: true, data: readFileSync(path) } // Buffer → arrives in the renderer as a Uint8Array
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
export function writePdfBytes(path, bytes) {
  try {
    writeFileSync(path, Buffer.from(bytes))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
