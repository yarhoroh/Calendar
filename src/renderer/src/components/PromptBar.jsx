import { useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { useAutosizeTextarea } from '../hooks/useAutosizeTextarea'
import { useAiStatus } from '../hooks/useAiStatus'
import { SendIcon } from './icons'
import './PromptBar.css'

// Read an image File/Blob into the { media_type, data } shape the AI expects.
const fileToImage = (file) =>
  new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => {
      const [head, data] = String(r.result).split(',')
      resolve({ media_type: head.match(/data:(.*?);/)?.[1] || 'image/png', data, name: file.name || 'image' })
    }
    r.readAsDataURL(file)
  })

// Chat input. Enter sends, Ctrl+Enter inserts a new line. Sending is handled by
// the parent (useChat); while a reply is pending the send button is disabled.
export default function PromptBar({ onSend, busy }) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [images, setImages] = useState([])
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef(null)
  const ref = useAutosizeTextarea(text, 8)
  const { state, cli, model } = useAiStatus()
  const statusLabel =
    state === 'ready' ? t('chat.ready') : state === 'offline' ? t('chat.offline') : t('chat.starting')
  const cliLabel = { gemini: 'Gemini', claude: 'Claude', codex: 'Codex' }[cli] || 'Gemini'
  const modelLabel = model && model !== 'default' && model !== 'auto' ? ` · ${model}` : ''

  const canSend = (text.trim().length > 0 || images.length > 0) && !busy

  const addFiles = async (files) => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    const loaded = await Promise.all(imgs.map(fileToImage))
    setImages((prev) => [...prev, ...loaded])
  }

  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean)
    if (files.length) {
      e.preventDefault()
      addFiles(files)
    }
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
  }

  const onDragOver = (e) => {
    if ([...(e.dataTransfer?.items || [])].some((it) => it.kind === 'file')) {
      e.preventDefault()
      setDragging(true)
    }
  }

  const submit = () => {
    if (!canSend) return
    onSend(text, images)
    setText('')
    setImages([])
  }

  const insertNewline = () => {
    const el = ref.current
    const start = el.selectionStart
    const end = el.selectionEnd
    setText((prev) => prev.slice(0, start) + '\n' + prev.slice(end))
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 1
    })
  }

  const onKeyDown = (e) => {
    if (e.key !== 'Enter') return
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      insertNewline()
    } else if (!e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="promptbar">
      {images.length > 0 && (
        <div className="promptbar__thumbs">
          {images.map((im, i) => (
            <div key={i} className="promptbar__thumb">
              <img src={`data:${im.media_type};base64,${im.data}`} alt={im.name} />
              <button
                className="promptbar__thumb-x"
                title={t('prompt.removeImage')}
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`promptbar__box${dragging ? ' promptbar__box--drag' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
      >
        <button
          className="promptbar__attach"
          title={t('prompt.attachImage')}
          onClick={() => fileRef.current?.click()}
        >
          +
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <span className="promptbar__engine" title={statusLabel}>
          <span className={`promptbar__dot promptbar__dot--${state}`} />
          {cliLabel}
          {modelLabel}
        </span>
        <textarea
          ref={ref}
          className="promptbar__input"
          rows={1}
          placeholder={t('prompt.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button
          className="promptbar__send"
          title={t('prompt.send')}
          onClick={submit}
          disabled={!canSend}
        >
          <SendIcon />
        </button>
      </div>
    </div>
  )
}
