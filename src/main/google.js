import { createServer } from 'http'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { shell, safeStorage } from 'electron'
import { loadAiConfig, saveAiConfig } from './aiConfig'

// tag stamped on events we create, so any copy of the app (e.g. a partner on a
// shared calendar) can recognise them via extendedProperties.shared.app
const APP_TAG = 'aicalendar'

// Google Calendar (read-only) over plain REST — no SDK, mirrors telegram.js.
// OAuth2 "Desktop app" loopback flow with PKCE: open the system browser, catch
// the redirect on a localhost server, exchange the code for tokens. Only the
// refresh token is persisted (encrypted); access tokens live in memory.

// readonly = list calendars + read events; events = create/edit events on
// calendars the user can write to (for shared-calendar notes)
const SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events openid email'
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const CAL = 'https://www.googleapis.com/calendar/v3'

// in-memory: email -> { accessToken, expiresAt }
const live = new Map()
// in-memory cache: email -> [{ id, summary, primary, color }]
const calCache = new Map()

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// ---- secret storage (refresh tokens) -----------------------------------
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
  if (!s.startsWith(ENC)) return s // plaintext / legacy
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(ENC.length), 'base64'))
  } catch {
    return ''
  }
}

// ---- accounts CRUD over ai-config.json ---------------------------------
export function getAccounts() {
  const a = loadAiConfig().googleAccounts
  return Array.isArray(a) ? a : []
}
function saveAccounts(list) {
  saveAiConfig({ googleAccounts: list })
}
function findAccount(email) {
  return getAccounts().find((a) => a.email === email) || null
}
export function upsertAccount(acc) {
  const list = getAccounts().filter((a) => a.email !== acc.email)
  list.push(acc)
  saveAccounts(list)
}
export function removeAccount(email) {
  saveAccounts(getAccounts().filter((a) => a.email !== email))
  live.delete(email)
  calCache.delete(email)
  return { ok: true }
}
export function setSelectedCalendars(email, ids) {
  const list = getAccounts().map((a) => (a.email === email ? { ...a, selectedCalendarIds: ids || [] } : a))
  saveAccounts(list)
  return { ok: true }
}
export function setAutoSyncCalendars(email, ids) {
  const list = getAccounts().map((a) => (a.email === email ? { ...a, autoSyncCalendarIds: ids || [] } : a))
  saveAccounts(list)
  return { ok: true }
}
// calendars flagged for auto-sync → [{ account, id }] (consumed by the sync runner)
export function autoSyncCalendars() {
  const out = []
  for (const a of getAccounts()) {
    if (a.needsReconnect) continue
    for (const id of a.autoSyncCalendarIds || []) out.push({ account: a.email, id })
  }
  return out
}

// summary for the AI prompt — emails + selected calendar names ONLY, never tokens
export function accountsSummary() {
  return getAccounts().map((a) => ({
    email: a.email,
    needsReconnect: !!a.needsReconnect,
    calendars: (calCache.get(a.email) || [])
      .filter((c) => (a.selectedCalendarIds || []).includes(c.id))
      .map((c) => ({ summary: c.summary, writable: !!c.writable }))
  }))
}

// Baked into the build from .env (gitignored) so distributed installs work
// without each user pasting credentials. ai-config.json overrides if set.
const ENV_ID = import.meta.env?.MAIN_VITE_GOOGLE_CLIENT_ID || ''
const ENV_SECRET = import.meta.env?.MAIN_VITE_GOOGLE_CLIENT_SECRET || ''
function creds() {
  const c = loadAiConfig()
  return {
    clientId: c.googleClientId || ENV_ID,
    clientSecret: c.googleClientSecret || ENV_SECRET
  }
}

// ---- token plumbing ----------------------------------------------------
async function exchangeToken(params) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  })
  return res.json()
}

