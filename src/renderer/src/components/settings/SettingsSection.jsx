import './Settings.css'

// A titled group of setting rows. Reuse for every settings category.
export default function SettingsSection({ title, children }) {
  return (
    <section className="settings-section">
      {title && <h2 className="settings-section__title">{title}</h2>}
      <div className="settings-section__body">{children}</div>
    </section>
  )
}
