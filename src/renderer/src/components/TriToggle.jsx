import './TriToggle.css'

// A small three-position toggle: off (✕) — auto (•) — on (✓), with a sliding
// knob. `value` is false | undefined | true; clicking a segment sets that state
// (undefined = auto/inherit). `titles` provides a tooltip per segment.
export default function TriToggle({ value, onChange, titles }) {
  const state = value === undefined ? 'auto' : value ? 'on' : 'off'
  return (
    <div className={`tri-toggle tri-toggle--${state}`} role="radiogroup">
      <button type="button" className="tri-toggle__seg" title={titles?.off} onClick={() => onChange(false)}>
        ✕
      </button>
      <button type="button" className="tri-toggle__seg" title={titles?.auto} onClick={() => onChange(undefined)}>
        •
      </button>
      <button type="button" className="tri-toggle__seg" title={titles?.on} onClick={() => onChange(true)}>
        ✓
      </button>
      <span className="tri-toggle__knob" aria-hidden />
    </div>
  )
}