async function accessTokenFor(email) {
  const cached = live.get(email)
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.accessToken
  const acc = findAccount(email)
  if (!acc) throw new Error('account not connected')
  const { clientId, clientSecret } = creds()
  const r = await exchangeToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: decryptSecret(acc.refreshToken)
  })
  if (r.error || !r.access_token) {
    // refresh token died (testing-mode 7-day expiry / revoked) → flag reconnect
    if (r.error === 'invalid_grant') {
      upsertAccount({ ...acc, needsReconnect: true })
    }
    throw new Error(r.error_description || r.error || 'token refresh failed')
  }
  if (acc.needsReconnect) upsertAccount({ ...acc, needsReconnect: false })
  const tok = { accessToken: r.access_token, expiresAt: Date.now() + (r.expires_in || 3600) * 1000 }
  live.set(email, tok)
  return tok.accessToken
}

async function apiGet(email, path) {
  const token = await accessTokenFor(email)
  let res = await fetch(CAL + path, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 401) {
    live.delete(email) // force one refresh + retry
    const t2 = await accessTokenFor(email)
    res = await fetch(CAL + path, { headers: { Authorization: `Bearer ${t2}` } })
  }
  const json = await res.json()
  if (json && json.error) {
    console.warn(`[google] API ${res.status} on ${path.split('?')[0]}:`, JSON.stringify(json.error))
  }
  return json
}

async function apiPost(email, path, body) {
  const send = (tok) =>
    fetch(CAL + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  let res = await send(await accessTokenFor(email))
  if (res.status === 401) {
    live.delete(email) // force one refresh + retry
    res = await send(await accessTokenFor(email))
  }
  const json = await res.json()
  if (json && json.error) {
    console.warn(`[google] POST ${res.status} on ${path.split('?')[0]}:`, JSON.stringify(json.error))
  }
  return { status: res.status, json }
}

async function apiPatch(email, path, body) {
  const send = (tok) =>
    fetch(CAL + path, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  let res = await send(await accessTokenFor(email))
  if (res.status === 401) {
    live.delete(email)
    res = await send(await accessTokenFor(email))
  }
  const json = await res.json()
  if (json && json.error) {
    console.warn(`[google] PATCH ${res.status} on ${path.split('?')[0]}:`, JSON.stringify(json.error))
  }
  return { status: res.status, json }
}

// ---- OAuth loopback connect --------------------------------------------
export function connectAccount() {
  const { clientId, clientSecret } = creds()
  if (!clientId || !clientSecret) {
    return Promise.resolve({ ok: false, error: 'Set googleClientId and googleClientSecret in ai-config.json first (see README).' })
  }
  return new Promise((resolve) => {
    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(16))
    let done = false

    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (!url.searchParams.get('code') && !url.searchParams.get('error')) {
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body style="font-family:sans-serif;padding:40px;text-align:center">✅ Готово. Можете закрити це вікно.<br>You can close this window.</body></html>')
      finish(url)
    })

    const fail = (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { server.close() } catch { /* ignore */ }
      resolve({ ok: false, error })
    }

    const finish = async (url) => {
      if (done) return
      if (url.searchParams.get('state') !== state) return fail('state mismatch')
      const code = url.searchParams.get('code')
      if (!code) return fail(url.searchParams.get('error') || 'no code')
      done = true
      clearTimeout(timer)
      const port = server.address().port
      try {
        const tok = await exchangeToken({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: `http://127.0.0.1:${port}`
        })
        if (tok.error || !tok.refresh_token) {
          return resolveClose({ ok: false, error: tok.error_description || tok.error || 'no refresh token (revoke prior access and retry)' })
        }
        const who = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tok.access_token}` }
        }).then((r) => r.json())
        const email = who.email || 'unknown'
        console.warn(`[google] connected ${email}; granted scope: ${tok.scope || '(none)'}`)
        const existing = findAccount(email)
        // Google's granular consent lets the user skip the calendar checkbox —
        // if they did, we got no calendar scope and the account is useless.
        // Save it flagged so Settings shows "needs reconnect", and tell them why.
        if (!/calendar/i.test(tok.scope || '')) {
          upsertAccount({
            email,
            displayName: who.name || email,
            refreshToken: encryptSecret(tok.refresh_token),
            selectedCalendarIds: existing?.selectedCalendarIds || [],
            needsReconnect: true
          })
          return resolveClose({
            ok: false,
            error: `${email}: calendar access was not granted. Reconnect and tick "See your calendars".`
          })
        }
        live.set(email, { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 })
        upsertAccount({
          email,
          displayName: who.name || email,
          refreshToken: encryptSecret(tok.refresh_token),
          selectedCalendarIds: existing?.selectedCalendarIds || [],
          needsReconnect: false
        })
        resolveClose({ ok: true, email })
      } catch (e) {
        resolveClose({ ok: false, error: e?.message || String(e) })
      }
    }

    const resolveClose = (r) => {
      try { server.close() } catch { /* ignore */ }
      resolve(r)
    }

    const timer = setTimeout(() => fail('timed out waiting for Google sign-in'), 180000)
    server.on('error', (e) => fail(e?.message || 'server error'))
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      const u = new URL(AUTH)
      u.searchParams.set('client_id', clientId)
      u.searchParams.set('redirect_uri', `http://127.0.0.1:${port}`)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('scope', SCOPE)
      u.searchParams.set('access_type', 'offline')
      u.searchParams.set('prompt', 'consent')
      u.searchParams.set('code_challenge', challenge)
      u.searchParams.set('code_challenge_method', 'S256')
      u.searchParams.set('state', state)
      shell.openExternal(u.toString())
    })
  })
}

