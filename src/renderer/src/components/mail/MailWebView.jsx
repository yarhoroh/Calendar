import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import api from '../../lib/api'
import { ChevronLeftIcon, ChevronRightIcon, SpeakerIcon, PlayIcon, PauseIcon, StopIcon, NextIcon, ZoomInIcon, ZoomOutIcon, LanguageIcon, ShortenIcon, ApplyIcon } from '../icons'
import ContextMenu from '../ContextMenu'
import { useI18n } from '../../i18n/I18nContext'
import { speakArticle, ttsAction, subscribeTts, getTtsState } from '../../lib/ttsBridge'
import { splitForTts, speakSelection } from '../../lib/selectionSpeak'
import SelectionPlayButton from './SelectionPlayButton'
import './MailWebView.css'

// target languages (the AI auto-detects the source); 'original' = no translation
const LANGS = ['Ukrainian', 'English', 'Russian', 'German', 'French', 'Spanish', 'Polish', 'Italian', 'Portuguese', 'Chinese', 'Japanese']
const LEVELS = ['medium', 'brief', 'key'] // summary depths; 'none' = the no-op placeholder

// our language names → the built-in TTS reader's codes (it currently speaks uk/ru/en;
// others fall back to English until the multilingual engine is wired in)
const TTS_LANG = { Russian: 'ru', Ukrainian: 'uk', English: 'en' }


// pulls the main article's ORIGINAL text out of the page (rebuilt from __mailtrMap, so
// even if the page is currently Google-translated we send the LLM the untranslated
// source — it translates + condenses from the original, which is more accurate)
const EXTRACT = `(function(){
  var map = window.__mailtrMap;
  function origText(el){
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n, s = '';
    while ((n = w.nextNode())) {
      var p = n.parentElement;
      if (p && p.closest('script,style,noscript,svg,code,pre,textarea')) continue;
      s += (map && map.has(n)) ? map.get(n) : (n.nodeValue || '');
    }
    return s.replace(/\\s+/g,' ').trim();
  }
  var root = document.querySelector('article') || document.querySelector('main') || document.body;
  var parts = [];
  root.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,figcaption').forEach(function(el){
    if (el.closest('nav,header,footer,aside,form')) return;
    var t = origText(el);
    if (t.length > 1) parts.push(t);
  });
  var text = parts.join('\\n\\n');
  if (text.length < 200) text = origText(root);
  return { title: document.title || '', text: text };
})()`

// collect the page's text nodes for in-place full-text translation. Re-walks the DOM
// EVERY time (so late/SPA-rendered content is picked up, not just what existed on the
// first run) and remembers each node's ORIGINAL text in a Map (node → original) so we
// translate from the original and can revert. __mailtrNodes = the current ordered list.
const COLLECT = `(function(){
  if (!window.__mailtrMap) window.__mailtrMap = new Map();
  var nodes = [], origs = [];
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n;
  while ((n = w.nextNode())) {
    var p = n.parentElement;
    if (p && p.closest('script,style,noscript,svg,code,pre,textarea')) continue; // not human text
    var cur = n.nodeValue;
    if (!cur || cur.replace(/\\s+/g,' ').trim().length <= 1) continue;
    if (!window.__mailtrMap.has(n)) window.__mailtrMap.set(n, cur); // remember the original once
    nodes.push(n); origs.push(window.__mailtrMap.get(n));
    if (nodes.length >= 2000) break;
  }
  window.__mailtrNodes = nodes;
  var s = {}; origs.forEach(function(t,i){ s[i] = t; }); return s;
})()`

const REVERT = `(function(){
  if (window.__mailtrMap) window.__mailtrMap.forEach(function(orig, node){ node.nodeValue = orig; });
})()`

const applyCode = (map) =>
  `(function(m){ var a = window.__mailtrNodes || []; for(var k in m){ var i=+k; if(a[i]) a[i].nodeValue = m[k]; } })(${JSON.stringify(map)})`

