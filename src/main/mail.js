import { app, dialog, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import { loadAiConfig, saveAiConfig } from './aiConfig'
import { upsertMailMessages, listMailMessages, setMailMessageImportant, setMailThreadSeen, setSavedAttachment, deleteCachedMail, reconcileMailCache, addMailTombstones, mailTombstoneSet, pruneMailTombstones } from './db'
import { extractAttachments, pickBodyParts } from './mailMime'

// Mail client over IMAP (read) — independent of the Google Calendar OAuth.
// Each account authenticates with an app password (Gmail: 2FA + App Password),
// so there's no OAuth consent / restricted-scope verification to deal with.
// Accounts live in ai-config.json (password encrypted); messages cache in SQLite.

const ENC = 'enc:v1:'
function encryptSecret(s) {
  try {
    if (safeStorage.isEncryptionAvailable()) return ENC + safeStorage.encryptString(String(s)).toString('base64')
  } catch {
    // fall through to plaintext
  }
  return String(s)
}
function decryptSecret(s) {
  if (typeof s !== 'string') return ''
  if (!s.startsWith(ENC)) return s
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(ENC.length), 'base64'))
  } catch {
    return ''
  }
}

// default servers — Gmail today; host fields let us add other providers later
const GMAIL_IMAP = { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 }

function rawAccounts() {
  const a = loadAiConfig().mailAccounts
  return Array.isArray(a) ? a : []
}
function saveRaw(list) {
  saveAiConfig({ mailAccounts: list })
}

// accounts for the UI — never expose the password
export function getMailAccounts() {
  return rawAccounts().map((a) => ({ email: a.email, name: a.name || a.email, imapHost: a.imapHost }))
}

function findRaw(email) {
  return rawAccounts().find((a) => a.email === email) || null
}

export function removeMailAccount(email) {
  saveRaw(rawAccounts().filter((a) => a.email !== email))
  return { ok: true }
}

function clientFor(acc, password) {
  return new ImapFlow({
    host: acc.imapHost || GMAIL_IMAP.imapHost,
    port: acc.imapPort || GMAIL_IMAP.imapPort,
    secure: true,
    auth: { user: acc.email, pass: password ?? decryptSecret(acc.password) },
    logger: false
  })
}

// add an account: verify the login works BEFORE saving, so a bad app password
// fails loudly instead of silently storing junk
export async function addMailAccount({ email, password, name, imapHost, imapPort, smtpHost, smtpPort } = {}) {
  const e = String(email || '').trim()
  const pass = String(password || '').trim()
  if (!e || !pass) return { ok: false, error: 'email and app password are required' }
  const acc = {
    email: e,
    name: String(name || '').trim() || e,
    ...GMAIL_IMAP,
    ...(imapHost ? { imapHost } : {}),
    ...(imapPort ? { imapPort: Number(imapPort) } : {}),
    ...(smtpHost ? { smtpHost } : {}),
    ...(smtpPort ? { smtpPort: Number(smtpPort) } : {})
  }
  // test the connection
  let client
  try {
    client = clientFor(acc, pass)
    await client.connect()
    await client.logout()
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    return { ok: false, error: imapError(err) }
  }
  acc.password = encryptSecret(pass)
  saveRaw([...rawAccounts().filter((a) => a.email !== e), acc])
  return { ok: true, email: e }
}

// the real folder list of an account (IMAP LIST). specialUse marks the well-known
// ones (\Inbox \Sent \Trash \Junk \Drafts \All \Flagged \Important); everything
// else is a custom label. \Noselect containers (Gmail's "[Gmail]") are dropped.
export async function listFolders(email) {
  const acc = findRaw(email)
  if (!acc) return { ok: false, error: 'account not found' }
  let client
  try {
    client = clientFor(acc)
    await client.connect()
    const list = await client.list()
    await client.logout()
    const folders = (list || [])
      .filter((m) => !(m.flags && m.flags.has('\\Noselect')))
      .map((m) => ({
        path: m.path,
        name: m.name || m.path,
        specialUse: m.specialUse || (m.path === 'INBOX' ? '\\Inbox' : null)
      }))
    return { ok: true, folders }
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    return { ok: false, error: imapError(err) }
  }
}

const fmtAddr = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '')

// Gmail "important" is the X-GM-LABELS label "Important" (returned as "Important"
// or "\\Important" depending on the server) — NOT a standard IMAP flag
const hasImportant = (labels) => !!labels && (labels.has('\\Important') || labels.has('Important'))

// fetch the most recent INBOX messages, cache their headers, and report a sample
export async function testInbox(email, { max = 20 } = {}) {
  const acc = findRaw(email)
  if (!acc) return { ok: false, error: 'account not found' }
  let client
  try {
    client = clientFor(acc)
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    const metas = []
    try {
      const total = client.mailbox?.exists || 0
      if (total > 0) {
        const start = Math.max(1, total - max + 1)
        for await (const m of client.fetch(`${start}:*`, { uid: true, envelope: true, flags: true, internalDate: true })) {
          const env = m.envelope || {}
          metas.push({
            id: env.messageId || `uid-INBOX-${m.uid}`,
            threadId: null,
            from: fmtAddr(env.from?.[0]),
            to: fmtAddr(env.to?.[0]),
            subject: env.subject || '',
            snippet: '',
            date: (m.internalDate || env.date || new Date(0)).getTime(),
            labels: ['INBOX'],
            unread: !(m.flags && m.flags.has('\\Seen'))
          })
        }
      }
    } finally {
      lock.release()
    }
    await client.logout()
    metas.sort((a, b) => b.date - a.date)
    const count = upsertMailMessages(email, metas)
    return { ok: true, count, sample: metas.slice(0, 6).map((m) => ({ from: m.from, subject: m.subject, unread: m.unread })) }
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    return { ok: false, error: imapError(err) }
  }
}

// the unified-folder ids the UI uses → real Gmail IMAP paths
const FOLDER_ALIAS = { INBOX: 'INBOX', SENT: '[Gmail]/Sent Mail', TRASH: '[Gmail]/Trash' }
const normPath = (folder) => FOLDER_ALIAS[folder] || folder

// Gmail localizes [Gmail]/* folder names per the account's language, so the English alias
// (used by the unified "all" Sent/Trash views) doesn't exist on a non-English account and the
// open fails — leaving only the English account's mail. Resolve those by SPECIAL-USE per
// account instead. INBOX and a real per-account path are universal, so they lock directly.
const ALIAS_USE = { '[Gmail]/Sent Mail': '\\Sent', '[Gmail]/Trash': '\\Trash' }
async function lockResolved(client, path) {
  const use = ALIAS_USE[path]
  if (use) {
    try {
      const b = ((await client.list()) || []).find((mb) => mb.specialUse === use)
      if (b?.path && b.path !== path) return client.getMailboxLock(b.path)
    } catch {
      /* fall through to the literal path */
    }
  }
  return client.getMailboxLock(path)
}

