import { useEffect, useState } from 'react'
import PdfEditor from './PdfEditor'
import api from '../../lib/api'

// Reads the tab's PDF bytes from disk and feeds them to the viewer. Editing/saving is rebuilt
// feature-by-feature on top of the new engine.
export default function PdfEditorTab({ path }) {
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

  if (error) return <div className="pdf-editor__msg">{error}</div>
  if (!data) return <div className="pdf-editor__msg">…</div>
  return <PdfEditor source={data} />
}
