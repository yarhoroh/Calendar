import './StatusDot.css'

// Small colored status indicator. tone: 'green' | 'red' | 'amber' | 'muted'.
export default function StatusDot({ tone = 'muted', pulse = false }) {
  return <span className={`status-dot status-dot--${tone}${pulse ? ' status-dot--pulse' : ''}`} />
}
