import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'

const cleanFont = (n) => (n || '').replace(/^[A-Z]{6}\+/, '').replace(/^CIDFont\+/, '') || ''
const round2 = (n) => Math.round((n || 0) * 100) / 100
const SIZES = [6, 7, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 60, 72]
const LINE_OPTS = [1, 1.15, 1.2, 1.25, 1.3, 1.5, 1.75, 2, 2.5, 3]
const PARA_OPTS = [0, 2, 3, 4, 6, 8, 10, 12, 14, 18, 24, 36]
const HSCALE_OPTS = [50, 75, 90, 95, 100, 105, 110, 125, 150, 200]
const TRACK_OPTS = [-1, -0.5, 0, 0.25, 0.5, 0.75, 1, 1.5, 2]

// --- flat icons -----------------------------------------------------------------------------------
const Chevron = () => (
  <svg className="fmt__chev" viewBox="0 0 10 10" width="9" height="9" aria-hidden>
    <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const Ico = ({ children, vb = '0 0 16 16' }) => (
  <svg viewBox={vb} width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    {children}
  </svg>
)
const BulletList = () => (
  <Ico>
    <circle cx="2.5" cy="4" r="1" fill="currentColor" stroke="none" />
    <circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="2.5" cy="12" r="1" fill="currentColor" stroke="none" />
    <path d="M6 4h8M6 8h8M6 12h8" />
  </Ico>
)
const NumberList = () => (
  <Ico>
    <path d="M7 4h7M7 8h7M7 12h7" />
    <text x="1" y="5.5" fontSize="5" fill="currentColor" stroke="none">1</text>
    <text x="1" y="9.5" fontSize="5" fill="currentColor" stroke="none">2</text>
    <text x="1" y="13.5" fontSize="5" fill="currentColor" stroke="none">3</text>
  </Ico>
)
const AlignLeft = () => (<Ico><path d="M2 4h12M2 7.3h7M2 10.6h10M2 13.9h6" /></Ico>)
const AlignCenter = () => (<Ico><path d="M2 4h12M4.5 7.3h7M3 10.6h10M5 13.9h6" /></Ico>)
const AlignRight = () => (<Ico><path d="M2 4h12M7 7.3h7M4 10.6h10M8 13.9h6" /></Ico>)
const AlignJustify = () => (<Ico><path d="M2 4h12M2 7.3h12M2 10.6h12M2 13.9h12" /></Ico>)
const LineSpace = () => (<Ico><path d="M3 3v10M1.5 4.5 3 3l1.5 1.5M1.5 11.5 3 13l1.5-1.5" /><path d="M7 4h7M7 8h7M7 12h7" /></Ico>)
const ParaSpace = () => (<Ico><path d="M6 2.5h8M6 5h8M6 11h8M6 13.5h8" /><path d="M3 5.5v5M1.5 7 3 5.5 4.5 7M1.5 9 3 10.5 4.5 9" /></Ico>)
const HScaleIcon = () => (<Ico><path d="M5 3h6M8 3v7" /><path d="M2 13.5h12M3.5 12 2 13.5l1.5 1.5M12.5 12 14 13.5l-1.5 1.5" /></Ico>)
const Tracking = () => (<Ico vb="0 0 18 16"><text x="1" y="9" fontSize="8" fill="currentColor" stroke="none">AV</text><path d="M2 13.5h14M3.5 12 2 13.5l1.5 1.5M14.5 12 16 13.5l-1.5 1.5" /></Ico>)

// dropdown of standard values (size / spacing / scale / tracking) with the current value merged in
function SelectField({ icon, value, options, suffix = '', className = '', onChange }) {
  const v = Number(value)
  const opts = [...new Set([v, ...options])].filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  return (
    <div className={'fmt__selectwrap ' + className}>
      {icon && <span className="fmt__field-ic">{icon}</span>}
      <select className="fmt__select" value={String(v)} onChange={(e) => onChange(parseFloat(e.target.value))}>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
            {suffix}
          </option>
        ))}
      </select>
      <Chevron />
    </div>
  )
}
function StyleBtn({ active, title, onClick, children }) {
  return (
    <button type="button" className={'fmt__sbtn' + (active ? ' is-on' : '')} title={title} onClick={onClick}>
      {children}
    </button>
  )
}