// fetch one page (offset newest-first) of a folder's headers into the cache,
// labelled by its path. Returns the folder's TOTAL message count (EXISTS), so the
// pager can span the whole mailbox even though we only pull `max` at a time.
async function syncFolder(acc, path, max, offset = 0) {
  let client
  try {
    client = clientFor(acc)
    await client.connect()
    const lock = await lockResolved(client, path)
    const metas = []
    let total = 0
    try {
      total = client.mailbox?.exists || 0
      if (total > 0) {
        const end = Math.max(1, total - offset) // 1-based seq, newest at the end
        const start = Math.max(1, end - max + 1)
        if (start <= end) {
          for await (const m of client.fetch(`${start}:${end}`, { uid: true, envelope: true, flags: true, internalDate: true, labels: true, threadId: true, bodyStructure: true })) {
            const env = m.envelope || {}
            const mid = env.messageId || `uid-${path}-${m.uid}`
            metas.push({
              id: mid,
              threadId: m.threadId != null ? String(m.threadId) : null,
              from: env.from?.[0]?.name || env.from?.[0]?.address || '',
              to: fmtAddr(env.to?.[0]),
              subject: env.subject || '',
              snippet: '',
              date: (m.internalDate || env.date || new Date(0)).getTime(),
              labels: [path],
              unread: !(m.flags && m.flags.has('\\Seen')),
              important: hasImportant(m.labels),
              attachments: extractAttachments(m.bodyStructure).map((a) => ({ ...a, mid }))
            })
          }
        }
      }
    } finally {
      lock.release()
    }
    await client.logout()
    upsertMailMessages(acc.email, metas)
    return total
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    throw err
  }
}

// Gmail category tabs → X-GM-RAW "category:<id>" search (CATEGORY_PERSONAL etc).
// They only apply to INBOX; every other folder ignores the tab.
const CATEGORY_TABS = ['primary', 'social', 'promotions', 'updates', 'forums']
const isCategoryView = (path, tab) => path === 'INBOX' && CATEGORY_TABS.includes(tab)

// server-side filters (the filter dropdown) → Gmail X-GM-RAW terms
const FILTER_Q = { unread: 'is:unread', attachments: 'has:attachment' }

// resolve a view (folder + category tab + filter) to a Gmail X-GM-RAW search and the
// synthetic `category` key we cache its messages under. gmraw=null → plain folder fetch.
function viewQuery(path, tab, filter) {
  const cat = isCategoryView(path, tab) ? tab : null
  const fq = FILTER_Q[filter] || null
  if (cat && fq) return { gmraw: `category:${cat} ${fq}`, catKey: `${cat}|${filter}` }
  if (cat) return { gmraw: `category:${cat}`, catKey: cat }
  if (fq) return { gmraw: fq, catKey: `all|${filter}` }
  return { gmraw: null, catKey: null }
}

// fetch one page of a Gmail search (X-GM-RAW → UIDs → headers) in `path` into the cache,
// tagged with `catKey`. Returns the search's TOTAL match count.
async function syncView(acc, path, gmraw, catKey, max, offset) {
  let client
  try {
    client = clientFor(acc)
    await client.connect()
    const lock = await lockResolved(client, path)
    const metas = []
    let total = 0
    try {
      const uids = (await client.search({ gmraw }, { uid: true })) || []
      total = uids.length
      const pageUids = uids.slice().sort((a, b) => b - a).slice(offset, offset + max) // newest first
      if (pageUids.length) {
        for await (const m of client.fetch(pageUids.join(','), { uid: true, envelope: true, flags: true, internalDate: true, labels: true, threadId: true, bodyStructure: true }, { uid: true })) {
          const env = m.envelope || {}
          const mid = env.messageId || `uid-${path}-${m.uid}`
          metas.push({
            id: mid,
            threadId: m.threadId != null ? String(m.threadId) : null,
            from: env.from?.[0]?.name || env.from?.[0]?.address || '',
            to: fmtAddr(env.to?.[0]),
            subject: env.subject || '',
            snippet: '',
            date: (m.internalDate || env.date || new Date(0)).getTime(),
            labels: [path],
            unread: !(m.flags && m.flags.has('\\Seen')),
            category: catKey,
            important: hasImportant(m.labels),
            attachments: extractAttachments(m.bodyStructure).map((a) => ({ ...a, mid }))
          })
        }
      }
    } finally {
      lock.release()
    }
    await client.logout()
    upsertMailMessages(acc.email, metas)
    return total
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    throw err
  }
}

// unread counts per category tab (X-GM-RAW search on INBOX) for the tab badges.
// account === 'all' sums every mail account. Returns { tabId: unreadCount }.
const TAB_QUERIES = {
  updates: 'category:updates is:unread',
  primary: 'category:primary is:unread',
  promotions: 'category:promotions is:unread',
  social: 'category:social is:unread'
}
async function categoryCountsFor(acc) {
  let client
  const counts = {}
  try {
    client = clientFor(acc)
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      for (const [tab, q] of Object.entries(TAB_QUERIES)) {
        try {
          const uids = await client.search({ gmraw: q }, { uid: true })
          counts[tab] = (uids || []).length
        } catch { /* X-GM-RAW unsupported on this account */ }
      }
    } finally {
      lock.release()
    }
    await client.logout()
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    throw err
  }
  return counts
}
export async function mailCategoryStats(account = 'all') {
  const accts = account && account !== 'all' ? [findRaw(account)].filter(Boolean) : rawAccounts()
  const per = await Promise.all(
    accts.map((a) => categoryCountsFor(a).catch((e) => { console.warn('[mail] category stats failed', a.email, e?.message); return {} }))
  )
  const counts = {}
  for (const c of per) for (const [tab, n] of Object.entries(c)) counts[tab] = (counts[tab] || 0) + n
  return { ok: true, counts }
}

// toggle Gmail "important" (X-GM-LABELS \Important) on a message, then mirror it in
// the cache. Locates the message by its RFC Message-ID within INBOX.
export async function setMailImportant({ account, id, important }) {
  const acc = findRaw(account)
  if (!acc) return { ok: false, error: 'account not found' }
  let client
  try {
    client = clientFor(acc)
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      const uids = await client.search({ header: { 'message-id': id } }, { uid: true })
      if (uids && uids.length) {
        if (important) await client.messageFlagsAdd(uids, ['\\Important'], { uid: true, useLabels: true })
        else await client.messageFlagsRemove(uids, ['\\Important'], { uid: true, useLabels: true })
      }
    } finally {
      lock.release()
    }
    await client.logout()
    setMailMessageImportant(acc.email, id, important)
    return { ok: true }
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    return { ok: false, error: imapError(err) }
  }
}