// resolves once the DOM has settled — no mutations for 500ms (so SPA/lazy article
// text is in place), with an 8s hard cap for pages that never stop mutating (ads).
// executeJavaScript awaits the returned promise, so we translate only when ready.
const WAIT_READY = `new Promise(function(resolve){
  var done = false;
  function finish(){ if(done) return; done = true; try{ obs.disconnect(); }catch(e){} resolve(true); }
  var idle = setTimeout(finish, 500);
  var obs = new MutationObserver(function(){ clearTimeout(idle); idle = setTimeout(finish, 500); });
  try { obs.observe(document.body, { childList:true, subtree:true, characterData:true }); }
  catch(e){ return finish(); }
  setTimeout(finish, 8000);
})`

// like COLLECT but returns ONLY nodes still showing their original text (untranslated)
// — used to top up content that appears later (scroll-loaded comments, related
// articles) without re-translating what's already done
const COLLECT_NEW = `(function(){
  if (!window.__mailtrMap) window.__mailtrMap = new Map();
  var nodes = [], origs = [];
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n;
  while ((n = w.nextNode())) {
    var p = n.parentElement;
    if (p && p.closest('script,style,noscript,svg,code,pre,textarea')) continue;
    var cur = n.nodeValue;
    if (!cur || cur.replace(/\\s+/g,' ').trim().length <= 1) continue;
    var known = window.__mailtrMap.has(n);
    var orig = known ? window.__mailtrMap.get(n) : cur;
    if (!known) window.__mailtrMap.set(n, cur);
    if (cur === orig) { nodes.push(n); origs.push(orig); } // still original → needs translating
    if (nodes.length >= 2000) break;
  }
  window.__mailtrNodes = nodes;
  var s = {}; origs.forEach(function(t,i){ s[i] = t; }); return s;
})()`

// install a debounced MutationObserver once; it bumps window.__mailtrGen whenever the
// DOM changes (scroll-loaded sections etc.). The renderer polls __mailtrGen and tops up.
const OBSERVE = `(function(){
  if (window.__mailtrObs) return;
  window.__mailtrGen = window.__mailtrGen || 0;
  var deb;
  window.__mailtrObs = new MutationObserver(function(){
    clearTimeout(deb); deb = setTimeout(function(){ window.__mailtrGen++; }, 250);
  });
  try { window.__mailtrObs.observe(document.body, { childList:true, subtree:true, characterData:true }); } catch(e){}
})()`

// read the guest's current text selection (text + rect in its own viewport coords) — the
// host polls this while the browser is shown, since mouse events inside an isolated webview
// don't bubble out and it has no preload to message us.
const READ_SELECTION = `(function(){
  var s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  var t = s.toString().trim();
  if (!t) return null;
  var r = s.getRangeAt(0).getBoundingClientRect();
  return { text: t, x: r.left + r.width/2, y: r.top };
})()`

// injected into the guest: Ctrl+wheel reports a zoom step out via console.log (the only
// channel out of the isolated webview) so the host adjusts the native zoom factor.
const ZOOM_HOOK = `(function(){
  if (window.__zoomHooked) return;
  window.__zoomHooked = true;
  document.addEventListener('wheel', function(e){
    if (!e.ctrlKey) return;
    e.preventDefault();
    console.log('__ZOOM__' + (e.deltaY < 0 ? 'in' : 'out'));
  }, { passive: false });
})()`

