// One setting: label + description on the left, a control on the right. `stacked`
// drops the control onto its own full-width line below the title (for wide controls).
export default function SettingRow({ title, description, children, stacked }) {
  return (
    <div className={'setting-row' + (stacked ? ' setting-row--stacked' : '')}>
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