// download external <img> sources and inline them as base64 data: URLs, so the UI
// renders only local images (no per-render external requests). Skips non-images,
// oversized files and slow hosts; anything left untouched still loads via CSP.
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}
// download every external <img> in the html and return a { originalUrl: dataUrl }
// map. The renderer swaps each image in place once its data: URL is ready, so the
// renderer itself never makes external requests (privacy) and the body never
// reloads (no flicker). &amp; in URLs is decoded to match the rendered img src.
async function remoteImageMap(html) {
  const map = {}
  if (!html || typeof fetch !== 'function') return map
  const urls = new Set()
  const re = /<img\b[^>]*?\ssrc\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi
  let m
  while ((m = re.exec(html)) && urls.size < 60) urls.add(m[1].replace(/&amp;/gi, '&'))
  if (!urls.size) return map
  await Promise.all(
    [...urls].map(async (url) => {
      try {
        const res = await fetchWithTimeout(url, 8000)
        if (!res.ok) return
        const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
        if (!/^image\//i.test(ct)) return
        const buf = Buffer.from(await res.arrayBuffer())
        if (!buf.length || buf.length > 5_000_000) return
        map[url] = `data:${ct};base64,${buf.toString('base64')}`
      } catch {
        /* skip this image */
      }
    })
  )
  return map
}
// called by the reader AFTER a message is shown — downloads images in the
// background; the renderer fills them in over their spinner placeholders
export async function inlineMailImages({ html }) {
  return { ok: true, map: await remoteImageMap(html || '') }
}

// fetch a whole conversation (all messages sharing the X-GM-THRID) with parsed
// bodies + attachments, newest first. Falls back to the single message by
// Message-ID when there's no thread id. Reads from All Mail so replies in Sent etc.
// are included.
// download a single MIME part, fully decoded (transfer-encoding + charset→UTF-8 for
// text parts) by imapflow. Returns a Buffer (or null).
async function downloadPart(client, uid, part) {
  try {
    const dl = await client.download(String(uid), part, { uid: true })
    if (!dl?.content) return null
    const chunks = []
    for await (const c of dl.content) chunks.push(c)
    return Buffer.concat(chunks)
  } catch {
    return null
  }
}

export async function getMailThread({ account, threadId, id, folder }, onMessage) {
  const acc = findRaw(account)
  if (!acc) return { ok: false, error: 'account not found' }
  let client
  try {
    client = clientFor(acc)
    await client.connect()
    // resolve All Mail by special-use, NOT the literal "[Gmail]/All Mail" — Gmail localizes
    // the name (e.g. "[Gmail]/Уся пошта"), so the hard-coded path failed and we fell back to
    // INBOX, showing only the in-INBOX part of the conversation instead of the whole thread
    let allPath = '[Gmail]/All Mail'
    try {
      const b = ((await client.list()) || []).find((mb) => mb.specialUse === '\\All')
      if (b?.path) allPath = b.path
    } catch {
      /* keep the default */
    }
    let lock
    try {
      lock = await client.getMailboxLock(allPath)
    } catch {
      lock = await client.getMailboxLock('INBOX')
    }
    const out = []
    try {
      const find = () =>
        threadId
          ? client.search({ threadId: String(threadId) }, { uid: true })
          : client.search({ header: { 'message-id': id } }, { uid: true })
      let uids = await find()
      // All Mail excludes Trash/Spam (and the search can miss) — if nothing matched
      // and we know the source folder, reopen it and search there
      const fpath = normPath(folder)
      if ((!uids || !uids.length) && fpath && fpath !== '[Gmail]/All Mail') {
        lock.release()
        lock = await client.getMailboxLock(fpath)
        uids = await find()
      }
      if (uids && uids.length) {
        // 1) structure + headers only — no bodies, NO attachment bytes
        const rows = []
        for await (const m of client.fetch(uids.join(','), { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true, headers: ['return-path', 'dkim-signature'] }, { uid: true })) {
          rows.push({ uid: m.uid, env: m.envelope || {}, flags: m.flags, internalDate: m.internalDate, bs: m.bodyStructure, headers: m.headers })
        }
        // download bodies NEWEST-FIRST so the most recent message can show immediately,
        // streaming each one to the UI (onMessage) as its body finishes — no waiting for
        // the whole chain
        const tof = (r) => new Date(r.internalDate || r.env.date || 0).getTime()
        rows.sort((a, b) => tof(b) - tof(a))
        // 2) per message download ONLY the text/html body + inline (CID) images —
        // attachment parts stay on the server and are fetched lazily on click
        for (const row of rows) {
          const env = row.env
          const mid = env.messageId || `uid-${row.uid}`
          const sel = pickBodyParts(row.bs)
          let html = sel.htmlPart ? (await downloadPart(client, row.uid, sel.htmlPart))?.toString('utf-8') || '' : ''
          const text = sel.textPart ? (await downloadPart(client, row.uid, sel.textPart))?.toString('utf-8') || '' : ''
          for (const ip of sel.inline) {
            if (!ip.cid || !html.includes(`cid:${ip.cid}`)) continue
            const buf = await downloadPart(client, row.uid, ip.part)
            if (buf && buf.length < 4_000_000) {
              const dataUrl = `data:${ip.type};base64,${buf.toString('base64')}`
              html = html.split(`cid:${ip.cid}`).join(dataUrl).split(`cid:<${ip.cid}>`).join(dataUrl)
            }
          }
          // extra "Details" fields (Gmail-style): reply-to, mailed-by, signed-by
          const hdr = row.headers ? row.headers.toString() : ''
          const rp = hdr.match(/^return-path:\s*<?([^>\s]+)>?/im)
          const dk = hdr.match(/^dkim-signature:[\s\S]*?[;\s]d=([^;\s]+)/im)
          const message = {
            id: mid,
            from: env.from?.[0]?.name || env.from?.[0]?.address || '',
            fromEmail: env.from?.[0]?.address || '',
            replyTo: fmtAddr(env.replyTo?.[0]),
            to: fmtAddr(env.to?.[0]),
            ts: (row.internalDate || env.date || new Date(0)).getTime(),
            subject: env.subject || '',
            mailedBy: rp ? rp[1].split('@').pop() : '',
            signedBy: dk ? dk[1].trim() : '',
            html,
            text,
            unread: !(row.flags && row.flags.has('\\Seen')),
            // attachments via BODYSTRUCTURE (keeps the MIME `part` for lazy download)
            attachments: extractAttachments(row.bs).map((a) => ({ ...a, mid }))
          }
          out.push(message)
          onMessage?.(message, uids.length) // stream it to the UI right away (+ total so far)
        }
        // opening a conversation marks every message in it read (\Seen on each UID)
        try {
          await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true })
        } catch {
          /* read-only mailbox or unsupported — leave as-is */
        }
      }
    } finally {
      lock.release()
    }
    await client.logout()
    setMailThreadSeen(acc.email, threadId, id, true)
    out.sort((a, b) => b.ts - a.ts) // newest first
    return { ok: true, messages: out }
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    return { ok: false, error: imapError(err) }
  }
}

// explicitly mark a conversation read/unread (\Seen) — e.g. the "mark unread"
// button. Applies to every UID in the thread, then mirrors it in the cache.
export async function setMailSeen({ account, threadId, id, seen }) {
  const acc = findRaw(account)
  if (!acc) return { ok: false, error: 'account not found' }
  let client
  try {
    client = clientFor(acc)
    await client.connect()
    let lock
    try {
      lock = await client.getMailboxLock('[Gmail]/All Mail')
    } catch {
      lock = await client.getMailboxLock('INBOX')
    }
    try {
      const uids = threadId
        ? await client.search({ threadId: String(threadId) }, { uid: true })
        : await client.search({ header: { 'message-id': id } }, { uid: true })
      if (uids && uids.length) {
        if (seen) await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true })
        else await client.messageFlagsRemove(uids.join(','), ['\\Seen'], { uid: true })
      }
    } finally {
      lock.release()
    }
    await client.logout()
    setMailThreadSeen(acc.email, threadId, id, seen)
    return { ok: true }
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    return { ok: false, error: imapError(err) }
  }
}

