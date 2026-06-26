import { useEffect, useRef, useState } from 'react'
import api from '../lib/api'
import {
  InboxIcon, SentIcon, TrashIcon, SpamIcon, DraftIcon, StarIcon, ArchiveIcon, LabelIcon,
  ChevronLeftIcon, ChevronRightIcon, GmailIcon, ComposeIcon
} from '../components/icons'
import MailList from '../components/mail/MailList'
import MailCompose from '../components/mail/MailCompose'
import ContextMenu from '../components/ContextMenu'
import { useI18n } from '../i18n/I18nContext'
import { monogram } from '../lib/monogram'
import { emitMailChanged, onMailChanged } from '../lib/mailBus'
import './MailView.css'

// the three folders shown at the top level; everything else folds into "More"
const MAIN_ORDER = ['\\Inbox', '\\Sent', '\\Trash']
const ICON = {
  '\\Inbox': InboxIcon, '\\Sent': SentIcon, '\\Trash': TrashIcon, '\\Junk': SpamIcon,
  '\\Drafts': DraftIcon, '\\Flagged': StarIcon, '\\Important': StarIcon, '\\All': ArchiveIcon, '\\Archive': ArchiveIcon
}
const LABEL_KEY = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Trash': 'trash', '\\Junk': 'spam', '\\Drafts': 'drafts',
  '\\Flagged': 'starred', '\\Important': 'important', '\\All': 'allMail', '\\Archive': 'archive'
}
const iconFor = (f) => ICON[f.specialUse] || LabelIcon
const accLabel = (acc) => (acc.name && acc.name !== acc.email ? acc.name : acc.email)
const accName = (acc) => (acc.name && acc.name !== acc.email ? acc.name : acc.email.split('@')[0])
const isGmail = (email) => /@gmail\.com$/i.test(email || '')

