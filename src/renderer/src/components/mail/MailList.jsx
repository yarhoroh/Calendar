import { useEffect, useMemo, useRef, useState } from 'react'
import { onMailChanged, emitMailChanged } from '../../lib/mailBus'
import api from '../../lib/api'
import { MailIcon, TrashIcon } from '../icons'
import { useI18n } from '../../i18n/I18nContext'
import MailListHead from './MailListHead'
import MailTabs from './MailTabs'
import MailToolbar from './MailToolbar'
import MailRow from './MailRow'
import MailReader from './MailReader'
import MailWebView from './MailWebView'
import ContextMenu from '../ContextMenu'
import './MailList.css'

const PER_PAGE = 50

// short relative date for the row (time today, "Mon D" this year, else full)
function fmtDate(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// The message list. ONE component for both a single account and the unified
// ("all") views — the only difference is the extra account column, toggled by
// `account === 'all'`. Loads real mail (cache first, then a fresh IMAP sync).
export default function MailList({ account = 'all', folder = 'INBOX', navKey = 0, showRecipient = false }) {
  const { t } = useI18n()
  const showAccount = account === 'all'
  // persisted view prefs — restore where the user left off
  const [tab, setTab] = useState(() => localStorage.getItem('mailTab') || 'primary')
  const [filter, setFilter] = useState(() => {
    const f = localStorage.getItem('mailFilter')
    return ['unread', 'attachments'].includes(f) ? f : 'all' // 'starred' was removed
  })
  const [paneMode, setPaneMode] = useState(() => localStorage.getItem('mailPane') || 'split')
  useEffect(() => localStorage.setItem('mailTab', tab), [tab])
  useEffect(() => localStorage.setItem('mailFilter', filter), [filter])
  useEffect(() => localStorage.setItem('mailPane', paneMode), [paneMode])

  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState([]) // streamed server-side search hits
  const [searching, setSearching] = useState(false)
  const searchTokenRef = useRef(0) // drops stale search batches when the query changes
  const loadTokenRef = useRef(0) // drops stale progressive-load partials when the view changes
  const inSearch = search.trim().length > 0
  // infinite scroll: `limit` is how many newest items are loaded; it grows by PER_PAGE as you
  // scroll to the bottom. A ref mirrors it so reload() always reads the current window.
  const [limit, setLimit] = useState(PER_PAGE)
  const limitRef = useRef(PER_PAGE)
  limitRef.current = limit
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const rowsRef = useRef(null) // the scrollable rows container (for "scroll to top" on refresh)
  const [selected, setSelected] = useState(() => new Set())
  const [stars, setStars] = useState({})
  const [importantOverride, setImportantOverride] = useState({}) // optimistic important toggles
  const [readKeys, setReadKeys] = useState(() => new Set()) // threads marked read by opening
  const [unreadKeys, setUnreadKeys] = useState(() => new Set()) // optimistic "mark unread" until the server confirms
  const [openMsg, setOpenMsg] = useState(null)
  const [internalUrl, setInternalUrl] = useState(null) // link opened in the in-app browser
  const [internalLang, setInternalLang] = useState('original') // pre-selected translate language
  const [linkMenu, setLinkMenu] = useState(null) // { x, y, url, lang } for the link right-click menu
  const openInternal = (url, lang) => {
    setInternalLang(lang || 'original')
    setInternalUrl(url)
  }
  const [messages, setMessages] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [tabCounts, setTabCounts] = useState({}) // unread per category tab (X-GM-RAW)
  // per-tab "seen" baseline → badges show only NEW mail since you last opened a tab
  const [seen, setSeen] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('mailSeen')) || {}
    } catch {
      return {}
    }
  })
  useEffect(() => localStorage.setItem('mailSeen', JSON.stringify(seen)), [seen])

  // category tabs only make sense on INBOX; every other folder shows everything
  const showTabs = folder === 'INBOX'
  // INBOX and Sent group messages into conversation threads; Trash/etc stay flat (one row
  // per message). Must match the backend's grouping (loadThreadPage vs loadFlatPage).
  const groupThreads = folder === 'INBOX' || showRecipient
  const effTab = showTabs ? tab : 'all'
  // category tabs (primary/updates/promotions/social) are a real backend query
  // (Gmail X-GM-RAW); 'all' shows the whole folder; 'starred' is a local overlay
  // on the 'all' set, so it shares its backend query.
  const backendTab = effTab === 'starred' ? 'all' : effTab

  // load the current page: instant from cache, then a fresh IMAP sync. `silent`
  // skips the loading flash so background refreshes don't flicker the list — rows
  // keep their keys, so React only patches what changed (new in, deleted out).
  const reload = (silent) => {
    let alive = true
    const token = ++loadTokenRef.current // newer load invalidates any in-flight partial
    // a silent (background) refresh never touches the visible list up front — rows keep
    // their keys and only get patched when fresh data arrives, so no flicker.
    if (!silent) {
      // instant cache flash — ONLY for INBOX. There the cache (sorted by date, tagged by
      // category tab) matches the server order, so the flash shows the right rows and the
      // live load just patches the delta in by row key. Flat folders (Trash/Sent) paginate
      // by UID server-side, which differs from the cache's date order and can include
      // already-expunged rows → the flash would show a *different* list than the live load
      // ("strange refresh"). So there we skip the flash and just show the spinner.
      if (groupThreads)
        Promise.resolve(api.mail?.cached?.(account, folder, backendTab, 1, limitRef.current, filter)).then((c) => alive && setMessages(Array.isArray(c) ? c : []))
      else setMessages([])
      setLoading(true)
    }
    // visible loads opt into progressive loading (pass token): a fast approximate page
    // arrives via onLoadPartial, then this resolves with the exact one. Silent refreshes
    // skip it (no token) — they just patch the final result in quietly. Always page 1 — the
    // window size (limit) is what grows for infinite scroll.
    Promise.resolve(api.mail?.load?.(account, folder, backendTab, 1, limitRef.current, filter, silent ? undefined : token, groupThreads)).then((r) => {
      if (!alive) return
      if (!silent) setLoading(false)
      if (r?.ok) {
        setMessages(r.messages || [])
        setTotal(r.total || 0)
      }
    })
    return () => { alive = false }
  }
  const reloadRef = useRef(reload)
  reloadRef.current = reload // keep the mail-bus handler calling the latest reload
  // infinite scroll: grow the window by PER_PAGE and silently re-fetch it (existing rows keep
  // their keys → scroll position stays; new rows append). Guarded against overlapping loads.
  const loadMore = () => {
    if (loadingMoreRef.current || inSearch || loading) return
    if (limitRef.current >= total) return // everything is already loaded
    loadingMoreRef.current = true
    setLoadingMore(true)
    const token = ++loadTokenRef.current
    limitRef.current += PER_PAGE
    setLimit(limitRef.current)
    Promise.resolve(api.mail?.load?.(account, folder, backendTab, 1, limitRef.current, filter, undefined, groupThreads)).then((r) => {
      loadingMoreRef.current = false
      setLoadingMore(false)
      if (token !== loadTokenRef.current) return // a newer load (view change) superseded this
      if (r?.ok) { setMessages(r.messages || []); setTotal(r.total || 0) }
    })
  }
  const onRowsScroll = (e) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadMore()
  }
  // the toolbar refresh button: visibly re-fetch the current view (or re-run the search)
  const refresh = () => {
    if (inSearch) {
      const token = ++searchTokenRef.current
      setSearchResults([])
      setSearching(true)
      api.mail?.search?.(account, folder, search.trim(), token)
    } else {
      // refresh = back to the newest PER_PAGE, scrolled to the top (collapse the grown window)
      limitRef.current = PER_PAGE
      setLimit(PER_PAGE)
      rowsRef.current?.scrollTo?.({ top: 0 })
      reload(false)
    }
  }
  // reset position when switching mailbox/folder/tab, then (re)load on any change
  const viewKey = account + '|' + folder + '|' + backendTab + '|' + filter
  const prevView = useRef(viewKey)
  // Clear the old folder's rows DURING RENDER (the React "reset state on prop change"
  // pattern), not in an effect — an effect runs after paint, so the previous list flashes
  // for a frame and confuses you. Doing it here means the old list never paints; the load
  // effect below then fills in the new folder's cache/live data.
  if (prevView.current !== viewKey && !inSearch) {
    prevView.current = viewKey
    setMessages([])
    setTotal(0)
    setOpenMsg(null)
    setSelected(new Set())
    limitRef.current = PER_PAGE // collapse the infinite-scroll window back to the first page
    setLimit(PER_PAGE)
  }
  useEffect(() => {
    if (inSearch) return // search mode streams its own results
    return reload(false) // the view was already cleared above → straight to cache/live load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, inSearch])
  // AI mail actions update an open list INSTANTLY (mirrors a manual delete/mark): the AI
  // mutates straight through the backend, so without this its delete/mark wouldn't show here
  // until the next reload — the row would just linger.
  useEffect(() => {
    return onMailChanged((e) => {
      if (e.type === 'delete') {
        const hit = (x) => (e.threadId && x.threadId === e.threadId) || (e.id && x.id === e.id)
        setMessages((ms) => ms.filter((x) => !hit(x)))
        setSearchResults((ms) => ms.filter((x) => !hit(x)))
        setOpenMsg((o) => (o && hit(o) ? null : o))
      } else if (e.type === 'seen') {
        const key = e.threadId || e.id
        const add = (s) => new Set(s).add(key)
        const drop = (s) => { const n = new Set(s); n.delete(key); return n }
        if (e.seen) { setReadKeys(add); setUnreadKeys(drop) }
        else { setUnreadKeys(add); setReadKeys(drop) }
      } else if (e.type === 'reload') {
        reloadRef.current?.(true)
      }
      // other event types (e.g. 'stats') are for the folder badges only — the list ignores them
    })
  }, [])
  // background sync: a cheap incremental poll every 20s checks just the newest few messages
  // and merges any arrivals into the list (delta by row key), instead of re-scanning the
  // whole folder. A full silent refresh every 2 min corrects totals/read-state. New mail
  // always lands at the top, so this runs regardless of how far you've scrolled.
  useEffect(() => {
    if (inSearch) return
    const mergeRecent = () => {
      Promise.resolve(api.mail?.recent?.(account, folder, backendTab, filter, 25)).then((r) => {
        if (!r?.ok || !r.messages?.length) return
        setMessages((cur) => {
          const have = new Set(cur.map((m) => m.id))
          const fresh = r.messages.filter((m) => !have.has(m.id))
          if (!fresh.length) return cur
          // bump the pager only for genuinely new conversations (a reply to a thread already
          // shown just re-sorts it to the top, it isn't a new row in the count)
          const curThreads = new Set(cur.map((m) => m.threadId || m.id))
          const newThreads = new Set(fresh.map((m) => m.threadId || m.id).filter((tid) => !curThreads.has(tid)))
          if (newThreads.size) {
            setTotal((t) => t + newThreads.size)
            // new mail arrived → tell the folder badges to re-pull their counts
            emitMailChanged({ type: 'stats', account, folder })
          }
          return [...fresh, ...cur].sort((a, b) => (b.date || 0) - (a.date || 0))
        })
      })
    }
    const poll = setInterval(mergeRecent, 20000)
    const full = setInterval(() => reload(true), 120000)
    return () => { clearInterval(poll); clearInterval(full) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, inSearch])

  // progressive load: apply the fast approximate page 1 as soon as it lands, so the list
  // fills in immediately while the exact full-scan page (and its precise pagination) is
  // still computing in the background.
  useEffect(() => {
    const off = api.mail?.onLoadPartial?.((p) => {
      if (p.token !== loadTokenRef.current) return // a newer load superseded this
      if (p.ok) {
        setMessages(p.messages || [])
        setTotal(p.total || 0)
        setLoading(false)
      }
    })
    return () => off?.()
  }, [])
  // ---- whole-folder search, streamed in progressively (not just the loaded page) ----
  useEffect(() => {
    const off = api.mail?.onSearchResult?.((p) => {
      if (p.token !== searchTokenRef.current) return // a newer query superseded this
      if (p.messages?.length) setSearchResults((r) => [...r, ...p.messages])
      if (p.done) setSearching(false)
    })
    return () => off?.()
  }, [])
  useEffect(() => {
    const q = search.trim()
    if (!q) {
      setSearchResults([])
      setSearching(false)
      return
    }
    const token = ++searchTokenRef.current // invalidate any in-flight search
    setSearchResults([])
    setSearching(true)
    setOpenMsg(null)
    const id = setTimeout(() => api.mail?.search?.(account, folder, q, token), 400) // debounce
    return () => clearTimeout(id)
  }, [search, account, folder])
  // clicking a folder (even the same one) closes the open message AND the in-app browser
  // overlay → back to that folder's list (the overlay would otherwise stay on top)
  useEffect(() => {
    setOpenMsg(null)
    setInternalUrl(null)
  }, [navKey])
  // unread counts for the category tab badges — refresh on nav and every 60s
  useEffect(() => {
    let alive = true
    const load = () => Promise.resolve(api.mail?.categoryStats?.(account)).then((r) => alive && r?.ok && setTabCounts(r.counts || {}))
    load()
    const id = setInterval(load, 60000)
    return () => { alive = false; clearInterval(id) }
  }, [account, navKey])
  // while a tab is active, treat its current count as "seen" so its badge stays at 0
  // and later only reflects mail that arrived after you opened it
  useEffect(() => {
    if (!showTabs) return
    const cur = tabCounts[tab]
    if (cur == null) return
    const key = `${account}|${tab}`
    setSeen((s) => (s[key] === cur ? s : { ...s, [key]: cur }))
  }, [account, tab, tabCounts, showTabs])

  // width of the list when the reader is split beside it (drag the divider)
  const [rowsW, setRowsW] = useState(() => Math.min(Math.max(Number(localStorage.getItem('mailSplitW')) || 440, 200), 700))
  const rowsWRef = useRef(rowsW)
  rowsWRef.current = rowsW
  const startResize = (e) => {
    e.preventDefault()
    const max = (e.currentTarget.parentElement?.clientWidth || 1200) - 100
    const startX = e.clientX
    const startW = rowsWRef.current
    const onMove = (ev) => setRowsW(Math.min(Math.max(startW + ev.clientX - startX, 100), Math.max(120, max)))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      localStorage.setItem('mailSplitW', String(rowsWRef.current))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // map cached rows → display shape. Dedup by Message-ID first: in the unified
  // ("all") inbox the same email delivered to two accounts has the same id, so it
  // would otherwise show twice (and collide React keys).
  const msgs = useMemo(() => {
    const seen = new Set()
    const mapped = ((inSearch ? searchResults : messages) || [])
      .filter((m) => {
        if (seen.has(m.id)) return false
        seen.add(m.id)
        return true
      })
      .map((m) => ({
        id: m.id,
        account: m.account,
        from: m.from || m.account,
        to: m.to || '', // recipient — known from the list metadata, shown in the reader skeleton
        subject: m.subject || '',
        snippet: m.snippet || '',
        date: fmtDate(m.date),
        ts: m.date || 0,
        unread: (unreadKeys.has(m.threadId || m.id) || !!m.unread) && !readKeys.has(m.threadId || m.id),
        starred: m.id in stars ? !!stars[m.id] : false,
        important: m.id in importantOverride ? !!importantOverride[m.id] : !!m.important,
        category: m.category || 'primary',
        threadId: m.threadId || null,
        repCount: m.count || 1, // thread's message count from the backend (one row per thread)
        attachments: m.attachments
      }))
    // group into conversations by X-GM-THRID: one row per thread, newest message as
    // the representative (rows arrive newest-first), aggregating the thread's state
    const groups = new Map()
    const order = []
    for (const m of mapped) {
      // scope the thread key by account so two accounts' threads (X-GM-THRID is
      // per-account) can never collide and merge in the unified 'all' view. Outside INBOX
      // we don't group at all → key by message id so every message is its own row.
      const key = (m.account || '') + '|' + (groupThreads ? m.threadId || m.id : m.id)
      const g = groups.get(key)
      if (!g) {
        groups.set(key, { ...m, count: m.repCount || 1 })
        order.push(key)
      } else {
        // the thread's size is the backend rep's count — DON'T sum, or the 20s poll adding
        // more of the same thread's messages would inflate it (4 → 5 → 6 …)
        g.count = Math.max(g.count, m.repCount || 1)
        g.unread = g.unread || m.unread
        g.important = g.important || m.important
        g.starred = g.starred || m.starred
        if (m.attachments?.length) g.attachments = [...(g.attachments || []), ...m.attachments]
      }
    }
    return order.map((k) => groups.get(k))
  }, [messages, searchResults, inSearch, stars, importantOverride, readKeys, unreadKeys, groupThreads])

  // once the server confirms a locally-marked-unread thread is really unread, drop the
  // optimistic override (same idea as tombstones expiring after the server syncs a delete)
  useEffect(() => {
    if (!unreadKeys.size) return
    setUnreadKeys((s) => {
      let changed = false
      const n = new Set(s)
      for (const m of [...messages, ...searchResults]) {
        const key = m.threadId || m.id
        if (n.has(key) && m.unread === true) { n.delete(key); changed = true }
      }
      return changed ? n : s
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, searchResults])

  // category filtering happens on the backend (X-GM-RAW); the client only applies
  // the local 'starred' overlay. 'all' and category tabs show everything loaded.
  const inTab = (m, tb) => (tb === 'starred' ? m.starred : true)

  // tab badges show NEW mail since last seen (current count − seen baseline)
  const badges = useMemo(() => {
    const out = {}
    for (const id of Object.keys(tabCounts)) out[id] = Math.max(0, tabCounts[id] - (seen[`${account}|${id}`] ?? 0))
    return out
  }, [tabCounts, seen, account])

  const visible = useMemo(() => {
    // search mode shows server-matched hits across the whole folder (ignore tab/client search)
    let out = inSearch ? msgs : msgs.filter((m) => inTab(m, effTab))
    if (filter === 'unread') out = out.filter((m) => m.unread)
    else if (filter === 'attachments') out = out.filter((m) => m.attachments?.length)
    const q = search.trim().toLowerCase()
    if (q && !inSearch) out = out.filter((m) => (m.subject + ' ' + m.from + ' ' + m.snippet).toLowerCase().includes(q))
    out = [...out].sort((a, b) => b.ts - a.ts) // always newest-first
    return out
  }, [msgs, effTab, filter, search, inSearch])

  // 'starred' tab and search are local/streamed → their count is what's visible here,
  // not the whole-folder server total
  const effTotal = effTab === 'starred' || inSearch ? visible.length : total
  const pageItems = visible // the loaded window (grows via infinite scroll)

  const toggleSelect = (id) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const toggleStar = (id) => setStars((s) => ({ ...s, [id]: !(id in s ? s[id] : false) }))
  // mark/unmark important: optimistic local flag + IMAP STORE ±X-GM-LABELS \Important
  const toggleImportant = (id, acct, next) => {
    setImportantOverride((o) => ({ ...o, [id]: next }))
    api.mail?.setImportant?.(acct, id, next)
  }
  // opening a thread marks it read (server-side in getMailThread); reflect instantly
  const openMessage = (m) => {
    const key = m.threadId || m.id
    setReadKeys((s) => new Set(s).add(key))
    setUnreadKeys((s) => { if (!s.has(key)) return s; const n = new Set(s); n.delete(key); return n })
    setOpenMsg(m)
  }
  // delete a conversation: drop it from the list instantly, move to Trash server-side
  const deleteMessage = async (m) => {
    const key = m.threadId || m.id
    setMessages((ms) => ms.filter((x) => (x.threadId || x.id) !== key))
    if (openMsg && (openMsg.threadId || openMsg.id) === key) setOpenMsg(null)
    await api.mail?.delete?.(m.account, folder, m.threadId, m.id)
    // announce it on the bus → the folder badges (and any other subscriber) react
    emitMailChanged({ type: 'delete', account: m.account, folder, threadId: m.threadId, id: m.id })
  }
  // "mark unread" from the reader: re-flag \Seen off, restore the bold row, close
  const markUnread = async (m) => {
    const key = m.threadId || m.id
    setReadKeys((s) => { const n = new Set(s); n.delete(key); return n })
    setUnreadKeys((s) => new Set(s).add(key)) // optimistic: show unread now, until the server confirms
    setOpenMsg(null)
    await api.mail?.setSeen?.(m.account, m.threadId, m.id, false)
    emitMailChanged({ type: 'seen', account: m.account, folder, threadId: m.threadId, id: m.id, seen: false })
  }

  // bulk actions on the checkbox-selected rows (always the CURRENT view's loaded page,
  // so they never touch messages in another tab/folder)
  const selectedMsgs = () => {
    const byId = new Map(pageItems.map((m) => [m.id, m]))
    return [...selected].map((id) => byId.get(id)).filter(Boolean)
  }
  // bulk via ONE backend call per action (not 50 separate IMAP connections, which Gmail
  // rejects). Wait for the server, then reload the list AND refresh the tree counts.
  const itemsOf = (ms) => ms.map((m) => ({ account: m.account, threadId: m.threadId, id: m.id }))
  const markSelectedRead = async () => {
    const ms = selectedMsgs()
    const keys = ms.map((m) => m.threadId || m.id)
    setReadKeys((s) => { const n = new Set(s); keys.forEach((k) => n.add(k)); return n })
    setUnreadKeys((s) => { const n = new Set(s); keys.forEach((k) => n.delete(k)); return n })
    setSelected(new Set())
    await api.mail?.bulkSeen?.(folder, itemsOf(ms), true)
    if (!inSearch) reload(true)
    emitMailChanged({ type: 'stats', folder }) // bulk already updated the list; just refresh the badges
  }
  const markSelectedUnread = async () => {
    const ms = selectedMsgs()
    const keys = ms.map((m) => m.threadId || m.id)
    // optimistic: show them unread immediately, and keep that until the server confirms
    setUnreadKeys((s) => { const n = new Set(s); keys.forEach((k) => n.add(k)); return n })
    setReadKeys((s) => { const n = new Set(s); keys.forEach((k) => n.delete(k)); return n })
    setSelected(new Set())
    await api.mail?.bulkSeen?.(folder, itemsOf(ms), false)
    if (!inSearch) reload(true)
    emitMailChanged({ type: 'stats', folder }) // bulk already updated the list; just refresh the badges
  }
  const deleteSelected = async () => {
    const ms = selectedMsgs()
    const keys = new Set(ms.map((m) => m.threadId || m.id))
    const drop = (list) => list.filter((x) => !keys.has(x.threadId || x.id))
    setMessages(drop)
    setSearchResults(drop)
    if (openMsg && keys.has(openMsg.threadId || openMsg.id)) setOpenMsg(null)
    setSelected(new Set())
    await api.mail?.bulkDelete?.(folder, itemsOf(ms))
    emitMailChanged({ type: 'stats', folder }) // refresh the folder badges
    // silently re-fetch the current window — the deleted rows drop out and the server tops it
    // back up toward the loaded count (no pages to jump between any more)
    if (!inSearch) reload(true)
  }
  const allChecked = pageItems.length > 0 && pageItems.every((m) => selected.has(m.id))
  const someChecked = pageItems.some((m) => selected.has(m.id))
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s)
      if (allChecked) pageItems.forEach((m) => n.delete(m.id))
      else pageItems.forEach((m) => n.add(m.id))
      return n
    })

  // infinite scroll: show how many of the total are loaded
  const rangeLabel = inSearch
    ? `${effTotal.toLocaleString()}`
    : `${pageItems.length.toLocaleString()} / ${effTotal.toLocaleString()}`
  const head = (
    <MailListHead
      rangeLabel={rangeLabel}
      paneMode={paneMode}
      onTogglePane={() => setPaneMode((m) => (m === 'split' ? 'full' : 'split'))}
    />
  )

  // in-app browser + link menu — rendered in both pane modes; the browser overlays
  // the whole mail area, its top bar replacing the head/pagination strip
  const browser = (
    <>
      {linkMenu && (
        <ContextMenu
          x={linkMenu.x}
          y={linkMenu.y}
          items={[
            { label: t('mail.openInternal'), onClick: () => { openInternal(linkMenu.url, linkMenu.lang); setLinkMenu(null) } },
            { label: t('mail.openExternal'), onClick: () => { api.openExternal?.(linkMenu.url); setLinkMenu(null) } }
          ]}
          onClose={() => setLinkMenu(null)}
        />
      )}
      {internalUrl && <MailWebView key={internalUrl} url={internalUrl} initialLang={internalLang} onClose={() => setInternalUrl(null)} />}
    </>
  )

  if (paneMode === 'full' && openMsg) {
    return (
      <div className="mail-list">
        {head}
        <MailReader msg={openMsg} folder={folder} onBack={() => setOpenMsg(null)} onMarkUnread={markUnread} onDelete={deleteMessage} stars={stars} onToggleStar={toggleStar} onOpenInternal={openInternal} onLinkMenu={setLinkMenu} />
        {browser}
      </div>
    )
  }

  return (
    <div className="mail-list">
      {head}
      {showTabs && !inSearch && <MailTabs active={tab} counts={badges} onSelect={setTab} />}
      <MailToolbar
        allChecked={allChecked}
        someChecked={someChecked}
        onToggleAll={toggleAll}
        selectedCount={selected.size}
        onRefresh={refresh}
        busy={loading || searching}
        filter={filter}
        onFilter={setFilter}
        search={search}
        onSearch={setSearch}
      />
      {selected.size > 0 && (
        <div className="mail-bulkbar">
          <span className="mail-bulkbar__count">{selected.size} {t('mail.selected')}</span>
          <button className="mail-bulkbar__btn" onClick={markSelectedRead}>
            <MailIcon /> {t('mail.markRead')}
          </button>
          <button className="mail-bulkbar__btn" onClick={markSelectedUnread}>
            <MailIcon /> {t('mail.markUnread')}
          </button>
          <button className="mail-bulkbar__btn" onClick={deleteSelected}>
            <TrashIcon /> {t('mail.delete')}
          </button>
          <button className="mail-bulkbar__btn mail-bulkbar__btn--x" onClick={() => setSelected(new Set())} title={t('mail.close')}>
            ✕
          </button>
        </div>
      )}
      <div className="mail-list__split">
        <div className="mail-list__listcol" style={paneMode === 'split' ? { flex: `0 1 ${rowsW}px` } : undefined}>
          <div className="mail-list__rows" ref={rowsRef} onScroll={onRowsScroll}>
            {pageItems.map((m) => (
              <MailRow
                key={m.id}
                msg={m}
                query={inSearch ? search.trim() : ''}
                selected={selected.has(m.id)}
                showAccount={showAccount}
                showRecipient={showRecipient}
                onToggleSelect={toggleSelect}
                onToggleStar={toggleStar}
                onToggleImportant={toggleImportant}
                onDelete={deleteMessage}
                onOpen={openMessage}
              />
            ))}
            {pageItems.length === 0 &&
              (loading || searching ? (
                <div className="mail-list__loading">
                  <span className="mail-spinner" />
                  <span className="mail-list__loading-text">{searching ? t('mail.searching') : t('mail.loading')}</span>
                </div>
              ) : (
                <div className="mail-list__empty">{inSearch ? t('mail.noResults') : t('mail.empty')}</div>
              ))}
            {inSearch && searching && pageItems.length > 0 && (
              <div className="mail-list__loading">
                <span className="mail-spinner mail-spinner--sm" />
                <span className="mail-list__loading-text">{t('mail.searching')}</span>
              </div>
            )}
            {/* infinite scroll: spinner while the next window loads in */}
            {loadingMore && (
              <div className="mail-list__loading mail-list__loading--more">
                <span className="mail-spinner mail-spinner--sm" />
                <span className="mail-list__loading-text">{t('mail.loadingMore')}</span>
              </div>
            )}
          </div>
        </div>
        {paneMode === 'split' && (
          <>
            <div className="mail-list__divider" onMouseDown={startResize} title={t('mail.resize')} />
            <div className="mail-list__reader">
              <MailReader msg={openMsg} folder={folder} split onBack={() => setOpenMsg(null)} onMarkUnread={markUnread} onDelete={deleteMessage} stars={stars} onToggleStar={toggleStar} onOpenInternal={openInternal} onLinkMenu={setLinkMenu} />
            </div>
          </>
        )}
      </div>
      {browser}
    </div>
  )
}