// lazily download one attachment (BODY.PEEK[part]) by the message's Message-ID,
// save it to a temp folder and open it in the OS default app (Windows preview etc.)
export async function openMailAttachment({ account, id, part, name, saveAs }) {
  const acc = findRaw(account)
  if (!acc) return { ok: false, error: 'account not found' }
  if (!part) return { ok: false, error: 'missing part' }
  let client
  try {
    client = clientFor(acc)
    await client.connect()
    let lock
    try {
      lock = await client.getMailboxLock('[Gmail]/All Mail')
    } catch {
      lock = await client.getMailboxLock('INBOX')
    }
    let buf = null
    try {
      const uids = await client.search({ header: { 'message-id': id } }, { uid: true })
      if (uids && uids.length) {
        const dl = await client.download(String(uids[uids.length - 1]), part, { uid: true })
        if (dl?.content) {
          const chunks = []
          for await (const c of dl.content) chunks.push(c)
          buf = Buffer.concat(chunks)
        }
      }
    } finally {
      lock.release()
    }
    await client.logout()
    if (!buf) return { ok: false, error: 'attachment not found' }
    if (saveAs) {
      // let the user pick where to save
      const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: name || 'attachment' })
      if (canceled || !filePath) return { ok: false, canceled: true }
      writeFileSync(filePath, buf)
      setSavedAttachment(acc.email, id, part, filePath) // remember where, for the folder button
      return { ok: true, path: filePath }
    }
    // open in the OS default app via a temp copy
    const dir = join(app.getPath('temp'), 'calendar-mail')
    mkdirSync(dir, { recursive: true })
    const safe = (name || 'attachment').replace(/[\\/:*?"<>|]/g, '_')
    const file = join(dir, safe)
    writeFileSync(file, buf)
    await shell.openPath(file)
    return { ok: true, path: file }
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    return { ok: false, error: imapError(err) }
  }
}

// delete a conversation (or one message) — move every matching UID to Trash, then
// drop it from the cache. From Trash itself, expunge permanently.
export async function deleteMail({ account, folder = 'INBOX', threadId, id }) {
  const acc = findRaw(account)
  if (!acc) return { ok: false, error: 'account not found' }
  const path = normPath(folder)
  // tombstone FIRST, before the slow IMAP work — so any list load already in flight (or the
  // 20s poll) immediately hides this row and it can't flash back while the expunge runs
  tombstone(acc.email, [{ id, threadId }], path)
  let client
  try {
    client = clientFor(acc)
    await client.connect()
    // resolve the real Trash mailbox by its \Trash special-use (the name can be
    // localized, e.g. "[Gmail]/Кошик"), not by matching "trash" in the path
    let trashPath = '[Gmail]/Trash'
    try {
      const list = (await client.list()) || []
      const byUse = list.find((mb) => mb.specialUse === '\\Trash')
      const byName = list.find((mb) => /trash|bin|deleted|корзин|кошик|удал/i.test(mb.path || mb.name || ''))
      trashPath = byUse?.path || byName?.path || trashPath
    } catch {
      /* fall back to the default path */
    }
    const lock = await lockResolved(client, path)
    try {
      const inTrash = client.mailbox?.specialUse === '\\Trash' || path === trashPath
      const uids = threadId
        ? await client.search({ threadId: String(threadId) }, { uid: true })
        : await client.search({ header: { 'message-id': id } }, { uid: true })
      if (uids && uids.length) {
        if (inTrash) {
          await client.messageDelete(uids, { uid: true }) // already in Trash → expunge permanently
        } else {
          try {
            await client.messageMove(uids, trashPath, { uid: true })
          } catch {
            await client.messageDelete(uids, { uid: true })
          }
        }
      }
    } finally {
      lock.release()
    }
    await client.logout()
    deleteCachedMail(acc.email, threadId, id)
    return { ok: true }
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    return { ok: false, error: imapError(err) }
  }
}

const TOMBSTONE_TTL = 5 * 60 * 1000 // 5 min — by then the IMAP server has surely expunged

// record a delete locally (both the message id and its thread id), scoped to the folder it
// was removed from, so the row stays hidden THERE even if the IMAP server hasn't finished
// expunging/moving it yet (a message moved INBOX→Trash is hidden in INBOX, shown in Trash)
function tombstone(account, items, folder) {
  const keys = []
  for (const it of items || []) {
    if (it.id) keys.push(it.id)
    if (it.threadId) keys.push(it.threadId)
  }
  if (keys.length) addMailTombstones(account, keys, folder, Date.now())
}

// drop any rows the user has locally deleted from this folder (matched by id or thread id);
// omit `folder` to filter against every folder's tombstones (used by All-Mail search)
function dropTombstoned(account, metas, folder) {
  const dead = mailTombstoneSet(account, folder)
  if (!dead.size) return metas
  return metas.filter((m) => !dead.has(m.id) && !(m.threadId && dead.has(m.threadId)))
}

// instant read from the local cache (no network) for the given account/folder/tab page
export function cachedMessages({ account, folder = 'INBOX', tab = 'all', page = 1, max = 50 }) {
  // only page 1 has a meaningful instant cache (newest messages); jumped pages aren't
  // thread-paginated in the cache → return nothing and let the live load fill them in
  if ((Number(page) || 1) > 1) return []
  const path = normPath(folder)
  // filter the flash by the category tab so it shows the right tab instantly, not all of
  // INBOX (the cache rows are tagged with their category by loadThreadPage)
  const cat = isCategoryView(path, tab) ? tab : null
  return dropTombstoned(account, listMailMessages(account, path, max, 0, cat), path)
}

// sync one page of the current view (folder, or a Gmail category tab on INBOX) for
// one account (or every account when 'all'), then return that page from the cache
// + the view's TOTAL count for the pager
const SCAN_CAP = 4000 // cap the thread scan so very large folders don't hang

// Gmail: a conversation spans folders, so the folder-scoped thread count (e.g. 4 in INBOX)
// understates the real size the reader shows (10 across All Mail). One light thread-id scan
// of All Mail builds a thrid→count map and overrides each rep's count to the full size, so
// the list badge matches what opening the thread shows. Non-Gmail accounts (synthetic 'u'+uid
// thread ids) and any failure leave the folder-scoped count untouched.
const FULLCOUNT_TTL = 15000 // reuse an All-Mail count scan for 15s so tab-switching isn't slow
const fullCountCache = new Map() // account email → { at, counts: Map<thrid, n> }

async function allMailCounts(client, email) {
  const hit = fullCountCache.get(email)
  if (hit && Date.now() - hit.at < FULLCOUNT_TTL) return hit.counts
  const all = ((await client.list()) || []).find((mb) => mb.specialUse === '\\All')
  if (!all?.path) return null
  const lock = await client.getMailboxLock(all.path)
  try {
    let uids = (await client.search({ all: true }, { uid: true })) || []
    uids = uids.sort((a, b) => b - a).slice(0, SCAN_CAP)
    const counts = new Map()
    for await (const m of client.fetch(uids, { uid: true, threadId: true }, { uid: true })) {
      const tid = m.threadId != null ? String(m.threadId) : null
      if (tid) counts.set(tid, (counts.get(tid) || 0) + 1)
    }
    fullCountCache.set(email, { at: Date.now(), counts })
    return counts
  } finally {
    lock.release()
  }
}