// ---- calendars & events ------------------------------------------------
export async function listCalendars(email) {
  const r = await apiGet(email, '/users/me/calendarList?maxResults=250&showHidden=true')
  const items = (r.items || []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride || c.summary,
    primary: !!c.primary,
    color: c.backgroundColor || null,
    // owner/writer = we can create events here (shared-calendar notes); reader/freeBusyReader = read-only
    writable: c.accessRole === 'owner' || c.accessRole === 'writer'
  }))
  calCache.set(email, items)
  return items
}

// list accounts merged with their calendar lists + current selection (for Settings)
export async function listAccountsWithCalendars() {
  const out = []
  for (const a of getAccounts()) {
    let calendars = []
    if (!a.needsReconnect) {
      try {
        calendars = await listCalendars(a.email)
        console.warn(`[google] ${a.email}: ${calendars.length} calendars`)
      } catch (e) {
        console.warn(`[google] listCalendars failed for ${a.email}:`, e?.message)
      }
    }
    out.push({
      email: a.email,
      displayName: a.displayName || a.email,
      needsReconnect: !!a.needsReconnect,
      calendars: calendars.map((c) => ({
        ...c,
        selected: (a.selectedCalendarIds || []).includes(c.id),
        autoSync: (a.autoSyncCalendarIds || []).includes(c.id)
      }))
    })
  }
  return out
}

// RFC3339 (with offset) or all-day date → local { day:'YYYY-MM-DD', time:'HH:mm'|null }
function localParts(start) {
  if (start.date) return { day: start.date, time: null, allDay: true } // all-day
  const d = new Date(start.dateTime)
  const p = (n) => String(n).padStart(2, '0')
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    allDay: false
  }
}

export async function listEvents(email, calId, timeMin, timeMax) {
  // timeMax is EXCLUSIVE — a date-only "to" (YYYY-MM-DD) would cut off that whole
  // day's events, so bump it to the next midnight to include the full `to` day
  const maxDate = new Date(timeMax)
  if (String(timeMax).length <= 10) maxDate.setDate(maxDate.getDate() + 1)
  const qs = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
    timeMin: new Date(timeMin).toISOString(),
    timeMax: maxDate.toISOString()
  })
  const r = await apiGet(email, `/calendars/${encodeURIComponent(calId)}/events?${qs}`)
  const calName = (calCache.get(email) || []).find((c) => c.id === calId)?.summary || calId
  return (r.items || [])
    .filter((e) => e.status !== 'cancelled' && (e.start?.dateTime || e.start?.date))
    .map((e) => {
      const { day, time, allDay } = localParts(e.start)
      return {
        googleEventId: `${email}:${calId}:${e.id}`,
        account: email,
        calendarId: calId,
        calendarName: calName,
        title: e.summary || '(no title)',
        description: e.description || '',
        location: e.location || '',
        day,
        time,
        allDay,
        htmlLink: e.htmlLink || '',
        recurring: !!e.recurringEventId, // an instance of a repeating series
        recurringEventId: e.recurringEventId || null,
        // metadata we (or a partner's copy) stamped on creation
        appCreated: e.extendedProperties?.shared?.app === APP_TAG,
        taskId: e.extendedProperties?.shared?.taskId || null
      }
    })
}

