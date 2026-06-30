import { useEffect, useRef, useState } from 'react'
import { ZoomInIcon, ZoomOutIcon } from '../icons'
import { useI18n } from '../../i18n/I18nContext'
import { createPdfEngine } from './pdfEngine'
import './PdfEditor.css'

// PDF viewer — open a document and render its pages. Editing features get rebuilt on top of this
// one at a time. Ctrl+wheel zooms; pages re-render crisply at the new scale.
export default function PdfEditor({ source }) {
  const { t } = useI18n()
  const [pages, setPages] = useState([])
  const [pageCount, setPageCount] = useState(0)
  const [scale, setScale] = useState(1.5)
  const [status, setStatus] = useState('idle')
  const engineRef = useRef(null)
  const urlsRef = useRef([])
  const viewportRef = useRef(null)

  const revoke = () => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u)
    urlsRef.current = []
  }

  // one engine (worker) per mounted tab
  useEffect(() => {
    engineRef.current = createPdfEngine()
    return () => {
      engineRef.current?.dispose()
      revoke()
    }
  }, [])

  // open the document when bytes arrive
  useEffect(() => {
    if (source === undefined || !engineRef.current) return
    let alive = true
    setStatus('loading')
    Promise.resolve(engineRef.current.open(source))
      .then((info) => {
        if (alive) setPageCount(info?.pageCount || 0)
      })
      .catch(() => alive && setStatus('error'))
    return () => {
      alive = false
    }
  }, [source])

  // render all pages whenever the doc opens or the zoom changes
  useEffect(() => {
    if (!pageCount || !engineRef.current) return
    let alive = true
    setStatus('loading')
    ;(async () => {
      const out = []
      for (let i = 0; i < pageCount; i++) {
        const r = await engineRef.current.renderPage(i, scale)
        if (!alive) return
        const url = URL.createObjectURL(new Blob([r.png], { type: 'image/png' }))
        out.push({ pageIndex: i, width: r.width, height: r.height, url })
      }
      if (!alive) {
        for (const p of out) URL.revokeObjectURL(p.url)
        return
      }
      revoke()
      urlsRef.current = out.map((p) => p.url)
      setPages(out)
      setStatus('ready')
    })().catch(() => alive && setStatus('error'))
    return () => {
      alive = false
    }
  }, [pageCount, scale])

  // Ctrl + wheel zoom (non-passive so we cancel the browser/page zoom)
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setScale((s) => Math.min(10, Math.max(0.3, s * (e.deltaY < 0 ? 1.12 : 1 / 1.12))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const statusText =
    status === 'loading'
      ? t('pdfed.loading')
      : status === 'error'
        ? t('pdfed.error')
        : pageCount
          ? `${pageCount} ${t('pdfed.pages')}`
          : ''

  return (
    <div className="pdfed">
      <div className="pdfed__toolbar">
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.max(0.3, s / 1.15))} title={t('pdfed.zoomOut')}>
          <ZoomOutIcon />
        </button>
        <span className="pdfed__zoom">{Math.round(scale * 100)}%</span>
        <button className="pdfed__btn" onClick={() => setScale((s) => Math.min(10, s * 1.15))} title={t('pdfed.zoomIn')}>
          <ZoomInIcon />
        </button>
        <span className="pdfed__spacer" />
        <span className="pdfed__status">{statusText}</span>
      </div>

      <div className="pdfed__viewport" ref={viewportRef}>
        <div className="pdfed__pages">
          {pages.map((p) => (
            <div key={p.pageIndex} className="pdfed__page" style={{ width: p.width * scale, height: p.height * scale }}>
              <img
                src={p.url}
                width={p.width * scale}
                height={p.height * scale}
                className="pdfed__pageimg"
                alt={`${t('pdfed.page')} ${p.pageIndex + 1}`}
                draggable={false}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
