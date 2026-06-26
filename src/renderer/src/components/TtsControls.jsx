import { useSyncExternalStore } from 'react'
import { getTtsState, subscribeTts, ttsAction } from '../lib/ttsBridge'
import { PlayIcon, PauseIcon, StopIcon, NextIcon } from './icons'
import { useI18n } from '../i18n/I18nContext'

// Global TTS playback controls in the title bar — visible only while something is
// speaking (from anywhere: /speak server, Telegram, AI, or the article reader).
// pause/resume, next (when a queue exists), and stop (aborts the whole queue).
export default function TtsControls() {
  const { t } = useI18n()
  const st = useSyncExternalStore(subscribeTts, getTtsState)
  if (st.status === 'idle') return null
  return (
    <>
      {st.status === 'paused' ? (
        <button className="winbtn" title={t('tts.resume')} onClick={() => ttsAction('resume')}>
          <PlayIcon />
        </button>
      ) : (
        <button className="winbtn" title={t('tts.pause')} onClick={() => ttsAction('pause')}>
          <PauseIcon />
        </button>
      )}
      {st.queueLen > 0 && (
        <button className="winbtn" title={t('tts.next')} onClick={() => ttsAction('next')}>
          <NextIcon />
        </button>
      )}
      <button className="winbtn winbtn--tts-stop" title={t('tts.stop')} onClick={() => ttsAction('stop')}>
        <StopIcon />
      </button>
    </>
  )
}