async function enrichFullCounts(client, acc, metas) {
  const ids = metas.map((m) => m.threadId).filter((t) => t && !t.startsWith('u'))
  if (!ids.length) return
  try {
    const counts = await allMailCounts(client, acc.email)
    if (!counts) return
    for (const meta of metas) {
      const c = counts.get(meta.threadId)
      if (c) meta.count = c
    }
    upsertMailMessages(acc.email, metas) // keep the cache flash in sync with the full count
  } catch {
    /* counts stay folder-scoped — never break the page over a count */
  }
}

// Thread-aware page of a view: pagination counts CONVERSATIONS (X-GM-THRID), not raw
// messages, so the page count and 'select all' match the grouped rows the UI shows, and
// far pages aren't empty (the live page is fetched & returned directly, no OFFSET into a
// sparse cache). Returns { total: thread count, messages: each thread's newest message }.
async function loadThreadPage(acc, path, gmraw, max, offset, cat, scanWindow) {
  const client = clientFor(acc)
  try {
    await client.connect()
    const lock = await lockResolved(client, path)
    let result = { total: 0, messages: [] }
    try {
      let uids = gmraw
        ? (await client.search({ gmraw }, { uid: true })) || []
        : (await client.search({ all: true }, { uid: true })) || []
      uids = uids.sort((a, b) => b - a) // newest first
      const msgTotal = uids.length
      // phase 1 (scanWindow set) scans only the newest window for a fast page; phase 2
      // (no window) scans the whole folder (capped) for the exact thread count
      const scanUids = scanWindow ? uids.slice(0, scanWindow) : uids.slice(0, SCAN_CAP)
      if (scanUids.length) {
        // light pass: group by thread, keep each thread's newest message as the rep
        const byThread = new Map()
        for await (const m of client.fetch(scanUids, { uid: true, threadId: true, internalDate: true }, { uid: true })) {
          const tid = m.threadId != null ? String(m.threadId) : 'u' + m.uid
          const date = (m.internalDate || new Date(0)).getTime()
          const g = byThread.get(tid)
          if (!g) byThread.set(tid, { uid: m.uid, date, count: 1 })
          else {
            g.count++
            if (date >= g.date) { g.date = date; g.uid = m.uid }
          }
        }
        const threads = [...byThread.values()].sort((a, b) => b.date - a.date)
        // exact when we scanned everything; otherwise extrapolate threads/messages ratio
        // over the whole folder for an approximate page count until phase 2 corrects it
        const total =
          scanUids.length >= msgTotal
            ? threads.length
            : Math.round((threads.length * msgTotal) / scanUids.length)
        // fetch the whole window up to this page (0..offset+max) so the unified 'all'
        // view can merge every account's threads and slice the real page globally —
        // per-account slicing would desync the page across accounts
        const page = threads.slice(0, offset + max)
        const metas = []
        if (page.length) {
          const repCount = new Map(page.map((t) => [t.uid, t.count]))
          for await (const m of client.fetch(page.map((t) => t.uid), { uid: true, envelope: true, flags: true, internalDate: true, labels: true, threadId: true, bodyStructure: true }, { uid: true })) {
            const env = m.envelope || {}
            const mid = env.messageId || `uid-${path}-${m.uid}`
            metas.push({
              id: mid,
              account: acc.email,
              threadId: m.threadId != null ? String(m.threadId) : 'u' + m.uid,
              from: env.from?.[0]?.name || env.from?.[0]?.address || '',
              to: fmtAddr(env.to?.[0]),
              subject: env.subject || '',
              snippet: '',
              date: (m.internalDate || env.date || new Date(0)).getTime(),
              labels: [path],
              unread: !(m.flags && m.flags.has('\\Seen')),
              important: hasImportant(m.labels),
              count: repCount.get(m.uid) || 1,
              // tag the cache row with its category tab (when this view IS a category),
              // so the instant page-1 cache flash shows the right tab, not all of INBOX
              category: cat || undefined,
              attachments: extractAttachments(m.bodyStructure).map((a) => ({ ...a, mid }))
            })
          }
          metas.sort((a, b) => b.date - a.date)
          upsertMailMessages(acc.email, metas)
        }
        result = { total, messages: metas }
      }
    } finally {
      lock.release()
    }
    // only the exact pass (no scanWindow) enriches counts — phase 1 stays instant with the
    // folder-scoped approximation, then this exact return corrects the badge to the full size
    if (!scanWindow && result.messages.length) {
      await enrichFullCounts(client, acc, result.messages)
      // reconcile the cache with this authoritative page so mail deleted on the server
      // (e.g. in Gmail) stops flashing from the local cache (the "ghost" message)
      const liveIds = result.messages.map((m) => m.id)
      const liveThreads = result.messages.map((m) => m.threadId).filter(Boolean)
      const complete = result.messages.length < offset + max // loaded the whole view → prune all stale
      const minDate = complete ? 0 : Math.min(...result.messages.map((m) => m.date || 0))
      reconcileMailCache(acc.email, path, cat, liveIds, liveThreads, minDate)
    }
    await client.logout()
    return result
  } catch (err) {
    try { await client.close() } catch { /* ignore */ }
    console.warn('[mail] loadThreadPage failed', acc.email, path, err?.message)
    return { total: 0, messages: [] }
  }
}

// Flat (non-threaded) page of a folder: pagination counts MESSAGES, not conversations.
// Used for Sent/Trash/etc where conversation grouping isn't useful — and it's much faster
// than loadThreadPage because it skips the full thread scan (no light-fetch of every uid),
// fetching only the page's envelopes. Returns the window 0..offset+max so the unified 'all'
// view can merge accounts and slice the real page globally (same contract as loadThreadPage).
async function loadFlatPage(acc, path, gmraw, max, offset) {
  const client = clientFor(acc)
  try {
    await client.connect()
    const lock = await lockResolved(client, path)
    let result = { total: 0, messages: [] }
    try {
      let uids = gmraw
        ? (await client.search({ gmraw }, { uid: true })) || []
        : (await client.search({ all: true }, { uid: true })) || []
      uids = uids.sort((a, b) => b - a) // newest first
      const total = uids.length
      const page = uids.slice(0, offset + max)
      const metas = []
      if (page.length) {
        for await (const m of client.fetch(page, { uid: true, envelope: true, flags: true, internalDate: true, labels: true, threadId: true, bodyStructure: true }, { uid: true })) {
          const env = m.envelope || {}
          const mid = env.messageId || `uid-${path}-${m.uid}`
          metas.push({
            id: mid,
            account: acc.email,
            threadId: m.threadId != null ? String(m.threadId) : 'u' + m.uid,
            from: env.from?.[0]?.name || env.from?.[0]?.address || '',
            to: fmtAddr(env.to?.[0]),
            subject: env.subject || '',
            snippet: '',
            date: (m.internalDate || env.date || new Date(0)).getTime(),
            labels: [path],
            unread: !(m.flags && m.flags.has('\\Seen')),
            important: hasImportant(m.labels),
            count: 1,
            attachments: extractAttachments(m.bodyStructure).map((a) => ({ ...a, mid }))
          })
        }
        metas.sort((a, b) => b.date - a.date)
        upsertMailMessages(acc.email, metas)
      }
      result = { total, messages: metas }
    } finally {
      lock.release()
    }
    await client.logout()
    return result
  } catch (err) {
    try { await client.close() } catch { /* ignore */ }
    console.warn('[mail] loadFlatPage failed', acc.email, path, err?.message)
    return { total: 0, messages: [] }
  }
}