// In-app web viewer that overlays the whole mail area (its top bar replaces the
// head/pagination strip). A link from an email loads in an isolated <webview>; the
// email underneath stays untouched — "Back" closes the overlay.
// Apply processes the article: "Full text" translates in place (HTML kept), the
// condensed levels show a clean reader panel; the result is cached so the Page/Reader
// button just toggles the view without re-running the AI.
export default function MailWebView({ url, onClose, initialLang }) {
  const { t } = useI18n()
  const wvRef = useRef(null)
  const runRef = useRef(0) // cancels a stale in-place translation if the language changes
  const lockRef = useRef(false) // serialize translate passes (full + background top-up)
  const pollRef = useRef(null) // interval id for the live top-up loop
  const genRef = useRef(0) // last seen DOM-mutation generation
  const targetRef = useRef('original') // current live-translation target language
  const loadedOnceRef = useRef(false) // first page load done? (did-navigate fires on it too)
  const [title, setTitle] = useState('')
  const [addr, setAddr] = useState(url)
  const [loading, setLoading] = useState(true)
  const [nav, setNav] = useState({ back: false, fwd: false })
  // language is pre-filled from the email (convenience) but nothing runs until Apply
  const [lang, setLang] = useState(initialLang && initialLang !== 'original' ? initialLang : 'original')
  const [level, setLevel] = useState('none') // 'none' = placeholder (does nothing)
  const [busy, setBusy] = useState(false) // any translate/summarize in progress
  const [summarizing, setSummarizing] = useState(false) // LLM summary in progress → panel spinner
  const [error, setError] = useState('')
  const [article, setArticle] = useState(null) // cached condensed text; null = none made yet
  const [view, setView] = useState('page') // 'page' | 'article'
  const [firstLoaded, setFirstLoaded] = useState(false)
  const autoDone = useRef(false) // auto-translate on open runs once
  const articleRef = useRef(null) // the rendered reader text — lets read-aloud honor a selection
  const [selBtn, setSelBtn] = useState(null) // { x, y, text } floating ▶ over a reader selection
  const [wvSel, setWvSel] = useState(null) // same, for a selection inside the internal browser
  // browser zoom (% — scales the guest page via the webview's native zoom factor)
  const [zoom, setZoom] = useState(100)
  const zoomRef = useRef(100)
  const changeZoom = (d) => setZoom((z) => Math.min(250, Math.max(50, z + d)))
  const resetZoom = () => setZoom(100)
  const [langMenu, setLangMenu] = useState(null) // { x, y } — language dropdown (icon → menu)
  const [levelMenu, setLevelMenu] = useState(null) // { x, y } — shorten-level dropdown
  // read-aloud feeds the GLOBAL queue (ttsBridge) so it survives navigating away from the
  // reader; the floating control just reflects/drives the shared playback state.
  const ttsState = useSyncExternalStore(subscribeTts, getTtsState)
  const [starting, setStarting] = useState(false) // first paragraph synthesizing

  useEffect(() => {
    const wv = wvRef.current
    if (!wv) return
    const onStart = () => setLoading(true)
    const onStop = () => {
      setLoading(false)
      setFirstLoaded(true)
      loadedOnceRef.current = true
      try {
        setNav({ back: wv.canGoBack(), fwd: wv.canGoForward() })
        setAddr(wv.getURL())
      } catch {
        /* webview not ready */
      }
    }
    const onTitle = (e) => setTitle(e.title)
    const onNavInPage = (e) => setAddr(e.url)
    const onNav = (e) => {
      setAddr(e.url)
      // did-navigate also fires on the very first load — don't wipe the pre-selected
      // language there, or auto-translate would never run
      if (!loadedOnceRef.current) return
      // genuine navigation to a new page → drop the cached result, stop the live loop
      // (its observer/map died with the old document), reset the language
      runRef.current++
      setWvSel(null) // the old document's selection ▶ is meaningless on the new page
      setArticle(null)
      setView('page')
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      targetRef.current = 'original'
      genRef.current = 0
      setLang('original')
    }
    const onNewWin = (e) => {
      e.preventDefault?.()
      if (e.url) wv.loadURL(e.url)
    }
    // re-inject the Ctrl+wheel zoom hook on every document, and re-apply our zoom factor
    // (navigation can reset it)
    const onDomReady = () => {
      try {
        wv.executeJavaScript(ZOOM_HOOK, true)
        wv.setZoomFactor(zoomRef.current / 100)
      } catch {
        /* webview gone */
      }
    }
    // the guest reports Ctrl+wheel zoom steps here
    const onConsole = (e) => {
      const m = e.message || ''
      if (m === '__ZOOM__in') setZoom((z) => Math.min(250, Math.max(50, z + 5)))
      else if (m === '__ZOOM__out') setZoom((z) => Math.min(250, Math.max(50, z - 5)))
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNavInPage)
    wv.addEventListener('new-window', onNewWin)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('console-message', onConsole)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNavInPage)
      wv.removeEventListener('new-window', onNewWin)
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('console-message', onConsole)
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  // apply the zoom to the webview whenever it changes
  useEffect(() => {
    zoomRef.current = zoom
    try {
      wvRef.current?.setZoomFactor?.(zoom / 100)
    } catch {
      /* webview not ready */
    }
  }, [zoom])

  // floating ▶ for a selection INSIDE the browser. Mouse events don't escape the isolated
  // webview and it has no preload, so we poll its selection while the page is shown (cheap:
  // one tiny executeJavaScript). Off in reader view (the article DOM handles its own).
  useEffect(() => {
    if (view !== 'page') {
      setWvSel(null)
      return
    }
    const wv = wvRef.current
    if (!wv) return
    let alive = true
    const id = setInterval(async () => {
      let d = null
      try {
        d = await wv.executeJavaScript(READ_SELECTION, false)
      } catch {
        return // webview busy/navigating
      }
      if (!alive) return
      if (!d) return setWvSel((cur) => (cur ? null : cur))
      const r = wv.getBoundingClientRect() // guest viewport coords → host viewport coords
      setWvSel({ x: r.left + d.x, y: r.top + d.y, text: d.text })
    }, 350)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [view])

  const acquireLock = async () => {
    for (let i = 0; i < 200 && lockRef.current; i++) await new Promise((r) => setTimeout(r, 30))
    lockRef.current = true
  }

  // in-place translation via the fast free Google endpoint (web pages only; emails use
  // the AI). Translates the page's text nodes in chunks, applying each as it returns so
  // the page fills in progressively (top-to-bottom) instead of one long wait.
  // `onlyNew` tops up just the still-untranslated nodes (scroll-loaded comments etc.).
  const translateInPlace = async (target, onlyNew) => {
    const wv = wvRef.current
    if (!wv) return ''
    if (onlyNew && lockRef.current) return '' // top-up: don't wait, retry next poll tick
    const run = ++runRef.current // cancel any in-flight pass; a manual change preempts a top-up
    await acquireLock()
    try {
      if (run !== runRef.current) return '' // superseded while waiting for the lock
      const entries = Object.entries(await wv.executeJavaScript(onlyNew ? COLLECT_NEW : COLLECT, true))
      if (!entries.length) return ''
      const CHUNK = 40 // nodes per request → progressive translation, not one big wait
      let failed = ''
      for (let i = 0; i < entries.length; i += CHUNK) {
        if (run !== runRef.current) return '' // a newer run superseded this one
        const r = await api.mail?.webTranslate?.(Object.fromEntries(entries.slice(i, i + CHUNK)), target)
        if (run !== runRef.current) return ''
        if (r?.ok && r.map) await wv.executeJavaScript(applyCode(r.map), true)
        else {
          failed = r?.error || t('mail.articleFailed')
          break
        }
      }
      return failed
    } finally {
      lockRef.current = false
    }
  }

  // keep translating content that appears later (scroll-loaded comments / related
  // articles): a MutationObserver in the page bumps a counter; we poll it and top up
  // only the new untranslated nodes to the current target.
  const startLive = async (target) => {
    const wv = wvRef.current
    if (!wv) return
    targetRef.current = target
    await wv.executeJavaScript(OBSERVE, true)
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      if (targetRef.current === 'original') return
      let gen = 0
      try {
        gen = await wvRef.current?.executeJavaScript('window.__mailtrGen||0', true)
      } catch {
        return
      }
      if (gen !== genRef.current) {
        genRef.current = gen
        translateInPlace(targetRef.current, true)
      }
    }, 1200)
  }

  const stopLive = () => {
    targetRef.current = 'original'
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  // translate the live page to `target` (or revert to the original) via Google —
  // runs instantly when the language dropdown changes, no Apply needed. `waitReady`
  // (used by auto-translate on open) first waits for the DOM to settle.
  const translatePage = async (target, waitReady) => {
    const wv = wvRef.current
    if (!wv) return
    setBusy(true)
    setError('')
    try {
      if (waitReady) await wv.executeJavaScript(WAIT_READY, true)
      if (target === 'original') {
        stopLive()
        runRef.current++
        await wv.executeJavaScript(REVERT, true)
      } else {
        const failed = await translateInPlace(target)
        if (failed) setError(failed)
        else await startLive(target) // keep new content translated as it loads
      }
    } catch (e) {
      setError(String(e?.message || e))
    }
    setBusy(false)
  }

  // language dropdown → translate the page now; drop any stale summary, show the page
  const pickLang = (v) => {
    if (busy || summarizing) return
    setLang(v)
    setArticle(null)
    setView('page')
    translatePage(v)
  }

  // Apply = summarize at the chosen level (LLM) into the reader panel. Sends the
  // ORIGINAL article text + the chosen language so the LLM translates + condenses from
  // the source (more accurate than summarizing a Google-translated page). 'none' = no-op.
  const apply = async () => {
    const wv = wvRef.current
    if (!wv || summarizing || level === 'none') return
    setSummarizing(true) // summary state is separate from translation `busy`
    setError('')
    try {
      const data = await wv.executeJavaScript(EXTRACT, true)
      const r = await api.mail?.readArticle?.({ title: data?.title, text: data?.text, lang, level })
      if (r?.ok) {
        setArticle(r.text)
        setView('article')
      } else {
        setError(r?.error || t('mail.articleFailed'))
      }
    } catch (e) {
      setError(String(e?.message || e))
    }
    setSummarizing(false)
  }

  // auto-translate on open: if a language was chosen in the email, translate the page
  // once it loads — waiting for the DOM to actually settle (not a guessed timeout)
  // so the whole article is translated, not just what rendered first.
  useEffect(() => {
    if (firstLoaded && !autoDone.current && lang !== 'original') {
      autoDone.current = true
      translatePage(lang, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstLoaded])

  // ---- read the summary aloud — feed the GLOBAL queue so it survives navigation ----
  // We don't play here: speakArticle pushes each paragraph into the app-level queue
  // (useTtsPlayer), which keeps speaking as the user moves to other mail / calendar /
  // settings. The floating control only mirrors and drives the shared playback state.
  const readAloud = () => {
    if (!article) return
    const chunks = splitForTts(article)
    if (!chunks.length) return
    setStarting(true) // the first paragraph is synthesizing on the backend
    speakArticle(chunks, TTS_LANG[lang] || 'en')
  }
  const stopRead = () => {
    ttsAction('stop')
    setStarting(false)
  }
  // ---- floating ▶ over a text selection: play just the highlighted fragment ----
  // recompute the button from the live selection (called on mouseup + while scrolling so it
  // tracks the text); hide it when the selection collapses or leaves the article.
  const updateSelBtn = () => {
    const sel = window.getSelection?.()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return setSelBtn(null)
    const node = sel.anchorNode
    if (!articleRef.current || !node || !articleRef.current.contains(node)) return setSelBtn(null)
    const text = sel.toString().trim()
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    if (!text || (!rect.width && !rect.height)) return setSelBtn(null)
    setSelBtn({ x: rect.left + rect.width / 2, y: rect.top, text })
  }
  const playSelection = () => {
    if (!selBtn?.text) return
    setStarting(true)
    speakSelection(selBtn.text, TTS_LANG[lang] || 'auto')
    setSelBtn(null)
    window.getSelection?.()?.removeAllRanges?.()
  }
  // speak a selection made inside the internal browser — language auto-detected from the text
  const playWvSelection = () => {
    if (!wvSel?.text) return
    setStarting(true)
    speakSelection(wvSel.text, 'auto')
    setWvSel(null)
    try {
      wvRef.current?.executeJavaScript('window.getSelection&&window.getSelection().removeAllRanges()', true)
    } catch {
      /* webview gone */
    }
  }
  // drop the button as soon as the selection is cleared (click elsewhere, new selection start)
  useEffect(() => {
    const onSelChange = () => {
      const sel = window.getSelection?.()
      if (!sel || sel.isCollapsed) setSelBtn(null)
    }
    document.addEventListener('selectionchange', onSelChange)
    return () => document.removeEventListener('selectionchange', onSelChange)
  }, [])
  // first clip started (or playback ended) → drop the "preparing" spinner
  useEffect(() => {
    if (ttsState.status !== 'idle') setStarting(false)
  }, [ttsState.status])

  const showReader = view === 'article' && article != null
  const loadingPanel = summarizing

  return (
    <div className="mail-web">
      <div className="mail-web__bar">
        <button className="mail-web__back" onClick={onClose} title={t('mail.backToEmail')}>
          <ChevronLeftIcon /> {t('mail.back')}
        </button>
        <span className="mail-web__div" />
        <button className="mail-web__nav" disabled={!nav.back} onClick={() => wvRef.current?.goBack()} title={t('mail.navBack')}>
          <ChevronLeftIcon />
        </button>
        <button className="mail-web__nav" disabled={!nav.fwd} onClick={() => wvRef.current?.goForward()} title={t('mail.navForward')}>
          <ChevronRightIcon />
        </button>

        <div className="mail-web__addr" title={addr}>
          {loading && <span className="mail-spinner mail-spinner--sm" />}
          <span className="mail-web__title">{title || addr}</span>
        </div>

        {/* compact toolbar: language + shorten are icons that open a dropdown on click */}
        <button
          className={'mail-web__nav' + (lang !== 'original' ? ' is-on' : '')}
          title={t('mail.language')}
          disabled={busy || summarizing}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setLangMenu({ x: r.left, y: r.bottom + 4 })
          }}
        >
          <LanguageIcon />
        </button>
        <button
          className={'mail-web__nav' + (level !== 'none' ? ' is-on' : '')}
          title={t('mail.shorten')}
          disabled={busy || summarizing}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setLevelMenu({ x: r.left, y: r.bottom + 4 })
          }}
        >
          <ShortenIcon />
        </button>
        {/* Apply reacts ONLY to summarizing (LLM) — changing the language must not touch it */}
        <button className="mail-web__nav mail-web__apply" onClick={apply} disabled={summarizing || level === 'none'} title={t('mail.apply')}>
          {summarizing ? <span className="mail-spinner mail-spinner--sm mail-spinner--white" /> : <ApplyIcon />}
        </button>
        {article != null && (
          <button className="mail-web__nav mail-web__toggle" onClick={() => setView((v) => (v === 'article' ? 'page' : 'article'))}>
            {view === 'article' ? t('mail.viewPage') : t('mail.viewReader')}
          </button>
        )}

        <div className="mail-web__zoom">
          <button className="mail-web__nav" title={t('mail.zoomOut')} onClick={() => changeZoom(-5)}><ZoomOutIcon /></button>
          <button className="mail-web__zoomval" title={t('mail.zoomReset')} onClick={resetZoom}>{zoom}%</button>
          <button className="mail-web__nav" title={t('mail.zoomIn')} onClick={() => changeZoom(5)}><ZoomInIcon /></button>
        </div>

        <button className="mail-web__ext" onClick={() => api.openExternal?.(addr)} title={t('mail.openExternal')}>
          ↗
        </button>
      </div>

      {error && <div className="mail-web__error">⚠ {error}</div>}

      <div className="mail-web__body">
        <webview ref={wvRef} className="mail-web__view" src={url} partition="persist:mailbrowser" />
        {(showReader || loadingPanel) && (
          <div
            className="mail-web__reader"
            onMouseUp={() => requestAnimationFrame(updateSelBtn)}
            onScroll={() => selBtn && updateSelBtn()}
          >
            {loadingPanel ? (
              <div className="mail-web__loading">
                <span className="mail-spinner" />
              </div>
            ) : (
              <article className="mail-web__article" ref={articleRef} style={{ zoom: zoom / 100 }}>
                {article.split('\n').map((line, i) => (line.trim() ? <p key={i}>{line}</p> : <br key={i} />))}
              </article>
            )}
          </div>
        )}
        {/* floating ▶ above a text selection → speaks just that fragment */}
        {showReader && <SelectionPlayButton pos={selBtn} title={t('mail.readAloud')} onPlay={playSelection} />}
        {/* same ▶ for a selection inside the internal browser (webview) — language auto-detected */}
        <SelectionPlayButton pos={wvSel} title={t('mail.readAloud')} onPlay={playWvSelection} />
        {/* read-aloud controls float at the bottom-right of the reader (above the chat),
            outside the scrolling text so they stay put */}
        {showReader && (
          <div className="mail-web__tts">
            {/* mirrors the GLOBAL playback state (same as the top-bar controls). Reading
                keeps going even if you leave the reader — the top bar still controls it. */}
            {starting && ttsState.status === 'idle' ? (
              <>
                <button className="mail-web__tts-btn mail-web__tts-btn--prep" disabled title={t('mail.preparing')}>
                  <span className="mail-spinner" />
                </button>
                <button className="mail-web__tts-btn mail-web__tts-btn--stop" onClick={stopRead} title={t('mail.stop')}>
                  <StopIcon />
                </button>
              </>
            ) : ttsState.status === 'playing' || ttsState.status === 'paused' ? (
              <>
                <button
                  className={'mail-web__tts-btn' + (ttsState.status === 'playing' ? ' mail-web__tts-btn--pause' : '')}
                  onClick={() => ttsAction(ttsState.status === 'playing' ? 'pause' : 'resume')}
                  title={ttsState.status === 'playing' ? t('mail.pause') : t('mail.resume')}
                >
                  {ttsState.status === 'playing' ? <PauseIcon /> : <PlayIcon />}
                </button>
                {ttsState.queueLen > 0 && (
                  <button className="mail-web__tts-btn" onClick={() => ttsAction('next')} title={t('tts.next')}>
                    <NextIcon />
                  </button>
                )}
                <button className="mail-web__tts-btn mail-web__tts-btn--stop" onClick={stopRead} title={t('mail.stop')}>
                  <StopIcon />
                </button>
              </>
            ) : (
              <button className="mail-web__tts-btn" onClick={readAloud} title={t('mail.readAloud')}>
                <SpeakerIcon />
              </button>
            )}
          </div>
        )}
      </div>
      {langMenu && (
        <ContextMenu
          x={langMenu.x}
          y={langMenu.y}
          items={[
            { label: (lang === 'original' ? '✓ ' : '') + t('mail.showOriginal'), onClick: () => { pickLang('original'); setLangMenu(null) } },
            ...LANGS.map((l) => ({ label: (lang === l ? '✓ ' : '') + l, onClick: () => { pickLang(l); setLangMenu(null) } }))
          ]}
          onClose={() => setLangMenu(null)}
        />
      )}
      {levelMenu && (
        <ContextMenu
          x={levelMenu.x}
          y={levelMenu.y}
          items={[
            { label: (level === 'none' ? '✓ ' : '') + t('mail.shorten'), onClick: () => { setLevel('none'); setLevelMenu(null) } },
            ...LEVELS.map((l) => ({ label: (level === l ? '✓ ' : '') + t('mail.level.' + l), onClick: () => { setLevel(l); setLevelMenu(null) } }))
          ]}
          onClose={() => setLevelMenu(null)}
        />
      )}
    </div>
  )
}
