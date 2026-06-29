import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { SpeakerIcon, PlayIcon, PauseIcon, StopIcon, NextIcon, ChevronLeftIcon } from '../icons'
import { speakArticle, ttsAction, subscribeTts, getTtsState } from '../../lib/ttsBridge'
import { splitForTts, speakSelection } from '../../lib/selectionSpeak'
import SelectionPlayButton from './SelectionPlayButton'
import './ArticleReader.css'

const TTS_LANG = { ru: 'ru', uk: 'uk', en: 'en', Russian: 'ru', Ukrainian: 'uk', English: 'en' }

// Standalone in-app reader the AI opens with showReader: shows a finished (already
// translated/summarized) article and reads it aloud. Read-aloud feeds the GLOBAL TTS queue
// (ttsBridge) and chunks long text itself (splitForTts) — the AI just hands over the whole
// text. `speak` auto-starts reading on open.
export default function ArticleReader({ title, text, lang, speak, onClose }) {
  const { t } = useI18n()
  const ttsState = useSyncExternalStore(subscribeTts, getTtsState)
  const [starting, setStarting] = useState(false)
  const [selBtn, setSelBtn] = useState(null) // floating ▶ over a text selection
  const bodyRef = useRef(null)
  const ttsLang = TTS_LANG[lang] || 'auto'

  const readAloud = () => {
    const chunks = splitForTts(text || '')
    if (!chunks.length) return
    setStarting(true)
    speakArticle(chunks, ttsLang) // ttsBridge chunks/queues; survives closing the reader
  }
  const stopRead = () => {
    ttsAction('stop')
    setStarting(false)
  }

  // auto-start reading once if the AI asked to read it aloud
  const autoDone = useRef(false)
  useEffect(() => {
    if (speak && !autoDone.current && text) {
      autoDone.current = true
      readAloud()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // first clip started (or playback ended) → drop the "preparing" spinner
  useEffect(() => {
    if (ttsState.status !== 'idle') setStarting(false)
  }, [ttsState.status])

  // floating ▶ over a text selection → speak just that fragment
  const updateSelBtn = () => {
    const sel = window.getSelection?.()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return setSelBtn(null)
    const node = sel.anchorNode
    if (!bodyRef.current || !node || !bodyRef.current.contains(node)) return setSelBtn(null)
    const text = sel.toString().trim()
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    if (!text || (!rect.width && !rect.height)) return setSelBtn(null)
    setSelBtn({ x: rect.left + rect.width / 2, y: rect.top, text })
  }
  const playSelection = () => {
    if (!selBtn?.text) return
    setStarting(true)
    speakSelection(selBtn.text, ttsLang === 'auto' ? 'auto' : ttsLang)
    setSelBtn(null)
    window.getSelection?.()?.removeAllRanges?.()
  }
  useEffect(() => {
    const onSelChange = () => {
      const sel = window.getSelection?.()
      if (!sel || sel.isCollapsed) setSelBtn(null)
    }
    document.addEventListener('selectionchange', onSelChange)
    return () => document.removeEventListener('selectionchange', onSelChange)
  }, [])

  const playing = ttsState.status === 'playing' || ttsState.status === 'paused'

  return (
    <div className="art-reader">
      <div className="art-reader__bar">
        <button className="art-reader__back" onClick={onClose} title={t('mail.back')}>
          <ChevronLeftIcon /> {t('mail.back')}
        </button>
        <span className="art-reader__title">{title || ''}</span>
        <div className="art-reader__tts">
          {starting && ttsState.status === 'idle' ? (
            <>
              <button className="art-reader__btn art-reader__btn--prep" disabled title={t('mail.preparing')}>
                <span className="mail-spinner mail-spinner--white" />
              </button>
              <button className="art-reader__btn art-reader__btn--stop" onClick={stopRead} title={t('mail.stop')}>
                <StopIcon />
              </button>
            </>
          ) : playing ? (
            <>
              <button
                className="art-reader__btn"
                onClick={() => ttsAction(ttsState.status === 'playing' ? 'pause' : 'resume')}
                title={ttsState.status === 'playing' ? t('mail.pause') : t('mail.resume')}
              >
                {ttsState.status === 'playing' ? <PauseIcon /> : <PlayIcon />}
              </button>
              {ttsState.queueLen > 0 && (
                <button className="art-reader__btn" onClick={() => ttsAction('next')} title={t('tts.next')}>
                  <NextIcon />
                </button>
              )}
              <button className="art-reader__btn art-reader__btn--stop" onClick={stopRead} title={t('mail.stop')}>
                <StopIcon />
              </button>
            </>
          ) : (
            <button className="art-reader__btn" onClick={readAloud} title={t('mail.readAloud')}>
              <SpeakerIcon />
            </button>
          )}
        </div>
      </div>

      <div className="art-reader__body" ref={bodyRef} onMouseUp={() => requestAnimationFrame(updateSelBtn)} onScroll={() => selBtn && updateSelBtn()}>
        <article className="art-reader__article">
          {title && <h1>{title}</h1>}
          {(text || '').split('\n').map((line, i) => (line.trim() ? <p key={i}>{line}</p> : <br key={i} />))}
        </article>
      </div>

      <SelectionPlayButton pos={selBtn} title={t('mail.readAloud')} onPlay={playSelection} />
    </div>
  )
}