// FORMAT panel — editable formatting controls (dropdowns, inputs, toggles) seeded from the selected
// run/block. Edits live in local draft state; applying them back to the PDF is the next stage.
export default function StylePanel({ page, block, run, fontList = [], showBoxes = true, onShowBoxes }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(null)

  useEffect(() => {
    if (!run) {
      setDraft(null)
      return
    }
    setDraft({
      fontName: cleanFont(run.fontName),
      size: round2(run.size),
      color: run.color || '#000000',
      bold: !!run.bold,
      italic: !!run.italic,
      underline: !!run.underline,
      vAlign: run.vAlign || 'normal',
      align: block?.align || 'left',
      lineSpacing: round2(block?.lineSpacing ?? page?.docLineSpacing ?? 1.2),
      paragraphSpacing: block?.paragraphSpacing != null ? Math.round(block.paragraphSpacing) : 0,
      hScale: run.hScale != null ? Math.round(run.hScale * 10000) / 100 : 100,
      charSpacing: 0,
      list: 'none',
    })
  }, [run, block, page])

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }))
  const toggle = (k) => setDraft((d) => ({ ...d, [k]: !d[k] }))
  const vToggle = (mode) => setDraft((d) => ({ ...d, vAlign: d.vAlign === mode ? 'normal' : mode }))

  // fonts actually embedded in this document (shown first), then all installed families
  const embedded = page ? [...new Set(page.fonts.map((f) => cleanFont(f.name)).filter(Boolean))] : []
  const known = (n) => embedded.includes(n) || fontList.some((f) => f.family === n)

  const palette = page && (
    <div className="fmt__palette">
      <div className="fmt__plabel">
        {t('pdfed.panel.docFonts')} ({page.fonts.length})
      </div>
      {page.fonts.map((f, i) => (
        <div key={i} className="fmt__pfont" title={f.baseFont || f.name}>
          <span className="fmt__pname">{cleanFont(f.name)}</span>
          <span className={'fmt__ptag ' + (f.embedded ? (f.subset ? 'is-subset' : 'is-emb') : 'is-miss')}>
            {f.embedded ? (f.subset ? 'subset' : 'embedded') : 'missing'}
          </span>
        </div>
      ))}
      <div className="fmt__plabel">
        {t('pdfed.panel.docColors')} ({page.colors.length})
      </div>
      <div className="fmt__cswatches">
        {page.colors.map((c, i) => (
          <span key={i} className="fmt__cswatch" style={{ background: c }} title={c} />
        ))}
      </div>
    </div>
  )

  return (
    <div className="fmt">
      <div className="fmt__title">FORMAT</div>

      {!draft && <div className="fmt__hint">{t('pdfed.panel.selectHint')}</div>}

      {draft && (
        <>
          {/* font family — embedded first, then all installed; each previewed in its own face */}
          <div className="fmt__selectwrap fmt__font">
            <select className="fmt__select" value={draft.fontName} onChange={(e) => set('fontName', e.target.value)} style={{ fontFamily: draft.fontName }}>
              {!known(draft.fontName) && (
                <option value={draft.fontName} style={{ fontFamily: draft.fontName }}>
                  {draft.fontName}
                </option>
              )}
              {embedded.length > 0 && (
                <optgroup label={t('pdfed.panel.embeddedFonts')}>
                  {embedded.map((f) => (
                    <option key={'e:' + f} value={f} style={{ fontFamily: f }}>
                      {f}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label={t('pdfed.panel.systemFonts')}>
                {fontList.map((f) => (
                  <option key={f.family} value={f.family} style={{ fontFamily: f.family }}>
                    {f.family}
                  </option>
                ))}
              </optgroup>
            </select>
            <Chevron />
          </div>

          {/* size + colour */}
          <div className="fmt__row">
            <SelectField className="fmt__size" value={draft.size} options={SIZES} onChange={(v) => set('size', v)} />
            <input className="fmt__color" type="color" value={draft.color} onChange={(e) => set('color', e.target.value)} title={`${t('pdfed.param.color')}: ${draft.color}`} />
          </div>

          {/* style toggles */}
          <div className="fmt__row fmt__styles">
            <StyleBtn active={draft.bold} title={t('pdfed.param.bold')} onClick={() => toggle('bold')}><b>T</b></StyleBtn>
            <StyleBtn active={draft.italic} title={t('pdfed.param.italic')} onClick={() => toggle('italic')}><i>T</i></StyleBtn>
            <StyleBtn active={draft.underline} title={t('pdfed.param.underline')} onClick={() => toggle('underline')}>
              <span style={{ textDecoration: 'underline' }}>T</span>
            </StyleBtn>
            <StyleBtn active={draft.vAlign === 'super'} title={t('pdfed.param.superscript')} onClick={() => vToggle('super')}>
              <span className="fmt__sscript">T<i className="fmt__sup">1</i></span>
            </StyleBtn>
            <StyleBtn active={draft.vAlign === 'sub'} title={t('pdfed.param.subscript')} onClick={() => vToggle('sub')}>
              <span className="fmt__sscript">T<i className="fmt__sub">1</i></span>
            </StyleBtn>
          </div>

          {/* lists */}
          <div className="fmt__row">
            <button type="button" className={'fmt__listbtn' + (draft.list === 'bullet' ? ' is-on' : '')} title={t('pdfed.param.bulletList')} onClick={() => set('list', draft.list === 'bullet' ? 'none' : 'bullet')}>
              <BulletList />
              <Chevron />
            </button>
            <button type="button" className={'fmt__listbtn' + (draft.list === 'number' ? ' is-on' : '')} title={t('pdfed.param.numberList')} onClick={() => set('list', draft.list === 'number' ? 'none' : 'number')}>
              <NumberList />
              <Chevron />
            </button>
          </div>

          {/* alignment */}
          <div className="fmt__row fmt__aligns">
            <StyleBtn active={draft.align === 'left'} title={t('pdfed.param.align_left')} onClick={() => set('align', 'left')}><AlignLeft /></StyleBtn>
            <StyleBtn active={draft.align === 'center'} title={t('pdfed.param.align_center')} onClick={() => set('align', 'center')}><AlignCenter /></StyleBtn>
            <StyleBtn active={draft.align === 'right'} title={t('pdfed.param.align_right')} onClick={() => set('align', 'right')}><AlignRight /></StyleBtn>
            <StyleBtn active={draft.align === 'justify'} title={t('pdfed.param.align_justify')} onClick={() => set('align', 'justify')}><AlignJustify /></StyleBtn>
          </div>

          {/* line spacing + paragraph spacing */}
          <div className="fmt__row">
            <SelectField icon={<LineSpace />} value={draft.lineSpacing} options={LINE_OPTS} onChange={(v) => set('lineSpacing', v)} />
            <SelectField icon={<ParaSpace />} value={draft.paragraphSpacing} options={PARA_OPTS} onChange={(v) => set('paragraphSpacing', v)} />
          </div>

          {/* horizontal scale + character spacing */}
          <div className="fmt__row">
            <SelectField icon={<HScaleIcon />} value={draft.hScale} options={HSCALE_OPTS} suffix="%" onChange={(v) => set('hScale', v)} />
            <SelectField icon={<Tracking />} value={draft.charSpacing} options={TRACK_OPTS} onChange={(v) => set('charSpacing', v)} />
          </div>
        </>
      )}

      {palette}

      <label className="fmt__check">
        <input type="checkbox" checked={showBoxes} onChange={(e) => onShowBoxes?.(e.target.checked)} />
        {t('pdfed.panel.showBoxes')}
      </label>
    </div>
  )
}