const FAST_WINDOW = 300 // phase-1 scan size: newest N messages → instant page 1

// merge every account's window (each returned threads/messages up to offset+max), dedup,
// sort newest-first, and slice the real page so pagination is correct across all accounts
function mergePage(results, offset, max, account, folder) {
  const total = results.reduce((s, r) => s + (r?.total || 0), 0)
  const seen = new Set()
  const merged = results
    .flatMap((r) => r?.messages || [])
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, b) => b.date - a.date)
  // hide locally-deleted rows BEFORE slicing, so the page still fills to `max` and a delete
  // the server hasn't synced yet doesn't reappear on refresh
  const messages = dropTombstoned(account, merged, folder).slice(offset, offset + max)
  return { total, messages }
}

export async function loadMessages({ account, folder = 'INBOX', tab = 'all', page = 1, max = 50, filter = 'all', grouped: groupedArg }, onPartial) {
  const path = normPath(folder)
  const p = Math.max(1, Number(page) || 1)
  const offset = (p - 1) * max
  const { gmraw } = viewQuery(path, tab, filter)
  const cat = isCategoryView(path, tab) ? tab : null // pure category tag for the cache
  const accts = account && account !== 'all' ? [findRaw(account)].filter(Boolean) : rawAccounts()
  pruneMailTombstones(Date.now() - TOMBSTONE_TTL) // forget deletes the server has surely synced
  // INBOX + Sent group into conversations; Trash/etc paginate flat (by message). The caller
  // (which knows the folder's special-use) decides via `grouped`; default to INBOX-only.
  const grouped = groupedArg != null ? groupedArg : path === 'INBOX'

  // INBOX page 1: stream a fast approximate page from the newest FAST_WINDOW messages first
  // (onPartial), then the exact full-scan page as the final return — "see the new mail now,
  // pagination settles a moment later"
  if (grouped && p === 1 && onPartial) {
    const fast = await Promise.all(accts.map((a) => loadThreadPage(a, path, gmraw, max, offset, cat, FAST_WINDOW)))
    const fastMerged = mergePage(fast, offset, max, account, path)
    onPartial({ ok: true, page: p, ...fastMerged, approx: true })
    const full = await Promise.all(accts.map((a) => loadThreadPage(a, path, gmraw, max, offset, cat)))
    return { ok: true, page: p, ...mergePage(full, offset, max, account, path) }
  }

  const results = await Promise.all(
    accts.map((a) => (grouped ? loadThreadPage(a, path, gmraw, max, offset, cat) : loadFlatPage(a, path, gmraw, max, offset)))
  )
  return { ok: true, page: p, ...mergePage(results, offset, max, account, path) }
}

// Cheap incremental check for brand-new mail: fetch only the newest `limit` messages of a
// view (no full thread scan, no pagination) so the UI can poll every few seconds and merge
// in arrivals, instead of re-scanning the whole folder every minute. Returns just those
// metas; the renderer dedups them into the list by id and lets the thread memo regroup.
export async function recentMessages({ account, folder = 'INBOX', tab = 'all', filter = 'all', limit = 25 }) {
  const path = normPath(folder)
  const { gmraw } = viewQuery(path, tab, filter)
  const cat = isCategoryView(path, tab) ? tab : null
  const accts = account && account !== 'all' ? [findRaw(account)].filter(Boolean) : rawAccounts()
  const perAccount = async (acc) => {
    const client = clientFor(acc)
    try {
      await client.connect()
      const lock = await lockResolved(client, path)
      const metas = []
      try {
        let uids = gmraw
          ? (await client.search({ gmraw }, { uid: true })) || []
          : (await client.search({ all: true }, { uid: true })) || []
        uids = uids.sort((a, b) => b - a).slice(0, limit) // just the newest few
        if (uids.length) {
          for await (const m of client.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true, labels: true, threadId: true, bodyStructure: true }, { uid: true })) {
            const env = m.envelope || {}
            const mid = env.messageId || `uid-${path}-${m.uid}`
            metas.push({
              id: mid,
              account: acc.email,
              threadId: m.threadId != null ? String(m.threadId) : 'u' + m.uid,
              from: env.from?.[0]?.name || env.from?.[0]?.address || '',
              to: fmtAddr(env.to?.[0]),
              subject: env.subject || '',
              snippet: '',
              date: (m.internalDate || env.date || new Date(0)).getTime(),
              labels: [path],
              unread: !(m.flags && m.flags.has('\\Seen')),
              important: hasImportant(m.labels),
              count: 1,
              category: cat || undefined,
              attachments: extractAttachments(m.bodyStructure).map((a) => ({ ...a, mid }))
            })
          }
          metas.sort((a, b) => b.date - a.date)
          upsertMailMessages(acc.email, metas)
        }
      } finally {
        lock.release()
      }
      await client.logout()
      return metas
    } catch (e) {
      try { await client.close() } catch { /* ignore */ }
      console.warn('[mail] recent failed', acc.email, path, e?.message)
      return []
    }
  }
  const all = (await Promise.all(accts.map(perAccount))).flat()
  const seen = new Set()
  const messages = dropTombstoned(account, all, path)
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, b) => b.date - a.date)
    .slice(0, limit)
  return { ok: true, messages }
}

// Incremental "only NEW mail since last time" for the watcher. Uses the IMAP UID
// high-water mark: search UID `${lastUid+1}:*` returns just messages newer than what
// we've seen (IMAP returns the highest UID even when none are truly new, so we filter).
// First run (lastUid 0) or a uidvalidity change just records the baseline and returns
// nothing — so the watcher never replays the whole mailbox. Returns { ok, lastUid (new
// high to persist), uidValidity, messages: new metas oldest-first }.
export async function newMessagesSince({ account, folder = 'INBOX', lastUid = 0, uidValidity = 0 }) {
  const acc = findRaw(account)
  if (!acc) return { ok: false, error: 'account not found' }
  const path = normPath(folder)
  const client = clientFor(acc)
  try {
    await client.connect()
    const lock = await lockResolved(client, path)
    try {
      const curValidity = Number(client.mailbox?.uidValidity) || 0
      const uidNext = Number(client.mailbox?.uidNext) || 0
      const baseHigh = Math.max(0, uidNext - 1)
      // mailbox rebuilt (uidvalidity changed) OR first ever run → record baseline, no replay
      if (!lastUid || (uidValidity && curValidity && curValidity !== uidValidity)) {
        return { ok: true, baseline: true, uidValidity: curValidity, lastUid: baseHigh, messages: [] }
      }
      const since = lastUid + 1
      const uids = ((await client.search({ uid: `${since}:*` }, { uid: true })) || []).filter((u) => u >= since)
      if (!uids.length) return { ok: true, uidValidity: curValidity, lastUid, messages: [] }
      const metas = []
      let high = lastUid
      for await (const m of client.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true, threadId: true }, { uid: true })) {
        if (m.uid > high) high = m.uid
        const env = m.envelope || {}
        metas.push({
          uid: m.uid,
          account: acc.email,
          id: env.messageId || `uid-${path}-${m.uid}`,
          threadId: m.threadId != null ? String(m.threadId) : null,
          from: env.from?.[0]?.name || env.from?.[0]?.address || '',
          fromEmail: env.from?.[0]?.address || '',
          to: fmtAddr(env.to?.[0]),
          subject: env.subject || '',
          date: (m.internalDate || env.date || new Date(0)).getTime(),
          unread: !(m.flags && m.flags.has('\\Seen'))
        })
      }
      metas.sort((a, b) => a.date - b.date) // oldest first → notifications read in arrival order
      return { ok: true, uidValidity: curValidity, lastUid: high, messages: metas }
    } finally {
      lock.release()
    }
  } catch (e) {
    try { await client.close() } catch { /* ignore */ }
    return { ok: false, error: e?.message || 'error' }
  } finally {
    try { await client.logout() } catch { /* already closed */ }
  }
}

