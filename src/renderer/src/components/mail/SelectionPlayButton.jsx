import { PlayIcon } from '../icons'

// Tiny ▶ that floats above a text selection and speaks it on click. `pos` is the
// selection's position in HOST VIEWPORT coords ({ x: horizontal center, y: top });
// the button is position:fixed and centers itself just above that point. mouseDown is
// prevented so clicking it doesn't collapse the selection before the host reads it.
// Render it (with pos != null) wherever a selection should be speakable.
export default function SelectionPlayButton({ pos, title, onPlay }) {
  if (!pos) return null
  return (
    <button
      className="sel-speak-btn"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => {
        e.preventDefault()
        onPlay()
      }}
      title={title}
    >
      <PlayIcon />
    </button>
  )
}
