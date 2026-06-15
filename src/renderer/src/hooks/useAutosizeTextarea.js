import { useLayoutEffect, useRef } from 'react'

// Grows a <textarea> with its content up to `maxRows`, then enables scrolling.
// Returns a ref to attach to the textarea.
export function useAutosizeTextarea(value, maxRows = 8) {
  const ref = useRef(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    el.style.height = 'auto'

    const styles = getComputedStyle(el)
    const lineHeight = parseFloat(styles.lineHeight) || 20
    const paddingY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom)
    const maxHeight = lineHeight * maxRows + paddingY

    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [value, maxRows])

  return ref
}
