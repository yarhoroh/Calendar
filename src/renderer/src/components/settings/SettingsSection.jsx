import './Settings.css'

// A titled group of setting rows. Reuse for every settings category.
// `footer` renders inside the section, just below the body (outside it).
export default function SettingsSection({ title, children, footer }) {
  return (
    <section className="settings-section">
      {title && <h2 className="settings-section__title">{title}</h2>}
      <div className="settings-section__body">{children}</div>
      {footer}
    </section>
  )
}
