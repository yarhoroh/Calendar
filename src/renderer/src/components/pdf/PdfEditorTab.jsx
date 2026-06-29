import { useEffect, useState } from 'react'
import PdfEditor from './PdfEditor'
import api from '../../lib/api'

const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()

// Feeds one open tab into our themed PdfEditor: reads the file's bytes from disk, opens them
// (source prop), saves the edited document back to the same path, and "save as new" writes a
// new file in the SAME folder and opens it (onOpenPath). One instance per tab → each PDF keeps
// its own editing state.
export default function PdfEditorTab({ path, onOpenPath, onDirty }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setData(null)
    setError(null)
    Promise.resolve(api.pdf?.read?.(path)).then((r) => {
      if (!alive) return
      if (r?.ok) setData(r.data)
      else setError(r?.error || 'read failed')
    })
    return () => {
      alive = false
    }
  }, [path])

  const onSave = async (bytes) => {
    await api.pdf?.write?.(path, bytes) // bake the edited PDF back over the original file
  }
  // save under a new name in the SAME folder as the current file, then open it in a tab
  const onSaveAs = async (bytes, name) => {
    const sep = path.lastIndexOf('\\') >= path.lastIndexOf('/') ? '\\' : '/'
    const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
    const dir = cut >= 0 ? path.slice(0, cut) : ''
    const fname = /\.pdf$/i.test(name) ? name : name + '.pdf'
    const newPath = (dir ? dir + sep : '') + fname
    const r = await api.pdf?.write?.(newPath, bytes)
    if (r?.ok) onOpenPath?.(newPath)
  }

  if (error) return <div className="pdf-editor__msg">{error}</div>
  if (!data) return <div className="pdf-editor__msg">…</div>
  return <PdfEditor source={data} fileName={baseName(path)} onSave={onSave} onSaveAs={onSaveAs} onDirty={(d) => onDirty?.(path, d)} />
}
