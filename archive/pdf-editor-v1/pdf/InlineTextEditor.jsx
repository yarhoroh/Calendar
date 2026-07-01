import { useEffect, useMemo, useRef, useState } from 'react'

// WYSIWYG inline editor drawn over a text object (the worker has hidden the original glyphs). Each
// original run is seeded as a styled <span>; a selection can be re-styled (bold/italic/font/size/
// colour). On commit we read the styled spans back into runs and the worker rebuilds the PDF block.
const rgbToHex = (rgb) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '')
  return m ? '#' + [1, 2, 3].map((i) => (+m[i]).toString(16).padStart(2, '0')).join('') : '#000000'
}
const firstFamily = (ff) => (ff || '').split(',')[0].replace(/["']/g, '').trim()

export default function InlineTextEditor({ obj, scale, fontList = [], embeddedFaces, onCancel, onCommit }) {
  const ref = useRef(null)
  const seed = obj.lines?.[0]?.runs?.[0] || { size: 12, color: '#000000', fontName: 'Arial' }
  const [tool, setTool] = useState({ fontName: firstFamily(seed.fontName), size: seed.size, color: seed.color })
  // real font name → loaded @font-face family (for 1:1 glyphs) and the reverse (to read runs back)
  const cssFamilyFor = (name) => embeddedFaces?.get(firstFamily(name)) || firstFamily(name)
  const realNameFor = useMemo(() => {
    const m = new Map()
    if (embeddedFaces) for (const [real, css] of embeddedFaces) m.set(css, real)
    return m
  }, [embeddedFaces])

  // seed the editable box with one styled span per run, once
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.innerHTML = ''
    ;(obj.lines || []).forEach((ln, li) => {
      for (const r of ln.runs) {
        const span = document.createElement('span')
        span.textContent = r.text
        span.style.fontFamily = `'${cssFamilyFor(r.fontName)}'`
        span.style.fontSize = r.size * scale + 'px'
        span.style.color = r.color
        span.style.fontWeight = r.bold ? '700' : '400'
        span.style.fontStyle = r.italic ? 'italic' : 'normal'
        if (r.underline) span.style.textDecoration = 'underline'
        // Tz horizontal scale → scaleX; pivot at the baseline-left so it grows like PDF does
        if (r.hScale && Math.abs(r.hScale - 1) > 0.001) {
          span.style.display = 'inline-block'
          span.style.transform = `scaleX(${r.hScale})`
          span.style.transformOrigin = 'left bottom'
        }
        if (r.vAlign === 'super') span.style.verticalAlign = 'super'
        else if (r.vAlign === 'sub') span.style.verticalAlign = 'sub'
        el.appendChild(span)
      }
      if (li < obj.lines.length - 1) el.appendChild(document.createTextNode(' '))
    })
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // wrap the current selection in a span carrying the style patch (keeps caret usable via MouseDown)
  const wrap = (patch) => {
    const el = ref.current
    const sel = window.getSelection()
    if (!el || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    if (range.collapsed) return
    const span = document.createElement('span')
    Object.assign(span.style, patch)
    try {
      range.surroundContents(span)
    } catch (_) {
      span.appendChild(range.extractContents())
      range.insertNode(span)
    }
    el.focus()
  }

  const collectRuns = () => {
    const el = ref.current
    const runs = []
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walk.nextNode())) {
      const text = n.nodeValue
      if (!text) continue
      const cs = getComputedStyle(n.parentElement)
      const fam = firstFamily(cs.fontFamily)
      const run = {
        text,
        fontName: realNameFor.get(fam) || fam, // map @font-face family back to the PDF font name

        size: Math.round((parseFloat(cs.fontSize) / scale) * 100) / 100,
        color: rgbToHex(cs.color),
        bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
        italic: cs.fontStyle === 'italic',
      }
      const last = runs[runs.length - 1]
      if (last && last.fontName === run.fontName && last.size === run.size && last.color === run.color && last.bold === run.bold && last.italic === run.italic)
        last.text += text
      else runs.push(run)
    }
    return runs.filter((r) => r.text.length)
  }

  const box = useMemo(() => {
    // anchor the box so the first line's TEXT baseline lands on the PDF baseline (≈ ascent above it),
    // not the glyph-box top — this stops the editor text from sitting lower/higher than the original
    const baseline = obj.lines?.[0]?.baseline ?? Math.min(...obj.lines.map((l) => l.y))
    const fontPx = seed.size * scale
    return {
      left: obj.x * scale,
      top: baseline * scale - fontPx * 0.8, // 0.8 ≈ typical ascent ratio
      minWidth: obj.width * scale,
      fontSize: fontPx,
      letterSpacing: (obj.pdf?.tc || 0) * scale, // Tc → CSS letter-spacing
    }
  }, [obj, scale, seed.size])

  const btn = (label, patch, key) => (
    <button
      type="button"
      className="pdfed__ibtn"
      title={label}
      onMouseDown={(e) => {
        e.preventDefault()
        wrap(patch)
      }}
    >
      {key}
    </button>
  )

  return (
    <div className="pdfed__inline" style={{ left: box.left, top: box.top }}>
      <div className="pdfed__ibar" onMouseDown={(e) => e.preventDefault()}>
        {btn('Bold', { fontWeight: '700' }, <b>B</b>)}
        {btn('Italic', { fontStyle: 'italic' }, <i>I</i>)}
        <select
          className="pdfed__isel"
          value={tool.fontName}
          onChange={(e) => {
            setTool((t) => ({ ...t, fontName: e.target.value }))
            wrap({ fontFamily: `'${e.target.value}'` })
          }}
        >
          {!fontList.some((f) => f.family === tool.fontName) && <option value={tool.fontName}>{tool.fontName}</option>}
          {fontList.map((f) => (
            <option key={f.family} value={f.family}>
              {f.family}
            </option>
          ))}
        </select>
        <select
          className="pdfed__isel pdfed__isel--sz"
          value={tool.size}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            setTool((t) => ({ ...t, size: v }))
            wrap({ fontSize: v * scale + 'px' })
          }}
        >
          {[...new Set([tool.size, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72])]
            .filter((n) => Number.isFinite(n))
            .sort((a, b) => a - b)
            .map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
        </select>
        <input
          className="pdfed__icolor"
          type="color"
          value={tool.color}
          onChange={(e) => {
            setTool((t) => ({ ...t, color: e.target.value }))
            wrap({ color: e.target.value })
          }}
        />
        <span className="pdfed__ispring" />
        <button type="button" className="pdfed__ibtn pdfed__ibtn--ok" title="OK" onClick={() => onCommit(collectRuns())}>
          ✓
        </button>
        <button type="button" className="pdfed__ibtn" title="Cancel" onClick={onCancel}>
          ✕
        </button>
      </div>
      <div
        ref={ref}
        className="pdfed__ibox"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        style={{ minWidth: box.minWidth, lineHeight: box.fontSize + 'px', letterSpacing: box.letterSpacing + 'px' }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          e.stopPropagation()
        }}
      />
    </div>
  )
}
