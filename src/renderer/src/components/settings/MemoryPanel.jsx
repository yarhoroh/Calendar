import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { useI18n } from '../../i18n/I18nContext'

// The AI's memory: lasting facts/preferences. The user can add and delete lines
// here; the AI also writes here via the "remember" action.
export default function MemoryPanel() {
  const { t } = useI18n()
  const [rows, setRows] = useState([])
  const [text, setText] = useState('')

  const load = () => Promise.resolve(api.getMemory?.()).then((r) => setRows(r || []))
  useEffect(() => {
    load()
    const off = api.onAiDataChanged?.(load)
    return () => off?.()
  }, [])

  const add = async () => {
    const v = text.trim()
    if (!v) return
    await api.addMemory?.(v)
    setText('')
    load()
  }
  const del = async (id) => {
    await api.deleteMemory?.(id)
    load()
  }

  return (
    <>
      <div className="ai-list">
        {rows.length === 0 && <div className="ai-list__empty">{t('settings.memoryEmpty')}</div>}
        {rows.map((r) => (
          <div className="ai-list__row" key={r.id}>
            <div className="ai-list__body">
              <div className="ai-list__text">{r.text}</div>
            </div>
            <button className="ai-list__del" title={t('settings.delete')} onClick={() => del(r.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="ai-add">
        <input
          className="ai-add__input"
          placeholder={t('settings.memoryAdd')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn btn--primary" onClick={add}>
          {t('settings.add')}
        </button>
      </div>
    </>
  )
}
