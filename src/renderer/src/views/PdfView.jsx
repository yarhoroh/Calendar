import { useEffect, useRef, useState } from 'react'
import api from '../lib/api'
import ContextMenu from '../components/ContextMenu'
import PdfEditorTab from '../components/pdf/PdfEditorTab'
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon, PdfIcon } from '../components/icons'
import { useI18n } from '../i18n/I18nContext'
import './PdfView.css'

const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : 'n' + Math.random().toString(36).slice(2))
const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()
const keyOf = (node) => node.id || 'disk:' + node.path

// tiny inline icons (kept local so the tree owns its look)
const Caret = ({ open }) => (
  <svg className={'pdf-caret' + (open ? ' is-open' : '')} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
)
const FolderGlyph = ({ link }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    {link && <path d="M10 13a2 2 0 0 0 2 2h1M14 13a2 2 0 0 0-2-2h-1" />}
  </svg>
)

// A virtual node is { id, type:'folder'|'linkFolder'|'linkFile', name, path?, mode?, children? }.
// A scanned disk node is { type:'diskFolder'|'diskFile', name, path } (not persisted).
export default function PdfView() {
  const { t } = useI18n()
  const [tree, setTree] = useState({ roots: [] })
  const [expanded, setExpanded] = useState(() => new Set())
  const [scan, setScan] = useState({}) // "path|mode" → { folders?, files }
  const [tabs, setTabs] = useState([]) // open PDFs — one per tab (paths)
  const [activePath, setActivePath] = useState(null) // the focused tab
  const tabsRef = useRef(null) // the scrollable tab strip
  const [scroll, setScroll] = useState({ left: false, right: false }) // strip overflows → show ‹ ›
  const dragTab = useRef(null) // path being Ctrl-dragged to reorder
  const treeBodyRef = useRef(null) // scroll container of the tree (to reveal a file)
  const [menu, setMenu] = useState(null) // { x, y, node, parentId }
  const [editing, setEditing] = useState(null) // { id, name }
  const [query, setQuery] = useState('') // filters the tree by name
  const [info, setInfo] = useState({}) // path → { size, mtime } loaded lazily on hover / select
  const saveTimer = useRef(null)
  // resizable / collapsible panel, like the mail tree
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('pdfCollapsed') === '1')
  const [width, setWidth] = useState(() => Math.min(Math.max(Number(localStorage.getItem('pdfW')) || 260, 140), 460))
  const widthRef = useRef(width)
  widthRef.current = width
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem('pdfCollapsed', c ? '0' : '1')
      return !c
    })
  const startResize = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    const onMove = (ev) => setWidth(Math.min(Math.max(startW + ev.clientX - startX, 140), 460))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      localStorage.setItem('pdfW', String(widthRef.current))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    Promise.resolve(api.pdf?.getTree?.()).then((tr) => tr?.roots && setTree(tr))
  }, [])
  // watch linked real folders (recursively) so a file added/removed in Explorer reflects at once
  useEffect(() => {
    const collect = (nodes, out = []) => {
      for (const n of nodes) {
        if (n.type === 'linkFolder' && n.path) out.push(n.path)
        if (n.children) collect(n.children, out)
      }
      return out
    }
    api.pdf?.watch?.(collect(tree.roots))
  }, [tree])
  useEffect(() => api.pdf?.onTreeChanged?.(() => setScan({})), []) // a watched folder changed → drop scan cache, expanded folders re-scan
  const commit = (next) => {
    setTree(next)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => api.pdf?.setTree?.(next), 400)
  }

  // immutable tree transform: fn(node) → node | null(remove) | undefined(keep)
  const transform = (nodes, fn) => {
    const out = []
    for (const n of nodes) {
      const r = fn(n)
      if (r === null) continue
      const node = r === undefined ? n : r
      out.push(node.children ? { ...node, children: transform(node.children, fn) } : node)
    }
    return out
  }
  const updateNode = (id, patch) => commit({ roots: transform(tree.roots, (n) => (n.id === id ? { ...n, ...patch } : undefined)) })
  const removeNode = (id) => commit({ roots: transform(tree.roots, (n) => (n.id === id ? null : undefined)) })
  const addChild = (parentId, child) => {
    if (!parentId) return commit({ roots: [...tree.roots, child] })
    commit({ roots: transform(tree.roots, (n) => (n.id === parentId ? { ...n, children: [...(n.children || []), child] } : undefined)) })
    setExpanded((e) => new Set(e).add(parentId))
  }

  // ---- drag & drop: move a virtual node into a folder, or to the root ----
  const dragRef = useRef(null)
  const [dropId, setDropId] = useState(null)
  const findNode = (nodes, id) => {
    for (const n of nodes) {
      if (n.id === id) return n
      if (n.children) {
        const f = findNode(n.children, id)
        if (f) return f
      }
    }
    return null
  }
  const isInside = (node, id) => !!node?.children?.some((c) => c.id === id || isInside(c, id))
  const extract = (nodes, id) => {
    const out = []
    let got = null
    for (const n of nodes) {
      if (n.id === id) {
        got = n
        continue
      }
      if (n.children) {
        const [g, kids] = extract(n.children, id)
        if (g) got = g
        out.push({ ...n, children: kids })
      } else out.push(n)
    }
    return [got, out]
  }
  const insertInto = (nodes, parentId, child) =>
    nodes.map((n) => {
      if (n.id === parentId) return { ...n, children: [...(n.children || []), child] }
      return n.children ? { ...n, children: insertInto(n.children, parentId, child) } : n
    })
  const moveNode = (id, targetId) => {
    if (!id || id === targetId) return
    const dragged = findNode(tree.roots, id)
    if (!dragged) return
    if (targetId && isInside(dragged, targetId)) return // can't drop a folder into its own descendant
    const [node, rest] = extract(tree.roots, id)
    if (!node) return
    commit({ roots: targetId ? insertInto(rest, targetId, node) : [...rest, node] })
    if (targetId) setExpanded((e) => new Set(e).add(targetId))
  }

  // OS drag-and-drop: folders/PDFs dragged from the file manager become links (folder → tree,
  // PDF → file). targetId = a virtual folder to drop into, or null for the root.
  const addExternal = async (fileList, targetId) => {
    const paths = [...(fileList || [])].map((f) => api.pathForFile?.(f)).filter(Boolean)
    const nodes = []
    for (const p of paths) {
      const st = await api.pdf?.stat?.(p)
      if (st?.isDir) nodes.push({ id: uid(), type: 'linkFolder', name: baseName(p), path: p, mode: 'tree' })
      else if (st?.isPdf) nodes.push({ id: uid(), type: 'linkFile', name: baseName(p), path: p })
    }
    if (!nodes.length) return
    let roots = tree.roots
    for (const n of nodes) roots = targetId ? insertInto(roots, targetId, n) : [...roots, n]
    commit({ roots })
    if (targetId) setExpanded((e) => new Set(e).add(targetId))
  }

  // ---- actions ----
  const newFolder = (parentId) => {
    const id = uid()
    addChild(parentId, { id, type: 'folder', name: t('pdf.newFolder'), children: [] })
    setEditing({ id, name: t('pdf.newFolder') }) // open inline rename right away
  }
  const linkFolder = async (parentId) => {
    const p = await api.pdf?.pickFolder?.()
    if (p) addChild(parentId, { id: uid(), type: 'linkFolder', name: baseName(p), path: p, mode: 'tree' })
  }
  const linkFile = async (parentId) => {
    const paths = (await api.pdf?.pickFile?.()) || []
    for (const p of paths) addChild(parentId, { id: uid(), type: 'linkFile', name: baseName(p), path: p })
  }

  // ---- expand + scan ----
  const cacheKey = (node) => node.path + '|' + (node.type === 'linkFolder' ? node.mode || 'tree' : 'tree')
  const doScan = (node) => {
    const ck = cacheKey(node)
    if (scan[ck]) return
    const mode = node.type === 'linkFolder' ? node.mode || 'tree' : 'tree'
    Promise.resolve(api.pdf?.scan?.(node.path, mode)).then((r) => r && setScan((s) => ({ ...s, [ck]: r })))
  }
  const toggle = (node) => {
    const k = keyOf(node)
    setExpanded((e) => {
      const next = new Set(e)
      if (next.has(k)) next.delete(k)
      else {
        next.add(k)
        if (node.type === 'linkFolder' || node.type === 'diskFolder') doScan(node)
      }
      return next
    })
  }
  const setMode = (node, mode) => {
    updateNode(node.id, { mode })
    doScan({ ...node, mode })
    setExpanded((e) => new Set(e).add(keyOf(node)))
  }

  const childrenOf = (node) => {
    if (node.type === 'folder') return node.children || []
    const s = scan[cacheKey(node)]
    if (!s) return null // loading
    const mode = node.type === 'linkFolder' ? node.mode || 'tree' : 'tree'
    const folders = mode === 'flat' ? [] : (s.folders || []).filter((f) => f?.name).map((f) => ({ type: 'diskFolder', name: f.name, path: f.path }))
    const files = (s.files || []).filter((f) => f?.name).map((f) => ({ type: 'diskFile', name: f.name, path: f.path }))
    return [...folders, ...files]
  }

  const isFolder = (n) => n.type === 'folder' || n.type === 'linkFolder' || n.type === 'diskFolder'
  const isFile = (n) => n.type === 'diskFile' || n.type === 'linkFile'
  const loadInfo = (path) => {
    if (!path || info[path]) return
    Promise.resolve(api.pdf?.stat?.(path)).then((st) => st && setInfo((m) => ({ ...m, [path]: st })))
  }
  // each PDF opens in its own tab; re-selecting an already-open PDF just focuses its tab
  const openTab = (path) => {
    if (!path) return
    setTabs((ts) => (ts.includes(path) ? ts : [...ts, path]))
    setActivePath(path)
    loadInfo(path)
  }
  const closeTab = (path) => {
    const i = tabs.indexOf(path)
    const next = tabs.filter((p) => p !== path)
    setTabs(next)
    if (activePath === path) setActivePath(next.length ? next[Math.min(i, next.length - 1)] : null)
  }
  const addTab = async () => {
    const paths = (await api.pdf?.pickFile?.()) || [] // canceled → nothing opens
    if (!paths.length) return
    setTabs((ts) => [...ts, ...paths.filter((p) => !ts.includes(p))])
    setActivePath(paths[paths.length - 1])
    paths.forEach(loadInfo)
  }
  const selectFile = (node) => openTab(node.path)

  // ---- reveal a file in the tree: expand every folder on its path (scanning as needed) + scroll to it ----
  const pathStartsWith = (target, base) => {
    const b = String(base).replace(/[\\/]+$/, '')
    return target.startsWith(b + '\\') || target.startsWith(b + '/')
  }
  const walkReal = async (folderPath, mode, targetPath, keys) => {
    const s = await api.pdf?.scan?.(folderPath, mode)
    if (!s) return false
    const ck = folderPath + '|' + mode
    setScan((prev) => (prev[ck] ? prev : { ...prev, [ck]: s })) // cache so the branch renders
    if ((s.files || []).some((f) => f.path === targetPath)) return true
    if (mode === 'flat') return false
    for (const sub of s.folders || []) {
      if (pathStartsWith(targetPath, sub.path) && (await walkReal(sub.path, 'tree', targetPath, keys))) {
        keys.push('disk:' + sub.path)
        return true
      }
    }
    return false
  }
  const walkVirtual = async (nodes, targetPath, keys) => {
    for (const n of nodes) {
      if (n.type === 'linkFile' && n.path === targetPath) return true
      if (n.type === 'folder') {
        if (await walkVirtual(n.children || [], targetPath, keys)) {
          keys.push(n.id)
          return true
        }
      } else if (n.type === 'linkFolder' && pathStartsWith(targetPath, n.path)) {
        if (await walkReal(n.path, n.mode || 'tree', targetPath, keys)) {
          keys.push(n.id)
          return true
        }
      }
    }
    return false
  }
  // Scroll ONLY the tree body — never ancestor scrollers (which made the whole panel jump to the
  // top) — so the selected row centres in view. Keeps correcting for a few frames while the branch
  // finishes rendering, since folder scans land asynchronously and grow the tree above the row.
  const scrollSelectedIntoView = () => {
    let frames = 0
    const step = () => {
      const box = treeBodyRef.current
      const row = box?.querySelector('.pdf-row.is-selected')
      if (box && row) {
        const br = box.getBoundingClientRect()
        const rr = row.getBoundingClientRect()
        if (rr.top < br.top || rr.bottom > br.bottom) box.scrollTop += rr.top - br.top - (box.clientHeight - rr.height) / 2 // only when clipped
      }
      if (frames++ < 12) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
  const revealInTree = async (targetPath) => {
    if (!targetPath) return
    const keys = []
    if (!(await walkVirtual(tree.roots, targetPath, keys))) return // not in the tree (e.g. since unlinked)
    setActivePath(targetPath)
    setExpanded((e) => new Set([...e, ...keys]))
    scrollSelectedIntoView()
  }

  // activating a tab reveals its PDF in the tree: expand the branches on its path and scroll to it
  useEffect(() => {
    if (activePath) revealInTree(activePath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath])

  // ---- tab strip: scroll arrows when it overflows + Ctrl-drag to reorder ----
  const updateScroll = () => {
    const el = tabsRef.current
    const left = !!el && el.scrollLeft > 1
    const right = !!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setScroll((s) => (s.left === left && s.right === right ? s : { left, right })) // no-op if unchanged → breaks the RO loop
  }
  const scrollTabs = (dir) => {
    const el = tabsRef.current
    if (!el) return
    const start = el.scrollLeft
    const delta = dir * Math.max(120, el.clientWidth * 0.6)
    const dur = 260
    let t0 = null
    const step = (ts) => {
      if (t0 === null) t0 = ts
      const p = Math.min((ts - t0) / dur, 1)
      el.scrollLeft = start + delta * (1 - Math.pow(1 - p, 3)) // easeOutCubic: quick start, gentle finish
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
  const reorderTab = (path, beforePath) => {
    if (path === beforePath) return
    setTabs((ts) => {
      const without = ts.filter((p) => p !== path)
      const idx = beforePath ? without.indexOf(beforePath) : without.length
      if (idx < 0) return ts
      const next = [...without.slice(0, idx), path, ...without.slice(idx)]
      return next.every((p, k) => p === ts[k]) ? ts : next // skip no-op moves (avoid re-render churn)
    })
  }
  const startTabDrag = (e, path) => {
    if (!e.ctrlKey) return // hold Ctrl to drag a tab sideways
    e.preventDefault()
    dragTab.current = path
    const onMove = (ev) => {
      const el = tabsRef.current
      if (!el) return
      const before = [...el.querySelectorAll('.pdf-tab')].find((te) => {
        const r = te.getBoundingClientRect()
        return ev.clientX < r.left + r.width / 2
      })
      reorderTab(dragTab.current, before?.dataset.path || null)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      dragTab.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  useEffect(() => {
    updateScroll()
    const el = tabsRef.current
    if (!el) return
    const ro = new ResizeObserver(() => requestAnimationFrame(updateScroll)) // defer a frame to avoid RO loop warnings
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs])
  // bring the focused tab fully into view if it's clipped by the strip's edge
  useEffect(() => {
    if (!activePath) return
    tabsRef.current?.querySelector('.pdf-tab.is-active')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }, [activePath, tabs])

  // ---- name filter ----
  const q = query.trim().toLowerCase()
  const nameHit = (n) => (n.name || '').toLowerCase().includes(q)
  // visible while filtering: matches itself, or a (loaded) descendant matches. Unscanned folders
  // are scanned lazily, so the filter deepens as their contents arrive.
  const subtreeHit = (node) => {
    if (nameHit(node)) return true
    if (!isFolder(node)) return false
    const kids = childrenOf(node)
    if (kids === null) {
      doScan(node)
      return false
    }
    return kids.some(subtreeHit)
  }

  // ---- formatting for the hover tooltip ----
  const fmtSize = (b) => {
    if (b == null) return ''
    const u = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let n = b
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024
      i++
    }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i]
  }
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : '')
  const tooltip = (node) => {
    const m = info[node.path]
    return node.path + (m ? `\n${fmtSize(m.size)} · ${fmtDate(m.mtime)}` : '')
  }

  const rootItems = () => [
    { label: t('pdf.newFolder'), onClick: () => newFolder(null) },
    { label: t('pdf.linkFolder'), onClick: () => linkFolder(null) },
    { label: t('pdf.linkFile'), onClick: () => linkFile(null) }
  ]
  const tabItems = (path) => [
    { label: t('pdf.findInTree'), onClick: () => revealInTree(path) },
    { label: t('pdf.reveal'), onClick: () => api.pdf?.reveal?.(path) },
    { label: t('pdf.close'), onClick: () => closeTab(path) }
  ]
  const ctxItems = (node, parentId) => {
    const items = []
    if (isFolder(node) && node.type !== 'diskFolder') {
      items.push({ label: t('pdf.newFolder'), onClick: () => newFolder(node.id) })
      items.push({ label: t('pdf.linkFolder'), onClick: () => linkFolder(node.id) })
      items.push({ label: t('pdf.linkFile'), onClick: () => linkFile(node.id) })
    }
    if (node.type === 'linkFolder') {
      const other = node.mode === 'flat' ? 'tree' : 'flat'
      items.push({ label: t(other === 'flat' ? 'pdf.modeFlat' : 'pdf.modeTree'), onClick: () => setMode(node, other) })
    }
    if (isFile(node)) {
      items.push({ label: t('pdf.open'), onClick: () => api.pdf?.open?.(node.path) })
      items.push({ label: t('pdf.reveal'), onClick: () => api.pdf?.reveal?.(node.path) })
    }
    if (node.id) {
      items.push({ label: t('pdf.rename'), onClick: () => setEditing({ id: node.id, name: node.name }) })
      items.push({ label: t('pdf.remove'), onClick: () => removeNode(node.id) })
    }
    return items
  }

  const Row = ({ node, depth, parentId }) => {
    if (!node) return null
    const k = keyOf(node)
    const folder = isFolder(node)
    const open = q ? true : expanded.has(k) // while filtering, keep matching branches open
    let kids = folder && open ? childrenOf(node) : null
    if (q && Array.isArray(kids)) kids = kids.filter(subtreeHit)
    // expanded real folder with no cached scan (e.g. cache cleared after a save-as) → fetch it
    if (open && kids === null && (node.type === 'linkFolder' || node.type === 'diskFolder')) doScan(node)
    return (
      <>
        <div
          className={'pdf-row' + (activePath === node.path ? ' is-selected' : '') + (dropId === node.id ? ' is-drop' : '')}
          style={{ paddingLeft: 6 + depth * 14 }}
          title={isFile(node) ? tooltip(node) : undefined}
          onMouseEnter={isFile(node) ? () => loadInfo(node.path) : undefined}
          draggable={!!node.id}
          onDragStart={(e) => {
            e.stopPropagation()
            dragRef.current = node.id
          }}
          onDragOver={node.type === 'folder' ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropId !== node.id) setDropId(node.id) } : undefined}
          onDragLeave={node.type === 'folder' ? () => setDropId((d) => (d === node.id ? null : d)) : undefined}
          onDrop={node.type === 'folder' ? (e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files?.length) addExternal(e.dataTransfer.files, node.id); else moveNode(dragRef.current, node.id); dragRef.current = null; setDropId(null) } : undefined}
          onClick={() => folder && toggle(node)}
          onDoubleClick={() => !folder && selectFile(node)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, node, parentId })
          }}
        >
          <span className="pdf-row__caret">{folder ? <Caret open={open} /> : null}</span>
          <span className="pdf-row__icon">{folder ? <FolderGlyph link={node.type === 'linkFolder'} /> : <PdfIcon />}</span>
          {node.id && editing?.id === node.id ? (
            <input
              className="pdf-row__edit"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={editing.name}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditing({ id: node.id, name: e.target.value })}
              onBlur={() => {
                updateNode(node.id, { name: editing.name.trim() || node.name })
                setEditing(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span className="pdf-row__name">{node.name}</span>
          )}
          {node.type === 'linkFolder' && (
            <>
              <button
                type="button"
                className={'pdf-row__toggle' + (node.mode === 'flat' ? '' : ' is-on')}
                title={t(node.mode === 'flat' ? 'pdf.modeTree' : 'pdf.modeFlat')}
                onClick={(e) => {
                  e.stopPropagation()
                  setMode(node, node.mode === 'flat' ? 'tree' : 'flat') // on = show subfolders, off = all PDFs flat
                }}
              >
                <span className="pdf-row__toggle-knob" />
              </button>
              <span className="pdf-row__mode">{node.mode === 'flat' ? t('pdf.flat') : t('pdf.tree')}</span>
            </>
          )}
        </div>
        {folder && open && kids === null && <div className="pdf-row__loading" style={{ paddingLeft: 22 + depth * 14 }}>…</div>}
        {folder && open && Array.isArray(kids) && kids.filter(Boolean).map((c) => <Row key={keyOf(c)} node={c} depth={depth + 1} parentId={node.id || parentId} />)}
      </>
    )
  }

  return (
    <div className="pdf">
      {collapsed ? (
        <button className="pdf__open" title={t('pdf.expand')} onClick={toggleCollapsed}>
          <ChevronRightIcon />
        </button>
      ) : (
        <aside className="pdf__tree" style={{ width }}>
          <div className="pdf__tree-head">
            <div className="pdf__search">
              <SearchIcon />
              <input
                type="text"
                placeholder={t('pdf.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {query && (
                <button className="pdf__search-clear" title={t('pdf.clear')} onClick={() => setQuery('')}>
                  ✕
                </button>
              )}
            </div>
            <button className="pdf__collapse" title={t('pdf.collapse')} onClick={toggleCollapsed}>
              <ChevronLeftIcon />
            </button>
          </div>
          <div
            ref={treeBodyRef}
            className="pdf__tree-body"
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY }) // empty space → root actions (no node)
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (e.dataTransfer.files?.length) addExternal(e.dataTransfer.files, null) // OS folder/PDF → link at root
              else moveNode(dragRef.current, null) // internal move → to the root
              dragRef.current = null
              setDropId(null)
            }}
          >
            {(() => {
              const roots = tree.roots.filter(Boolean)
              const shown = q ? roots.filter(subtreeHit) : roots
              if (shown.length === 0) return <div className="pdf__empty">{q ? t('pdf.noMatch') : t('pdf.empty')}</div>
              return shown.map((n) => <Row key={keyOf(n)} node={n} depth={0} parentId={null} />)
            })()}
          </div>
          <div className="pdf__resize" onMouseDown={startResize} title={t('pdf.resize')} />
        </aside>
      )}

      <main className="pdf__center">
        {tabs.length === 0 ? (
          <div className="pdf__placeholder">
            <PdfIcon />
            <div className="pdf__placeholder-title">{t('pdf.placeholderTitle')}</div>
            <div className="pdf__placeholder-sub">{t('pdf.placeholderSub')}</div>
          </div>
        ) : (
          <div className="pdf__tabs-wrap">
            <div className="pdf__tabs">
              {scroll.left && (
                <button className="pdf-tabs__nav" title={t('pdf.scrollLeft')} onClick={() => scrollTabs(-1)}>
                  ‹
                </button>
              )}
              <div className="pdf__tabs-strip" ref={tabsRef} onScroll={updateScroll}>
                {tabs.map((p) => (
                  <div
                    key={p}
                    data-path={p}
                    className={'pdf-tab' + (p === activePath ? ' is-active' : '')}
                    title={p}
                    onMouseDown={(e) => startTabDrag(e, p)}
                    onClick={() => setActivePath(p)}
                    onDoubleClick={() => revealInTree(p)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ x: e.clientX, y: e.clientY, tabPath: p })
                    }}
                  >
                    <span className="pdf-tab__name">{baseName(p)}</span>
                    <button
                      className="pdf-tab__close"
                      title={t('pdf.close')}
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(p)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button className="pdf-tab__add" title={t('pdf.addTab')} onClick={addTab}>
                  ＋
                </button>
              </div>
              {scroll.right && (
                <button className="pdf-tabs__nav" title={t('pdf.scrollRight')} onClick={() => scrollTabs(1)}>
                  ›
                </button>
              )}
            </div>
            <div className="pdf__tab-body">
              {/* one editor instance per open tab; only the active one is shown, so each PDF keeps its state */}
              {tabs.map((p) => (
                <div key={p} className="pdf__tab-pane" style={{ display: p === activePath ? undefined : 'none' }}>
                  <PdfEditorTab path={p} />
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.tabPath ? tabItems(menu.tabPath) : menu.node ? ctxItems(menu.node, menu.parentId) : rootItems()}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
