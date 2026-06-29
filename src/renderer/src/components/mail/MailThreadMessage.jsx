import { useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import api from '../../lib/api'
import { StarIcon } from '../icons'
import { monogram } from '../../lib/monogram'
import { useI18n } from '../../i18n/I18nContext'
import MailAttachBadge from './MailAttachBadge'
import MailAttachChip from './MailAttachChip'
import SelectionPlayButton from './SelectionPlayButton'
import { speakSelection } from '../../lib/selectionSpeak'

// defer external images (so the iframe makes no external requests; the backend
// downloads them and we swap the data: URL in on load). Covers <img src>, <img/
// source srcset> and external url() in inline styles.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG') {
    let s = node.getAttribute('src')
    if ((!s || !/^https?:/i.test(s)) && node.getAttribute('srcset')) {
      const first = node.getAttribute('srcset').match(/(https?:\/\/[^\s,]+)/) // fall back to srcset
      if (first) s = first[1]
    }
    if (s && /^https?:/i.test(s)) {
      node.setAttribute('data-osrc', s)
      node.removeAttribute('src')
    }
    node.removeAttribute('srcset') // never let the responsive variants load externally
  }
  if (node.tagName === 'SOURCE') node.removeAttribute('srcset')
  // strip external background images from inline styles (they'd just be CSP-blocked)
  const style = node.getAttribute && node.getAttribute('style')
  if (style && /url\(\s*['"]?https?:/i.test(style)) {
    node.setAttribute('style', style.replace(/url\(\s*['"]?https?:[^)'"]*['"]?\s*\)/gi, 'none'))
  }
})

// DOMPurify (the standard HTML sanitizer) strips scripts, inline event handlers,
// javascript: urls, frames/objects etc.; we keep <style> so emails still render
function sanitizeEmailHtml(raw) {
  if (!raw) return ''
  return DOMPurify.sanitize(raw, { ADD_TAGS: ['style'], ADD_ATTR: ['data-osrc'] })
}

const fmtDate = (ts) =>
  ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

// target languages for the in-message translator (the AI auto-detects the source)
const LANGS = ['Ukrainian', 'English', 'Russian', 'German', 'French', 'Spanish', 'Polish', 'Italian', 'Portuguese', 'Chinese', 'Japanese']

// small green spinner (SMIL-animated SVG, no JS) used as a per-image background
// placeholder while that image is still loading
const SPIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'%3E%3Ccircle cx='11' cy='11' r='8' fill='none' stroke='%2310b981' stroke-width='2.5' stroke-dasharray='38 14' stroke-linecap='round'%3E%3CanimateTransform attributeName='transform' type='rotate' from='0 11 11' to='360 11 11' dur='0.8s' repeatCount='indefinite'/%3E%3C/circle%3E%3C/svg%3E"

// strict CSP: the iframe never fetches anything external (no scripts/frames; images
// only data:/cid:). External images are downloaded by the backend and swapped in
// place over their spinner placeholders. + a <style> for the .imgld placeholder.
const HEAD =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline' data:; font-src data:;">` +
  `<meta name="color-scheme" content="light only">` +
  `<style>html,body{margin:0;padding:0}img.imgld{background:url("${SPIN}") center / 22px no-repeat}</style>`