// shown instantly for every account (no "loading…" flicker); the real IMAP list
// replaces it once fetched — the standard folders look identical, so nothing jumps
const DEFAULT_FOLDERS = {
  main: [
    { path: 'INBOX', specialUse: '\\Inbox' },
    { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
    { path: '[Gmail]/Trash', specialUse: '\\Trash' }
  ],
  extras: [
    { path: '[Gmail]/Spam', specialUse: '\\Junk' },
    { path: '[Gmail]/All Mail', specialUse: '\\All' },
    { path: '[Gmail]/Drafts', specialUse: '\\Drafts' }
  ]
}

export default function MailView({ active, onOpenSettings }) {
  const { t } = useI18n()
  const [accounts, setAccounts] = useState([])
  const [folders, setFolders] = useState({}) // email -> { loading, main:[], extras:[], error }
  const [menu, setMenu] = useState(null) // { x, y, email } for the account right-click menu
  const [folderMenu, setFolderMenu] = useState(null) // { x, y, account, folder } folder right-click
  const [markProg, setMarkProg] = useState({}) // "account|folder" -> { done, total, running }
  const [navKey, setNavKey] = useState(0) // bumped on every folder click → list closes the open message
  const [composing, setComposing] = useState(false) // the "New email" compose overlay
  const [sending, setSending] = useState(0) // emails currently being sent in the background
  // background send queue: hand a message to SMTP, track in-flight count for the button badge
  const queueSend = async (payload) => {
    setSending((n) => n + 1)
    try {
      const r = await api.mail?.send?.(payload)
      if (!r?.ok) api.notify?.('⚠ ' + (r?.error || 'send failed'))
    } finally {
      setSending((n) => Math.max(0, n - 1))
    }
  }
  const [stats, setStats] = useState({}) // email -> { path: { total, unread } } from IMAP STATUS
  // restore the last-selected mailbox + folder
  const [sel, setSel] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('mailSel')) || { account: 'all', folder: 'INBOX' }
    } catch {
      return { account: 'all', folder: 'INBOX' }
    }
  })
  useEffect(() => localStorage.setItem('mailSel', JSON.stringify(sel)), [sel])
  const [openMore, setOpenMore] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('mailMore')) || {}
    } catch {
      return {}
    }
  }) // email -> bool (which "More" nodes are expanded)
  useEffect(() => localStorage.setItem('mailMore', JSON.stringify(openMore)), [openMore])
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('mailCollapsed') === '1')
  const [width, setWidth] = useState(() => Math.min(Math.max(Number(localStorage.getItem('mailW')) || 230, 100), 400))
  const widthRef = useRef(width)
  widthRef.current = width

  const labelFor = (f) => (LABEL_KEY[f.specialUse] ? t('mail.folder.' + LABEL_KEY[f.specialUse]) : f.name)

  const loadAccounts = () => Promise.resolve(api.mail?.listAccounts?.()).then((a) => setAccounts(a || []))
  useEffect(() => {
    loadAccounts()
  }, [])
  useEffect(() => {
    if (active) loadAccounts()
  }, [active])

  // fetch each account's real folder list once (IMAP LIST)
  useEffect(() => {
    if (!active) return
    for (const acc of accounts) {
      if (folders[acc.email]) continue
      // mark in-flight but KEEP the default folders visible (no flicker)
      setFolders((p) => ({ ...p, [acc.email]: { ...DEFAULT_FOLDERS, pending: true } }))
      Promise.resolve(api.mail?.folders?.(acc.email)).then((r) => {
        if (!r?.ok) return setFolders((p) => ({ ...p, [acc.email]: { ...DEFAULT_FOLDERS, error: r?.error } }))
        const main = [], extras = []
        for (const f of r.folders) (MAIN_ORDER.includes(f.specialUse) ? main : extras).push(f)
        main.sort((a, b) => MAIN_ORDER.indexOf(a.specialUse) - MAIN_ORDER.indexOf(b.specialUse))
        setFolders((p) => ({ ...p, [acc.email]: { main, extras } }))
      })
    }
  }, [active, accounts]) // eslint-disable-line react-hooks/exhaustive-deps

  // cheap per-folder unread counts (IMAP STATUS, no FETCH) for the tree "(N)" badges
  const loadStats = () => {
    for (const acc of accounts) {
      const data = folders[acc.email] || DEFAULT_FOLDERS
      const paths = [...(data.main || []), ...(data.extras || [])].map((f) => f.path)
      if (!paths.length) continue
      Promise.resolve(api.mail?.folderStats?.(acc.email, paths)).then((r) => {
        if (r?.ok) setStats((p) => ({ ...p, [acc.email]: r.stats }))
      })
    }
  }
  const loadStatsRef = useRef(loadStats)
  loadStatsRef.current = loadStats
  useEffect(() => {
    if (active) loadStats()
  }, [active, accounts, folders]) // eslint-disable-line react-hooks/exhaustive-deps
  // keep EVERY account's unread badge fresh in the background (cheap IMAP STATUS, all
  // accounts), not just the one you're viewing — so new mail in another mailbox shows up
  // in the tree on its own, without having to open that account first
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => loadStatsRef.current(), 30000)
    return () => clearInterval(id)
  }, [active])

  // the folder badges subscribe to the mail bus: ANY mutation (a delete/mark/empty from
  // the list, the AI, or a folder menu) re-pulls the unread/total counts. This is the
  // event-driven path — the badge reacts on its own, no caller has to remember to refresh it.
  // Debounced so a burst of events (e.g. the AI marking several messages) coalesces into one
  // STATUS pull instead of hammering IMAP.
  useEffect(() => {
    let t
    const off = onMailChanged(() => {
      clearTimeout(t)
      t = setTimeout(() => loadStatsRef.current(), 400)
    })
    return () => { clearTimeout(t); off() }
  }, [])

  // live progress of a "mark folder read" run; refresh the (N) badges when it finishes
  useEffect(() => {
    const off = api.mail?.onMarkProgress?.((p) => {
      const key = p.account + '|' + p.folder
      setMarkProg((m) => ({ ...m, [key]: p }))
      if (!p.running) {
        loadStatsRef.current()
        setTimeout(() => setMarkProg((m) => { const n = { ...m }; delete n[key]; return n }), 1500)
      }
    })
    return () => off?.()
  }, [])

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      localStorage.setItem('mailCollapsed', c ? '0' : '1')
      return !c
    })
  }

  // drag the right edge to resize the panel
  const startResize = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    const onMove = (ev) => setWidth(Math.min(Math.max(startW + ev.clientX - startX, 100), 420))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      localStorage.setItem('mailW', String(widthRef.current))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const openMenu = (e, email) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, email })
  }

  const isActive = (account, folder) => sel.account === account && sel.folder === folder
  // unread for the "(N)" badge — unified rows sum every account's matching folder
  const ALIAS = { INBOX: 'INBOX', SENT: '[Gmail]/Sent Mail', TRASH: '[Gmail]/Trash' }
  const unreadFor = (account, folder) => {
    const path = ALIAS[folder] || folder
    if (account === 'all') return accounts.reduce((s, a) => s + (stats[a.email]?.[path]?.unread || 0), 0)
    return stats[account]?.[path]?.unread || 0
  }
  // is the selected folder a Sent box? (the list shows the RECIPIENT there, not the sender).
  // Prefer the flag we stored on click (reliable); fall back to a folder-list lookup for a
  // selection restored from a previous session (which predates the flag).
  const isSentFolder = (account, folder) => {
    if (sel.sent) return true
    if (folder === 'SENT') return true // unified "All sent"
    const data = folders[account]
    return !!data && [...(data.main || []), ...(data.extras || [])].some((f) => f.path === folder && f.specialUse === '\\Sent')
  }
  const Row = ({ account, folder, label, Icon, trash = false, spam = false, sent = false }) => {
    const count = unreadFor(account, folder)
    const prog = markProg[account + '|' + folder]
    const pct = prog?.total ? Math.round((prog.done / prog.total) * 100) : 0
    return (
      <button
        className={'mail-tree__row' + (isActive(account, folder) ? ' mail-tree__row--active' : '')}
        title={collapsed ? label : undefined}
        onClick={() => {
          // remember whether this is a Sent box (by its special-use), so the list reliably
          // shows the RECIPIENT — no fragile re-lookup of the folder list
          setSel({ account, folder, sent })
          setNavKey((k) => k + 1) // clicking a folder (even the same one) returns to the list
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setFolderMenu({ x: e.clientX, y: e.clientY, account, folder, trash, spam })
        }}
      >
        <Icon />
        {!collapsed && <span className="mail-tree__label">{label}</span>}
        {!collapsed &&
          (prog?.running ? (
            <span className="mail-tree__count mail-tree__marking">
              <span className="mail-spinner mail-spinner--sm" /> {pct}%
            </span>
          ) : count > 0 ? (
            <span className="mail-tree__count">({count})</span>
          ) : null)}
      </button>
    )
  }

  return (
    <div className={'mail' + (collapsed ? ' mail--rail' : '')}>
      <aside className="mail__tree" style={{ width: collapsed ? 56 : width }}>
        <div className="mail__tree-head">
          <button className="mail__collapse" title={collapsed ? t('mail.expand') : t('mail.collapse')} onClick={toggleCollapsed}>
            {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          </button>
        </div>

        <div className="mail__tree-body">
          {/* unified folders across all accounts */}
          <div className="mail-tree__group">
            {!collapsed && <div className="mail-tree__group-title">{t('mail.unified')}</div>}
            <Row account="all" folder="INBOX" label={t('mail.allInboxes')} Icon={InboxIcon} />
            <Row account="all" folder="SENT" label={t('mail.allSent')} Icon={SentIcon} sent />
          </div>

          {accounts.map((acc) => {
            const data = folders[acc.email] || DEFAULT_FOLDERS
            return (
              <div className="mail-tree__group" key={acc.email}>
                {collapsed ? (
                  <div className="mail-tree__mono" title={acc.email} onContextMenu={(e) => openMenu(e, acc.email)}>
                    {monogram(accLabel(acc))}
                  </div>
                ) : (
                  <div className="mail-tree__group-title" title={acc.email} onContextMenu={(e) => openMenu(e, acc.email)}>
                    <span className="mail-tree__acct">{isGmail(acc.email) ? accName(acc) + '@' : accLabel(acc)}</span>
                    {isGmail(acc.email) && <GmailIcon />}
                  </div>
                )}

                {data.error && !collapsed && <div className="mail-tree__hint">⚠ {data.error}</div>}

                {data.main.map((f) => (
                  <Row key={f.path} account={acc.email} folder={f.path} label={labelFor(f)} Icon={iconFor(f)} trash={f.specialUse === '\\Trash'} spam={f.specialUse === '\\Junk'} sent={f.specialUse === '\\Sent'} />
                ))}

                {!collapsed && data.extras.length > 0 && (
                  <>
                    <button className="mail-tree__more" onClick={() => setOpenMore((p) => ({ ...p, [acc.email]: !p[acc.email] }))}>
                      {openMore[acc.email] ? '▾' : '▸'} {t('mail.more')} ({data.extras.length})
                    </button>
                    {openMore[acc.email] &&
                      data.extras.map((f) => (
                        <Row key={f.path} account={acc.email} folder={f.path} label={labelFor(f)} Icon={iconFor(f)} trash={f.specialUse === '\\Trash'} spam={f.specialUse === '\\Junk'} sent={f.specialUse === '\\Sent'} />
                      ))}
                  </>
                )}
              </div>
            )
          })}

          {accounts.length === 0 && !collapsed && <div className="mail-tree__hint">{t('mail.noMailboxes')}</div>}
        </div>

        {/* pinned to the very bottom of the tree; collapses to just the icon in rail mode */}
        <button
          className="mail__compose"
          title={sending > 0 ? t('mail.sending') + ' (' + sending + ')' : t('mail.newEmail')}
          disabled={!accounts.length || composing}
          onClick={() => setComposing(true)}
        >
          <ComposeIcon />
          {!collapsed && <span>{t('mail.newEmail')}</span>}
          {sending > 0 && (
            <span className="mail__compose-badge">
              <span className="mail-spinner mail-spinner--sm mail-spinner--white" />
              <span className="mail__compose-num">{sending}</span>
            </span>
          )}
        </button>

        {!collapsed && <div className="mail__resize" onMouseDown={startResize} title={t('mail.resize')} />}
      </aside>

      <main className="mail__center">
        <MailList account={sel.account} folder={sel.folder} navKey={navKey} showRecipient={isSentFolder(sel.account, sel.folder)} />
        {composing && (
          <MailCompose
            accounts={accounts}
            defaultFrom={sel.account !== 'all' ? sel.account : accounts[0]?.email}
            onSend={queueSend}
            onClose={() => setComposing(false)}
          />
        )}
      </main>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: t('mail.copyEmail'), onClick: () => api.writeClipboard?.(menu.email) },
            { label: t('mail.addMailbox'), onClick: () => onOpenSettings?.() }
          ]}
          onClose={() => setMenu(null)}
        />
      )}

      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={[
            {
              label: t('mail.markAllRead'),
              onClick: async () => {
                await api.mail?.markFolderRead?.(folderMenu.account, folderMenu.folder)
                emitMailChanged({ type: 'reload', account: folderMenu.account, folder: folderMenu.folder }) // refresh the open list's read state
              }
            },
            // move all already-read messages to Trash (in Trash itself → permanent)
            {
              label: t('mail.deleteRead'),
              onClick: async () => {
                if (!window.confirm(t('mail.deleteReadConfirm'))) return
                await api.mail?.deleteRead?.(folderMenu.account, folderMenu.folder)
                loadStatsRef.current()
                emitMailChanged({ type: 'reload', account: folderMenu.account, folder: folderMenu.folder }) // reload the open list without the removed messages
              }
            },
            // permanent "empty Trash" — only for the Trash folder, with a confirm
            ...(folderMenu.trash
              ? [
                  {
                    label: t('mail.emptyTrash'),
                    onClick: async () => {
                      if (!window.confirm(t('mail.emptyTrashConfirm'))) return
                      await api.mail?.emptyFolder?.(folderMenu.account, folderMenu.folder)
                      loadStatsRef.current()
                      emitMailChanged({ type: 'reload', account: folderMenu.account, folder: folderMenu.folder }) // reload the (now empty) list if Trash is open
                    }
                  }
                ]
              : []),
            // permanent "delete all spam" — only for the Spam/Junk folder, with a confirm
            ...(folderMenu.spam
              ? [
                  {
                    label: t('mail.emptySpam'),
                    onClick: async () => {
                      if (!window.confirm(t('mail.emptySpamConfirm'))) return
                      await api.mail?.emptyFolder?.(folderMenu.account, folderMenu.folder)
                      loadStatsRef.current()
                      emitMailChanged({ type: 'reload', account: folderMenu.account, folder: folderMenu.folder }) // reload the (now empty) list if Spam is open
                    }
                  }
                ]
              : [])
          ]}
          onClose={() => setFolderMenu(null)}
        />
      )}
    </div>
  )
}