// selected calendars the user can write to (owner/writer) — used by the editor's
// "share to Google" button. Reads the in-memory cache (warms it once if cold) so
// it's cheap to call on every editor open.
export async function writableCalendars() {
  const out = []
  for (const a of getAccounts()) {
    if (a.needsReconnect) continue
    if (!calCache.has(a.email)) {
      try { await listCalendars(a.email) } catch { continue }
    }
    for (const c of calCache.get(a.email) || [])
      if (c.writable && (a.selectedCalendarIds || []).includes(c.id))
        out.push({ account: a.email, id: c.id, summary: c.summary })
  }
  return out
}

// build a Google event resource body from our note shape
// ev = { title, day:'YYYY-MM-DD', time:'HH:mm'|null, durationMin?, description?, location? }
// weekday index (0=Sun..6=Sat) → Google BYDAY code
const RRULE_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

// Build a Google RRULE for a recurring "everyday" note: monthly (byMonthDay,
// 32 = last day → BYMONTHDAY=-1) or weekly (byDay). Returns the recurrence array
// Google expects, or null when the note doesn't repeat.
function recurrenceRule(days, monthDays) {
  if (Array.isArray(monthDays) && monthDays.length) {
    const md = [...new Set(monthDays.map((n) => (n >= 32 ? -1 : n)))].join(',')
    return [`RRULE:FREQ=MONTHLY;BYMONTHDAY=${md}`]
  }
  if (Array.isArray(days) && days.length) {
    const by = days.map((d) => RRULE_DAY[d]).filter(Boolean).join(',')
    if (by) return [`RRULE:FREQ=WEEKLY;BYDAY=${by}`]
  }
  return null
}

function buildEventBody(ev) {
  const body = { summary: ev.title || '(no title)', description: ev.description || '', location: ev.location || '' }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const p = (n) => String(n).padStart(2, '0')
  // recurring event (from a shared "everyday" note): weekly or monthly RRULE
  const rec = recurrenceRule(ev.days, ev.monthDays)
  if (rec) body.recurrence = rec
  if (ev.time) {
    const dur = Number(ev.durationMin) > 0 ? Number(ev.durationMin) : 60
    const end = new Date(`${ev.day}T${ev.time}:00`)
    end.setMinutes(end.getMinutes() + dur)
    const endStr = `${end.getFullYear()}-${p(end.getMonth() + 1)}-${p(end.getDate())}T${p(end.getHours())}:${p(end.getMinutes())}:00`
    // date:null clears the all-day fields — required so a PATCH can convert an
    // all-day event into a timed one (Google rejects it otherwise)
    body.start = { dateTime: `${ev.day}T${ev.time}:00`, timeZone: tz, date: null }
    body.end = { dateTime: endStr, timeZone: tz, date: null }
  } else {
    // all-day: Google's end.date is exclusive → next day for a single-day event.
    // dateTime:null clears the timed fields (timed → all-day on PATCH)
    const nd = new Date(`${ev.day}T00:00:00`)
    nd.setDate(nd.getDate() + 1)
    body.start = { date: ev.day, dateTime: null }
    body.end = { date: `${nd.getFullYear()}-${p(nd.getMonth() + 1)}-${p(nd.getDate())}`, dateTime: null }
  }
  return body
}

const scopeError = (status, msg) =>
  status === 403 || /insufficient|scope|permission/i.test(msg || '')
    ? 'no write access to this calendar — reconnect the account in Settings (grant calendar edit), and make sure your role is owner/writer'
    : msg || 'Google rejected the request'

// split our composite gid "email:calId:eventId" (email & calId never contain ':')
function splitGid(gid) {
  const i1 = String(gid).indexOf(':')
  const i2 = String(gid).indexOf(':', i1 + 1)
  if (i1 < 0 || i2 < 0) return null
  return { email: gid.slice(0, i1), calId: gid.slice(i1 + 1, i2), eventId: gid.slice(i2 + 1) }
}