// Mark every unread message in a folder as read (\Seen), in batches, reporting
// progress via onProgress(done, total). Handles the unified 'all' account by looping
// over every connected mailbox. Runs in the background; the UI shows a live spinner.
export async function markFolderRead({ account, folder }, onProgress) {
  const path = normPath(folder)
  const accts = account && account !== 'all' ? [findRaw(account)].filter(Boolean) : rawAccounts()
  let done = 0
  let total = 0
  for (const acc of accts) {
    let client
    try {
      client = clientFor(acc)
      await client.connect()
      const lock = await lockResolved(client, path)
      try {
        const uids = (await client.search({ seen: false }, { uid: true })) || []
        total += uids.length
        onProgress?.(done, total)
        for (let i = 0; i < uids.length; i += 200) {
          const batch = uids.slice(i, i + 200)
          await client.messageFlagsAdd(batch, ['\\Seen'], { uid: true })
          done += batch.length
          onProgress?.(done, total)
        }
      } finally {
        lock.release()
      }
      await client.logout()
    } catch (e) {
      try {
        await client?.close?.()
      } catch {
        /* ignore */
      }
      console.warn('[mail] mark-folder-read failed', acc.email, path, e?.message)
    }
  }
  return { ok: true, marked: done, total }
}

// Permanently delete EVERY message in a folder (empty Trash), in batches, reporting
// progress via onProgress(done, total). IRREVERSIBLE expunge — so for safety it refuses
// unless the opened mailbox is actually the \Trash special-use folder. Account-specific.
export async function emptyFolder({ account, folder }, onProgress) {
  const path = normPath(folder)
  const acc = findRaw(account)
  if (!acc) return { ok: false, error: 'account not found' }
  let client
  let done = 0
  try {
    client = clientFor(acc)
    await client.connect()
    const lock = await lockResolved(client, path)
    const su = client.mailbox?.specialUse
    let notPurgeable = false
    try {
      if (su !== '\\Trash' && su !== '\\Junk') {
        notPurgeable = true // safety: only ever bulk-purge Trash or Spam, never another folder
      } else {
        const uids = (await client.search({ all: true }, { uid: true })) || []
        const total = uids.length
        onProgress?.(0, total)
        for (let i = 0; i < uids.length; i += 200) {
          const batch = uids.slice(i, i + 200)
          await client.messageDelete(batch, { uid: true })
          done += batch.length
          onProgress?.(done, total)
        }
      }
    } finally {
      lock.release()
    }
    await client.logout()
    if (notPurgeable) return { ok: false, error: 'not a trash or spam folder' }
    return { ok: true, deleted: done }
  } catch (e) {
    try { await client?.close?.() } catch { /* ignore */ }
    return { ok: false, error: imapError(e) }
  }
}

// Move every READ (\Seen) message in a folder to Trash (or expunge if the folder IS Trash),
// in batches, reporting progress via onProgress(done, total). Handles the unified 'all'.
export async function deleteReadInFolder({ account, folder }, onProgress) {
  const path = normPath(folder)
  const accts = account && account !== 'all' ? [findRaw(account)].filter(Boolean) : rawAccounts()
  let done = 0
  let total = 0
  for (const acc of accts) {
    let client
    try {
      client = clientFor(acc)
      await client.connect()
      let trashPath = '[Gmail]/Trash'
      try {
        const mbs = (await client.list()) || []
        const byUse = mbs.find((mb) => mb.specialUse === '\\Trash')
        const byName = mbs.find((mb) => /trash|bin|deleted|корзин|кошик|удал/i.test(mb.path || mb.name || ''))
        trashPath = byUse?.path || byName?.path || trashPath
      } catch {
        /* default */
      }
      const lock = await lockResolved(client, path)
      try {
        const inTrash = client.mailbox?.specialUse === '\\Trash' || path === trashPath
        const uids = (await client.search({ seen: true }, { uid: true })) || []
        total += uids.length
        onProgress?.(done, total)
        for (let i = 0; i < uids.length; i += 200) {
          const batch = uids.slice(i, i + 200)
          if (inTrash) await client.messageDelete(batch, { uid: true })
          else {
            try {
              await client.messageMove(batch, trashPath, { uid: true })
            } catch {
              await client.messageDelete(batch, { uid: true })
            }
          }
          done += batch.length
          onProgress?.(done, total)
        }
      } finally {
        lock.release()
      }
      await client.logout()
    } catch (e) {
      try {
        await client?.close?.()
      } catch {
        /* ignore */
      }
      console.warn('[mail] delete-read failed', acc.email, path, e?.message)
    }
  }
  return { ok: true, deleted: done, total }
}

// Bulk delete a set of {account, threadId, id} in `folder` using ONE IMAP connection
// per account (50 separate deletes would blow past Gmail's connection limit and most
// would silently fail). In Trash → expunge permanently; elsewhere → move to Trash.
export async function bulkDeleteMail({ folder = 'INBOX', items = [] }) {
  const byAcct = new Map()
  for (const it of items || []) {
    if (!it?.account) continue
    if (!byAcct.has(it.account)) byAcct.set(it.account, [])
    byAcct.get(it.account).push(it)
  }
  const path = normPath(folder)
  // tombstone everything up front, before the slow IMAP work — so any list load already in
  // flight (or the 20s poll) immediately hides these rows; they can't flash back mid-expunge
  for (const [email, list] of byAcct) tombstone(email, list, path)
  for (const [email, list] of byAcct) {
    const acc = findRaw(email)
    if (!acc) continue
    let client
    try {
      client = clientFor(acc)
      await client.connect()
      let trashPath = '[Gmail]/Trash'
      try {
        const mbs = (await client.list()) || []
        const byUse = mbs.find((mb) => mb.specialUse === '\\Trash')
        const byName = mbs.find((mb) => /trash|bin|deleted|корзин|кошик|удал/i.test(mb.path || mb.name || ''))
        trashPath = byUse?.path || byName?.path || trashPath
      } catch {
        /* default */
      }
      const lock = await lockResolved(client, path)
      try {
        const inTrash = client.mailbox?.specialUse === '\\Trash' || path === trashPath
        const all = []
        for (const it of list) {
          const uids = it.threadId
            ? await client.search({ threadId: String(it.threadId) }, { uid: true })
            : await client.search({ header: { 'message-id': it.id } }, { uid: true })
          if (uids?.length) all.push(...uids)
        }
        const uids = [...new Set(all)]
        if (uids.length) {
          if (inTrash) await client.messageDelete(uids, { uid: true })
          else {
            try {
              await client.messageMove(uids, trashPath, { uid: true })
            } catch {
              await client.messageDelete(uids, { uid: true })
            }
          }
        }
      } finally {
        lock.release()
      }
      await client.logout()
      list.forEach((it) => deleteCachedMail(email, it.threadId, it.id))
    } catch (e) {
      try {
        await client?.close?.()
      } catch {
        /* ignore */
      }
      console.warn('[mail] bulk delete failed', email, e?.message)
    }
  }
  return { ok: true }
}

