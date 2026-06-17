import Image from '@tiptap/extension-image'
import { mergeAttributes } from '@tiptap/core'

// A capable inline image for the note editor, built on the official Image
// extension (no buggy third-party resize plugin):
//   • inline node — flows inside text, sits between letters / beside words
//   • resize by a corner handle (persists only `width`, never a stray opacity)
//   • align: inline | left | right (float, text wraps) | center (own line)
//   • base64 sources allowed (our images are inline data URLs)
const clampW = (w) => Math.max(40, Math.round(w))
const ALIGNS = [
  ['inline', '⊟', 'in text'],
  ['left', '◧', 'wrap left'],
  ['center', '▭', 'center'],
  ['right', '◨', 'wrap right']
]

const RichImage = Image.extend({
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      width: {
        default: null,
        parseHTML: (el) => {
          const m = (el.getAttribute('style') || '').match(/width:\s*([\d.]+)px/)
          if (m) return Math.round(parseFloat(m[1]))
          const w = el.getAttribute('width')
          return w ? parseInt(w, 10) : null
        }
      },
      align: {
        default: 'inline',
        parseHTML: (el) => el.getAttribute('data-align') || 'inline'
      }
    }
  },

  // serialised form (also used for any non-editor rendering): only width + align
  renderHTML({ HTMLAttributes }) {
    const { width, align, ...rest } = HTMLAttributes
    let style = ''
    if (width) style += `width:${width}px;`
    if (align === 'left') style += 'float:left;margin:2px 12px 6px 0;'
    else if (align === 'right') style += 'float:right;margin:2px 0 6px 12px;'
    else if (align === 'center') style += 'display:block;margin:6px auto;'
    return ['img', mergeAttributes(rest, { 'data-align': align || 'inline', style: style || null })]
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const wrap = document.createElement('span')
      wrap.className = 'ri-img'
      wrap.dataset.align = node.attrs.align || 'inline'

      const img = document.createElement('img')
      img.src = node.attrs.src
      if (node.attrs.alt) img.alt = node.attrs.alt
      const applyWidth = () => (img.style.width = current.attrs.width ? current.attrs.width + 'px' : '')
      applyWidth()
      wrap.appendChild(img)

      const setAttr = (patch) => {
        if (typeof getPos !== 'function') return
        editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeMarkup(getPos(), undefined, { ...current.attrs, ...patch })
            return true
          })
          .run()
      }

      // corner resize handle (shown when selected)
      const handle = document.createElement('span')
      handle.className = 'ri-img__handle'
      wrap.appendChild(handle)
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const startX = e.clientX
        const startW = img.getBoundingClientRect().width
        const onMove = (ev) => (img.style.width = clampW(startW + (ev.clientX - startX)) + 'px')
        const onUp = (ev) => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          setAttr({ width: clampW(startW + (ev.clientX - startX)) })
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      })

      // alignment toolbar (shown when selected)
      const bar = document.createElement('span')
      bar.className = 'ri-img__bar'
      ALIGNS.forEach(([a, glyph, title]) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = glyph
        b.title = title
        b.addEventListener('mousedown', (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          setAttr({ align: a })
        })
        bar.appendChild(b)
      })
      wrap.appendChild(bar)

      return {
        dom: wrap,
        selectNode: () => wrap.classList.add('ri-img--selected'),
        deselectNode: () => wrap.classList.remove('ri-img--selected'),
        update: (updated) => {
          if (updated.type.name !== current.type.name) return false
          current = updated
          img.src = updated.attrs.src
          wrap.dataset.align = updated.attrs.align || 'inline'
          applyWidth()
          return true
        }
      }
    }
  }
}).configure({ inline: true, allowBase64: true })

export default RichImage