// Create a one-time event on a (writable) calendar — used for shared-calendar
// notes. Returns the created event normalized like listEvents so the caller can
// import it locally.
export async function createEvent(email, calId, ev) {
  const calName = (calCache.get(email) || []).find((c) => c.id === calId)?.summary || calId
  const body = buildEventBody(ev)
  // stamp app metadata: shared (everyone on the calendar sees it) + our private note link
  body.extendedProperties = { shared: { app: APP_TAG, taskId: ev.taskId || randomUUID() } }
  if (ev.noteId) body.extendedProperties.private = { noteId: String(ev.noteId) }
  const { status, json } = await apiPost(email, `/calendars/${encodeURIComponent(calId)}/events`, body)
  if (json?.error || !json?.id) return { ok: false, error: scopeError(status, json?.error?.message) }
  const { day, time, allDay } = localParts(json.start)
  return {
    ok: true,
    event: {
      googleEventId: `${email}:${calId}:${json.id}`,
      account: email,
      calendarId: calId,
      calendarName: calName,
      title: json.summary || ev.title,
      description: json.description || '',
      location: json.location || '',
      day,
      time,
      allDay,
      htmlLink: json.htmlLink || '',
      recurring: !!(json.recurrence && json.recurrence.length),
      recurringEventId: json.recurrence && json.recurrence.length ? json.id : null,
      appCreated: true,
      taskId: json.extendedProperties?.shared?.taskId || null
    }
  }
}

// Patch a Google event when its linked note is edited locally. Works for ANY
// note on a writable calendar (not only ones we created) so the user can edit
// shared calendars from our UI. Read-only calendars are skipped silently.
export async function updateEvent(gid, ev) {
  const g = splitGid(gid)
  if (!g) return { ok: false, error: 'bad event id' }
  if (!calCache.has(g.email)) {
    try { await listCalendars(g.email) } catch { /* no cache → let Google decide */ }
  }
  const cal = (calCache.get(g.email) || []).find((c) => c.id === g.calId)
  if (cal && !cal.writable) return { ok: true, skipped: true } // read-only → don't push, not an error
  const path = `/calendars/${encodeURIComponent(g.calId)}/events/${encodeURIComponent(g.eventId)}`
  // a recurring "everyday" note has no real date of its own (ev.day = 'everyday').
  // Read the series master's OWN start date and keep it, applying just the new
  // time + recurrence — so editing a periodic note updates its Google series.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.day || '')) {
    const cur = await apiGet(g.email, path)
    const day = cur?.start?.date || (cur?.start?.dateTime ? localParts(cur.start).day : null)
    if (!day) return { ok: false, error: 'could not read the recurring event to update it' }
    ev = { ...ev, day }
  }
  const { status, json } = await apiPatch(g.email, path, buildEventBody(ev))
  if (json?.error) return { ok: false, error: scopeError(status, json?.error?.message) }
  return { ok: true }
}

// Is the calendar behind a linked event writable (owner/writer)? Mirrors
// updateEvent's gate so the editor can offer "delete from Google" for ANY
// editable event (imported from a shared calendar we can write to), not only
// notes we created ourselves.
export async function eventWritable(gid) {
  const g = splitGid(gid)
  if (!g) return false
  if (!calCache.has(g.email)) {
    try { await listCalendars(g.email) } catch { return false }
  }
  const cal = (calCache.get(g.email) || []).find((c) => c.id === g.calId)
  return !!(cal && cal.writable)
}

// Does a Google event still exist? Used by auto-sync to decide whether an
// imported note whose event vanished should be removed. SAFE by design: returns
// false ONLY when Google explicitly says the event is gone (404/410) or cancelled;
// on any uncertainty (network/auth error, bad id) it returns true so the caller
// never deletes a note on a transient failure.
export async function eventExists(gid) {
  const g = splitGid(gid)
  if (!g) return true
  try {
    const r = await apiGet(g.email, `/calendars/${encodeURIComponent(g.calId)}/events/${encodeURIComponent(g.eventId)}`)
    if (r?.error) return !(r.error.code === 404 || r.error.code === 410) // only 404/410 = truly gone
    return r?.status !== 'cancelled'
  } catch {
    return true // network/other error → assume it still exists, do NOT delete
  }
}