// One real message inside a conversation. Collapsed shows a preview; expanded shows
// the body (HTML in a sandboxed iframe, else text), an expandable Details block and
// per-message actions. Inline images load with their own spinner placeholders.
export default function MailThreadMessage({ m, defaultOpen, account, starred, onToggleStar, onOpenInternal, onLinkMenu, onPickLang, onZoom, zoom }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(!!defaultOpen)
  const [hasOpened, setHasOpened] = useState(!!defaultOpen) // mount the body once, then keep it
  const [details, setDetails] = useState(false)
  const who = m.from || m.fromEmail || ''
  const preview = (m.text || '').split('\n').map((l) => l.trim()).find(Boolean) || ''
  const date = fmtDate(m.ts)
  // sanitized body (scripts/handlers removed, external images deferred to data-osrc)
  const html = sanitizeEmailHtml(m.html)

  // ---- in-message translator (built-in AI; auto-detects the source language) ----
  const iframeRef = useRef(null)
  const dataRef = useRef(null) // [{ node, original }] collected once
  const runRef = useRef(0) // cancels stale runs when the language changes mid-flight
  const langRef = useRef('original') // current language, read by the (once-attached) link handlers
  const [lang, setLang] = useState('original') // every message opens showing the original
  langRef.current = lang
  const [translated, setTranslated] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [trError, setTrError] = useState('')
  const [selBtn, setSelBtn] = useState(null) // { x, y, text } floating ▶ over a body selection

  const collectNodes = () => {
    const doc = iframeRef.current?.contentDocument
    if (!doc?.body) return []
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    const arr = []
    let node
    while ((node = walker.nextNode())) {
      const txt = node.nodeValue
      if (txt && txt.replace(/\s+/g, ' ').trim().length > 1) {
        arr.push({ node, original: txt })
        if (arr.length >= 400) break
      }
    }
    return arr
  }

  // translate the body to `target` via the fast free Google endpoint, swapping each
  // text node in place; always works from the saved originals (the AI is reserved for
  // summarizing, not translating — Google is faster, free and never breaks the format)
  const translate = async (target) => {
    if (!dataRef.current) dataRef.current = collectNodes()
    const data = dataRef.current
    if (!data.length) return
    const run = ++runRef.current
    setTranslating(true)
    setTrError('')
    setTranslated(true)
    const segments = {}
    data.forEach((d, i) => {
      segments[i] = d.original
    })
    const r = await api.mail?.webTranslate?.(segments, target)
    if (run !== runRef.current) return // a newer run started → drop this one
    if (r?.ok && r.map) {
      data.forEach((d, i) => {
        const tr = r.map[i] ?? r.map[String(i)]
        if (tr != null) d.node.nodeValue = tr
      })
    } else {
      setTrError(r?.error || 'translation failed')
    }
    setTranslating(false)
  }

  const showOriginal = () => {
    runRef.current++ // cancel any in-flight translate
    ;(dataRef.current || []).forEach((d) => {
      d.node.nodeValue = d.original
    })
    setTranslating(false)
    setTranslated(false)
  }

  // pick from the dropdown — "original" reverts, a language (re)translates. Also
  // translates the subject (it lives in the reader header, outside this iframe).
  const pickLang = (v) => {
    setLang(v)
    onPickLang?.(v)
    if (v === 'original') showOriginal()
    else translate(v)
  }

  // size the iframe to its content; replace each external image with a spinner
  // placeholder, then ask the backend to download them and swap the data: URL in
  // place (no body reload → no flicker; the renderer never fetches externally)
  const onLoad = (e) => {
    const f = e.target
    const doc = f.contentDocument
    if (!doc) return
    // exact content height (body margins can make body.scrollHeight too small);
    // a couple px of slack avoids a sub-pixel scrollbar
    const fit = () => {
      const h = Math.min(Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, doc.body.offsetHeight) + 2, 12000)
      // only write when it actually changed → no ResizeObserver feedback loop
      if (Math.abs((parseInt(f.style.height, 10) || 0) - h) > 1) f.style.height = h + 'px'
    }
    fit()
    // re-fit on ANY content reflow (images, fonts, late layout) so a scrollbar
    // never appears inside the message
    try {
      const RO = window.ResizeObserver
      if (RO) {
        let pending = false
        const refit = () => {
          if (pending) return
          pending = true
          requestAnimationFrame(() => {
            pending = false
            fit()
          })
        }
        const ro = new RO(refit) // throttled to one fit per frame → no RO loop warning
        ro.observe(doc.documentElement)
      }
    } catch {
      /* ignore */
    }
    // link handling (the sandbox would otherwise block navigation + log a console
    // error): plain click → system browser; Ctrl/Cmd+click → in-app web viewer;
    // right-click → context menu (internal / external). Coords are translated from
    // the iframe to the parent window so the menu lands under the cursor.
    doc.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href')
      const isHttp = /^https?:/i.test(href || '')
      a.addEventListener('click', (ev) => {
        ev.preventDefault()
        if (!isHttp) return
        // plain click → system browser (Chrome); Ctrl/Cmd+click → in-app web viewer
        // (auto-translates to the active language). Right-click gives the explicit menu.
        if (ev.ctrlKey || ev.metaKey) onOpenInternal?.(href, langRef.current)
        else api.openExternal?.(href)
      })
      a.addEventListener('contextmenu', (ev) => {
        if (!isHttp) return
        ev.preventDefault()
        const r = f.getBoundingClientRect()
        onLinkMenu?.({ x: r.left + ev.clientX, y: r.top + ev.clientY, url: href, lang: langRef.current })
      })
    })
    // text selection → floating ▶ that reads just the selected fragment. The iframe is
    // same-origin (allow-same-origin) and sized to its content (no inner scroll), so the
    // selection's iframe-local rect + the iframe's host rect = host viewport coords.
    const showSel = () => {
      const sel = doc.getSelection?.()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return setSelBtn(null)
      const text = sel.toString().trim()
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (!text || (!rect.width && !rect.height)) return setSelBtn(null)
      const fr = f.getBoundingClientRect()
      setSelBtn({ x: fr.left + rect.left + rect.width / 2, y: fr.top + rect.top, text })
    }
    doc.addEventListener('mouseup', () => requestAnimationFrame(showSel))
    doc.addEventListener('mousedown', () => setSelBtn(null))
    // Ctrl+wheel inside the body zooms the reader (events don't escape the iframe, so we
    // catch them here and tell the parent). passive:false so preventDefault stops page-zoom.
    doc.addEventListener(
      'wheel',
      (ev) => {
        if (!ev.ctrlKey) return
        ev.preventDefault()
        onZoom?.(ev.deltaY < 0 ? 5 : -5)
      },
      { passive: false }
    )
    // deferred external images (src was moved to data-osrc) → spinner, then the
    // backend downloads them and we swap the data: URL in place
    const ext = [...doc.querySelectorAll('img[data-osrc]')]
    if (!ext.length) return
    ext.forEach((img) => img.classList.add('imgld')) // per-image spinner inside the image's own box
    fit()
    Promise.resolve(api.mail?.inlineImages?.(m.html)).then((r) => {
      const map = r?.map || {}
      ext.forEach((img) => {
        const data = map[img.dataset.osrc]
        const done = () => {
          img.classList.remove('imgld')
          fit()
        }
        if (data) {
          img.addEventListener('load', done, { once: true })
          img.addEventListener('error', done, { once: true })
          img.src = data // spinner → real picture, in place
        } else {
          done() // couldn't download → just drop the spinner
        }
      })
      fit()
    })
  }

  // the iframe rides along when the reader scrolls, but the fixed ▶ wouldn't — so drop it
  // on any scroll/resize (re-select to get it back). Same idea as the browser/article cases.
  useEffect(() => {
    if (!selBtn) return
    const clear = () => setSelBtn(null)
    window.addEventListener('scroll', clear, true)
    window.addEventListener('resize', clear)
    return () => {
      window.removeEventListener('scroll', clear, true)
      window.removeEventListener('resize', clear)
    }
  }, [selBtn])

  const playSel = () => {
    if (!selBtn?.text) return
    speakSelection(selBtn.text, 'auto') // body language unknown (original or translated) → detect
    setSelBtn(null)
    iframeRef.current?.contentDocument?.getSelection?.()?.removeAllRanges?.()
  }

  return (
    <div className={'mail-msg' + (open ? ' mail-msg--open' : '')}>
      <SelectionPlayButton pos={selBtn} title={t('mail.readAloud')} onPlay={playSel} />
      <div className="mail-msg__head" onClick={() => { setHasOpened(true); setOpen((o) => !o) }}>
        <span className="mail-msg__avatar">{monogram(who)}</span>
        {/* the spans are only as wide as their text (CSS align-items:flex-start), so the
            empty space inside this block stays clickable and toggles the message. When open,
            clicking the name/recipient itself does NOT collapse (so you can select/copy it);
            when collapsed, clicking anywhere (incl. the preview) expands. */}
        <div className="mail-msg__who">
          <span className="mail-msg__from" onClick={open ? (e) => e.stopPropagation() : undefined}>{who}</span>
          {open ? (
            <span className="mail-msg__to" onClick={(e) => e.stopPropagation()}>{t('mail.to')} {m.to}</span>
          ) : (
            <span className="mail-msg__preview">{preview}</span>
          )}
        </div>
        <MailAttachBadge attachments={m.attachments} account={account} />
        <span className="mail-msg__date">{date}</span>
        <button
          className={'mail-msg__star' + (starred ? ' is-on' : '')}
          title={t('mail.star')}
          onClick={(e) => {
            e.stopPropagation()
            onToggleStar?.()
          }}
        >
          <StarIcon />
        </button>
      </div>

      {hasOpened && (
        <div className="mail-msg__open" hidden={!open}>
          <div className="mail-msg__toolbar">
            <button className="mail-msg__details-btn" onClick={() => setDetails((d) => !d)}>
              {t('mail.details')} {details ? '▴' : '▾'}
            </button>
            {html && (
              <>
                <select className="mail-msg__lang" value={lang} onChange={(e) => pickLang(e.target.value)} disabled={translating}>
                  <option value="original">{t('mail.showOriginal')}</option>
                  {LANGS.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
                {translating && <span className="mail-spinner mail-spinner--sm" />}
                {trError && <span className="mail-msg__tr-error">⚠ {trError}</span>}
              </>
            )}
          </div>
          {details && (
            <div className="mail-msg__details">
              <div><span>{t('mail.from')}</span> {who}{m.fromEmail ? ` <${m.fromEmail}>` : ''}</div>
              {m.replyTo && <div><span>{t('mail.replyTo')}</span> {m.replyTo}</div>}
              <div><span>{t('mail.to')}</span> {m.to}</div>
              <div><span>{t('mail.date')}</span> {date}</div>
              {m.subject && <div><span>{t('mail.subject')}</span> {m.subject}</div>}
              {m.mailedBy && <div><span>{t('mail.mailedBy')}</span> {m.mailedBy}</div>}
              {m.signedBy && <div><span>{t('mail.signedBy')}</span> {m.signedBy}</div>}
            </div>
          )}
          {/* zoom wraps ONLY the body (iframe + its content, or the plain-text body) — the
              header, toolbar and actions stay at their normal size */}
          <div className="mail-msg__bodyzoom" style={{ zoom: (zoom || 100) / 100 }}>
            {html ? (
              <iframe ref={iframeRef} className="mail-msg__html" sandbox="allow-same-origin" srcDoc={HEAD + html} title="message" onLoad={onLoad} />
            ) : (
              <div className="mail-msg__body">{m.text}</div>
            )}
          </div>
          {m.attachments?.length > 0 && (
            <div className="mail-msg__attachments">
              {m.attachments.map((a, i) => (
                <MailAttachChip key={i} file={a} account={account} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
