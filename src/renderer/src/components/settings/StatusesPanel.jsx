import { useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { useStatuses } from '../../hooks/useStatuses'

// Manage user-defined note statuses (name + colour). Built-in statuses
// (To do / In progress / Done) are fixed and not listed here.
export default function StatusesPanel() {
  const { t } = useI18n()
  const { statuses, add, update, remove } = useStatuses()
  const [name, setName] = useState('')
  const [color, setColor] = useState('#4caf50')

  const onAdd = async () => {
    const v = name.trim()
    if (!v) return
    await add(v, color)
    setName('')
  }

  return (
    <>
      <div className="ai-list">
        {statuses.length === 0 && <div className="ai-list__empty">{t('settings.statusesEmpty')}</div>}
        {statuses.map((s) => (
          <div className="ai-list__row status-row" key={s.id}>
            <input
              type="color"
              className="status-color"
              value={s.color}
              onChange={(e) => update(s.id, { color: e.target.value })}
            />
            <div className="ai-list__body">
              <input
                className="ai-add__input"
                style={{ width: '100%' }}
                key={s.id + s.name}
                defaultValue={s.name}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && v !== s.name) update(s.id, { name: v })
                }}
                onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
              />
            </div>
            <button className="ai-list__del" title={t('settings.delete')} onClick={() => remove(s.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="ai-add">
        <input type="color" className="status-color" value={color} onChange={(e) => setColor(e.target.value)} />
        <input
          className="ai-add__input"
          placeholder={t('settings.statusAdd')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onAdd()}
        />
        <button className="btn btn--primary" onClick={onAdd}>
          {t('settings.add')}
        </button>
      </div>
    </>
  )
}