// Delete an event from its Google calendar (when a shared/imported note is
// deleted). Skips read-only calendars silently, symmetric with updateEvent.
export async function deleteEvent(gid) {
  const g = splitGid(gid)
  if (!g) return { ok: false, error: 'bad event id' }
  if (!calCache.has(g.email)) {
    try { await listCalendars(g.email) } catch { /* no cache → let Google decide */ }
  }
  const cal = (calCache.get(g.email) || []).find((c) => c.id === g.calId)
  if (cal && !cal.writable) return { ok: true, skipped: true } // read-only → don't delete, not an error
  const path = `/calendars/${encodeURIComponent(g.calId)}/events/${encodeURIComponent(g.eventId)}`
  const send = (tok) => fetch(CAL + path, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
  let res = await send(await accessTokenFor(g.email))
  if (res.status === 401) {
    live.delete(g.email)
    res = await send(await accessTokenFor(g.email))
  }
  // 204 = deleted; 404/410 = already gone → treat as success
  if (res.status === 204 || res.status === 404 || res.status === 410) return { ok: true }
  let msg = `delete failed (${res.status})`
  try { const j = await res.json(); if (j?.error?.message) msg = j.error.message } catch { /* no body */ }
  return { ok: false, error: scopeError(res.status, msg) }
}

// Parse a Google RRULE into our "everyday" recurrence model. Returns
// { supported, days:[0-6] } for weekly/daily, or { supported, monthDays:[1-31|32] }
// for monthly (32 = last day, from BYMONTHDAY=-1). Yearly / INTERVAL>1 is unsupported.
const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
function parseRecurrence(recurrence) {
  const rule = (recurrence || []).find((r) => String(r).startsWith('RRULE:'))
  if (!rule) return { supported: false }
  const p = Object.fromEntries(rule.slice(6).split(';').map((kv) => kv.split('=')))
  if (parseInt(p.INTERVAL || '1', 10) > 1) return { supported: false }
  if (p.FREQ === 'DAILY') return { supported: true, days: [0, 1, 2, 3, 4, 5, 6] }
  if (p.FREQ === 'WEEKLY') {
    const days = (p.BYDAY || '')
      .split(',')
      .map((d) => BYDAY[d.replace(/^[+-]?\d*/, '')])
      .filter((n) => n !== undefined)
      .sort((a, b) => a - b)
    return { supported: true, days }
  }
  if (p.FREQ === 'MONTHLY') {
    const monthDays = (p.BYMONTHDAY || '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .map((n) => (n === -1 ? 32 : n)) // Google's "last day" (-1) → our 32 sentinel
      .filter((n) => n >= 1 && n <= 32)
      .sort((a, b) => a - b)
    if (monthDays.length) return { supported: true, monthDays: [...new Set(monthDays)] }
  }
  return { supported: false }
}

// Read a recurring series' master event and return its recurrence (for importing
// as an "everyday" note): { supported, days, time }.
export async function eventRecurrence(email, calId, recurringEventId) {
  const r = await apiGet(email, `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(recurringEventId)}`)
  const parsed = parseRecurrence(r?.recurrence)
  const time = r?.start?.dateTime ? localParts(r.start).time : null
  return { ...parsed, time }
}

// every selected calendar of one account ('all' = every connected account).
// Accounts and their calendars are fetched in parallel — wall time is the
// slowest single calendar, not the sum of all of them.
export async function listEventsAllSelected(email, timeMin, timeMax) {
  const accounts = email && email !== 'all' ? getAccounts().filter((a) => a.email === email) : getAccounts()
  const perAccount = await Promise.all(
    accounts.map(async (a) => {
      if (a.needsReconnect) return []
      // listing calendars (if not cached) also warms this account's access token,
      // so the parallel listEvents below reuse it instead of each refreshing
      if (!calCache.has(a.email)) {
        try { await listCalendars(a.email) } catch { return [] }
      }
      const lists = await Promise.all(
        (a.selectedCalendarIds || []).map((calId) =>
          listEvents(a.email, calId, timeMin, timeMax).catch(() => []) // skip a failing calendar
        )
      )
      return lists.flat()
    })
  )
  const out = perAccount.flat()
  out.sort((x, y) => (x.day + (x.time || '')).localeCompare(y.day + (y.time || '')))
  return out
}
