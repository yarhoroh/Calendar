import { useEffect, useState } from 'react'
import api from '../lib/api'

// Owns the visual SKIN (design language), a dimension separate from light/dark theme: 'classic'
// (default) or 'apple'. Applies it to <html data-skin> and persists through the IPC bridge. Composes
// with useTheme — apple+dark and apple+light both resolve in CSS. 'classic' clears the attribute.
export function useSkin() {
  const [skin, setSkin] = useState('classic')

  useEffect(() => {
    Promise.resolve(api.getSkin?.()).then((saved) => {
      if (!saved) return
      setSkin(saved)
      apply(saved)
    })
  }, [])

  const apply = (next) => {
    if (next === 'classic') delete document.documentElement.dataset.skin
    else document.documentElement.dataset.skin = next
  }

  const applySkin = (next) => {
    if (next !== 'classic' && next !== 'apple') return
    apply(next)
    api.setSkin?.(next)
    setSkin(next)
  }

  return { skin, applySkin }
}
