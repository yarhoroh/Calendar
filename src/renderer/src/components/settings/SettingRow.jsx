// One setting: label + description on the left, a control on the right.
export default function SettingRow({ title, description, children }) {
  return (
    <div className="setting-row">
      <div className="setting-row__info">
        <div className="setting-row__title">{title}</div>
        {description && (
          <div className="setting-row__desc" title={description}>
            {description}
          </div>
        )}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  )
}