// Bulk mark {account, threadId, id} in `folder` read/unread — one connection per account.
export async function bulkSeenMail({ folder = 'INBOX', items = [], seen = true }) {
  const byAcct = new Map()
  for (const it of items || []) {
    if (!it?.account) continue
    if (!byAcct.has(it.account)) byAcct.set(it.account, [])
    byAcct.get(it.account).push(it)
  }
  const path = normPath(folder)
  for (const [email, list] of byAcct) {
    const acc = findRaw(email)
    if (!acc) continue
    let client
    try {
      client = clientFor(acc)
      await client.connect()
      const lock = await lockResolved(client, path)
      try {
        const all = []
        for (const it of list) {
          const uids = it.threadId
            ? await client.search({ threadId: String(it.threadId) }, { uid: true })
            : await client.search({ header: { 'message-id': it.id } }, { uid: true })
          if (uids?.length) all.push(...uids)
        }
        const uids = [...new Set(all)]
        if (uids.length) {
          if (seen) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true })
          else await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true })
        }
      } finally {
        lock.release()
      }
      await client.logout()
    } catch (e) {
      try {
        await client?.close?.()
      } catch {
        /* ignore */
      }
      console.warn('[mail] bulk seen failed', email, e?.message)
    }
  }
  return { ok: true }
}

// Search the whole folder (not just the loaded page) via Gmail X-GM-RAW, streaming
// matches back in small batches through onBatch(metas) so the UI fills in progressively
// instead of waiting for everything. Returns the total match count.
// search ONE account's whole mailbox (All Mail, so archived mail is found too — not
// just the current folder) and stream matches in newest-first batches via onBatch.
async function searchOneAccount(acc, q, onBatch) {
  let client
  let total = 0
  try {
    client = clientFor(acc)
    await client.connect()
    // search across All Mail + Trash + Spam so nothing is missed (All Mail excludes
    // Trash/Spam). Resolve them by SPECIAL-USE, not by literal name — Gmail localizes the
    // paths (e.g. "[Gmail]/Вся пошта"), which is why a hard-coded "[Gmail]/All Mail" lock
    // failed and the search fell back to INBOX, finding almost nothing.
    const boxes = []
    try {
      const list = (await client.list()) || []
      for (const use of ['\\All', '\\Trash', '\\Junk']) {
        const b = list.find((mb) => mb.specialUse === use)
        if (b?.path) boxes.push(b.path)
      }
    } catch {
      /* ignore — fall back below */
    }
    if (!boxes.length) boxes.push('INBOX') // non-Gmail account
    console.log('[mail] search boxes', acc.email, boxes)
    const seen = new Set() // dedup across boxes by message-id
    for (const path of boxes) {
      let lock
      try {
        lock = await lockResolved(client, path)
      } catch {
        continue // box vanished between LIST and SELECT → skip it
      }
      try {
        // standard IMAP SEARCH does SUBSTRING, case-insensitive matching — so "Medi" finds
        // "Medium" and the sender's display name matches. (Gmail X-GM-RAW only matches whole
        // indexed WORDS, which is why partial names/words found nothing.) Match the sender,
        // subject and body; OR them together.
        const uids = (await client.search({ or: [{ from: q }, { subject: q }, { body: q }] }, { uid: true })) || []
        console.log('[mail] search', path, JSON.stringify(q), '→', uids.length, 'uids')
        const sorted = uids.slice().sort((a, b) => b - a) // newest first
        total += sorted.length
        for (let i = 0; i < sorted.length; i += 25) {
          const batch = sorted.slice(i, i + 25)
          const metas = []
          for await (const m of client.fetch(batch, { uid: true, envelope: true, flags: true, internalDate: true, labels: true, threadId: true, bodyStructure: true }, { uid: true })) {
            const env = m.envelope || {}
            const mid = env.messageId || `uid-${path}-${m.uid}`
            if (seen.has(mid)) continue
            seen.add(mid)
            metas.push({
              id: mid,
              account: acc.email,
              threadId: m.threadId != null ? String(m.threadId) : null,
              from: env.from?.[0]?.name || env.from?.[0]?.address || '',
              to: fmtAddr(env.to?.[0]),
              subject: env.subject || '',
              snippet: '',
              date: (m.internalDate || env.date || new Date(0)).getTime(),
              labels: [path],
              unread: !(m.flags && m.flags.has('\\Seen')),
              important: hasImportant(m.labels),
              attachments: extractAttachments(m.bodyStructure).map((a) => ({ ...a, mid }))
            })
          }
          const live = dropTombstoned(acc.email, metas) // don't resurface locally-deleted mail
          if (live.length) onBatch?.(live)
        }
      } finally {
        lock.release()
      }
    }
    await client.logout()
  } catch (e) {
    try {
      await client?.close?.()
    } catch {
      /* ignore */
    }
    console.warn('[mail] search failed', acc.email, e?.message)
  }
  return total
}

export async function searchMessages({ account, query }, onBatch) {
  const q = String(query || '').trim()
  if (!q) return { ok: true, total: 0 }
  const accts = account && account !== 'all' ? [findRaw(account)].filter(Boolean) : rawAccounts()
  // run every account in PARALLEL, each guarded by its own timeout so one stuck
  // connection can't keep the spinner alive forever (the renderer waits on `done`)
  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((res) => setTimeout(() => res(0), ms))])
  const counts = await Promise.all(
    accts.map((acc) => withTimeout(searchOneAccount(acc, q, onBatch), 45000))
  )
  return { ok: true, total: counts.reduce((a, b) => a + (b || 0), 0) }
}

// cheap per-folder counts via IMAP STATUS (MESSAGES + UNSEEN) — no FETCH, no body.
// Used for the tree's unread "(N)" badges. Returns { path: { total, unread } }.
export async function mailFolderStats(email, paths) {
  const acc = findRaw(email)
  if (!acc) return { ok: false, error: 'account not found' }
  const wanted = (Array.isArray(paths) && paths.length ? paths : ['INBOX']).map(normPath)
  let client
  try {
    client = clientFor(acc)
    await client.connect()
    const stats = {}
    for (const path of wanted) {
      try {
        const s = await client.status(path, { messages: true, unseen: true })
        stats[path] = { total: s?.messages || 0, unread: s?.unseen || 0 }
      } catch { /* skip folders that can't be STATUS'd */ }
    }
    await client.logout()
    return { ok: true, stats }
  } catch (err) {
    try { await client?.close?.() } catch { /* ignore */ }
    return { ok: false, error: imapError(err) }
  }
}

// friendlier messages for the usual app-password / IMAP-off mistakes
function imapError(err) {
  const m = err?.responseText || err?.message || String(err)
  if (/AUTHENTICATIONFAILED|Invalid credentials|Username and Password not accepted/i.test(m))
    return 'login failed — use a Google App Password (with 2-Step Verification on), not your normal password'
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(m)) return `cannot reach the mail server (${m})`
  return m
}
