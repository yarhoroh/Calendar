/** Style controls for the selected text object: font, size, bold/italic, colour. */
import type { CSSProperties, ReactElement } from 'react';
import {
  cleanFontName,
  fontNameStyle,
  pickFamily,
  type ShapeObject,
  type TextAlign,
  type TextObject,
  type VectorObject,
} from './objects.js';

export interface StylePanelProps {
  object: TextObject | null;
  /** Standard CSS font families offered as fallbacks. */
  fonts: string[];
  /** Fonts actually embedded/used in the open PDF (raw PostScript names). */
  documentFonts: string[];
  /** Font sizes used in the PDF, shown first in the size dropdown. */
  documentSizes: number[];
  /** Text colours used in the PDF, offered as quick swatches. */
  documentColors: [number, number, number][];
  onChange: (patch: Partial<TextObject>) => void;
  onDelete: () => void;
}

const STANDARD_SIZES = [8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];

const ALIGN_OPTIONS: { value: TextAlign; title: string }[] = [
  { value: 'left', title: 'По левому краю' },
  { value: 'center', title: 'По центру' },
  { value: 'right', title: 'По правому краю' },
  { value: 'justify', title: 'По ширине' },
];

export function StylePanel(props: StylePanelProps): ReactElement | null {
  const { object, fonts, documentFonts, documentSizes, documentColors, onChange, onDelete } = props;
  if (!object) return null;

  // The current size, shown selected even if it's not one of the listed values.
  const sizeValue = Math.round(object.fontSize);
  const sizeListed = documentSizes.includes(sizeValue) || STANDARD_SIZES.includes(sizeValue);

  // Show the object's real PDF font as selected when it's one of the document's.
  const fontValue =
    object.fontName && documentFonts.includes(object.fontName) ? object.fontName : object.fontFamily;

  const pickFont = (value: string) => {
    if (documentFonts.includes(value)) {
      // A document font: render with the nearest CSS family + its weight/slant.
      const { bold, italic } = fontNameStyle(value);
      onChange({ fontName: value, fontFamily: pickFamily(value), bold, italic });
    } else {
      onChange({ fontFamily: value, fontName: '' });
    }
  };

  return (
    <div style={panelStyle}>
      <select value={fontValue} onChange={(e) => pickFont(e.target.value)} style={controlStyle} title="Шрифт">
        {documentFonts.length > 0 && (
          <optgroup label="Шрифты документа">
            {documentFonts.map((f) => (
              <option key={f} value={f}>
                {cleanFontName(f)}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Стандартные">
          {fonts.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </optgroup>
      </select>
      <select
        value={sizeValue}
        onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
        style={{ ...controlStyle, width: 70 }}
        title="Размер"
      >
        {!sizeListed && <option value={sizeValue}>{sizeValue}</option>}
        {documentSizes.length > 0 && (
          <optgroup label="Размеры документа">
            {documentSizes.map((s) => (
              <option key={`d${s}`} value={s}>
                {s}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Стандартные">
          {STANDARD_SIZES.map((s) => (
            <option key={`s${s}`} value={s}>
              {s}
            </option>
          ))}
        </optgroup>
      </select>
      <button
        type="button"
        style={object.bold ? toggleActive : toggle}
        onClick={() => onChange({ bold: !object.bold })}
        title="Жирный"
      >
        <b>Ж</b>
      </button>
      <button
        type="button"
        style={object.italic ? toggleActive : toggle}
        onClick={() => onChange({ italic: !object.italic })}
        title="Курсив"
      >
        <i>К</i>
      </button>
      <button
        type="button"
        style={object.underline ? toggleActive : toggle}
        onClick={() => onChange({ underline: !object.underline })}
        title="Подчёркивание"
      >
        <u>П</u>
      </button>
      <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 2px' }} />
      {ALIGN_OPTIONS.map((a) => (
        <button
          key={a.value}
          type="button"
          style={object.align === a.value ? iconToggleActive : iconToggle}
          onClick={() => onChange({ align: a.value })}
          title={a.title}
        >
          <AlignIcon kind={a.value} />
        </button>
      ))}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} title="Межстрочный интервал">
        <LineSpacingIcon />
        <input
          type="number"
          min={0.8}
          max={3}
          step={0.05}
          value={Number(object.lineHeight.toFixed(2))}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= 0.5 && v <= 4) onChange({ lineHeight: v });
          }}
          style={{ ...controlStyle, width: 56 }}
        />
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} title="Расстояние между буквами (pt)">
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>A↔A</span>
        <input
          type="number"
          step={0.1}
          value={Number((object.charSpacing ?? 0).toFixed(1))}
          onChange={(e) => onChange({ charSpacing: Number(e.target.value) })}
          style={{ ...controlStyle, width: 52 }}
        />
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} title="Горизонтальное растяжение символов, %">
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>↔%</span>
        <input
          type="number"
          step={1}
          value={Math.round((object.scaleX ?? 1) * 100)}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= 10 && v <= 400) onChange({ scaleX: v / 100 });
          }}
          style={{ ...controlStyle, width: 56 }}
        />
      </span>
      <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 2px' }} />
      <input
        type="color"
        value={rgbToHex(object.color)}
        onChange={(e) => onChange({ color: hexToRgb(e.target.value) })}
        style={{ ...controlStyle, width: 36, padding: 0 }}
        title="Цвет текста"
      />
      {documentColors.length > 0 && (
        <span style={{ display: 'flex', gap: 3 }} title="Цвета из PDF">
          {documentColors.map((c, i) => {
            const active = sameColor(c, object.color);
            return (
              <button
                key={i}
                type="button"
                onClick={() => onChange({ color: c })}
                title={active ? 'Цвет текста' : undefined}
                style={{
                  width: 16,
                  height: 22,
                  padding: 0,
                  borderRadius: 3,
                  background: rgbToHex(c),
                  cursor: 'pointer',
                  border: active ? '2px solid var(--accent)' : '1px solid var(--border)',
                  boxShadow: active ? '0 0 0 1px #fff inset' : 'none',
                }}
              />
            );
          })}
        </span>
      )}
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>фон</span>
      <input
        type="color"
        value={object.background ? rgbToHex(object.background) : '#ffffff'}
        onChange={(e) => onChange({ background: hexToRgb(e.target.value) })}
        style={{ ...controlStyle, width: 36, padding: 0 }}
        title="Цвет фона поля"
      />
      <button
        type="button"
        style={object.background ? toggle : toggleActive}
        onClick={() => onChange({ background: null })}
        title="Прозрачный фон"
      >
        ⌀
      </button>
      <button type="button" style={toggle} onClick={onDelete} title="Удалить">
        🗑
      </button>
    </div>
  );
}

/** Compare two colours after rounding to 8-bit, so PDF floats match swatches. */
function sameColor(a: [number, number, number], b: [number, number, number]): boolean {
  const r = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return r(a[0]) === r(b[0]) && r(a[1]) === r(b[1]) && r(a[2]) === r(b[2]);
}

export interface ShapePanelProps {
  object: ShapeObject;
  onChange: (patch: Partial<ShapeObject>) => void;
  onDelete: () => void;
}

/** Style controls for the selected rectangle/frame: fill colour and rounding. */
export function ShapePanel(props: ShapePanelProps): ReactElement {
  const { object, onChange, onDelete } = props;
  return (
    <div style={panelStyle}>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>Фон</span>
      <input
        type="color"
        value={object.background ? rgbToHex(object.background) : '#cccccc'}
        onChange={(e) => onChange({ background: hexToRgb(e.target.value) })}
        style={{ ...controlStyle, width: 36, padding: 0 }}
        title="Цвет фона"
      />
      <button
        type="button"
        style={object.background ? toggle : toggleActive}
        onClick={() => onChange({ background: null })}
        title="Прозрачный фон"
      >
        ⌀
      </button>
      <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>Скругление</span>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.min(100, Math.round(object.radius))}
        onChange={(e) => onChange({ radius: Number(e.target.value) })}
        style={{ width: 120 }}
        title="Скругление углов"
      />
      <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 26, textAlign: 'center' }}>
        {Math.round(object.radius)}
      </span>
      <button type="button" style={toggle} onClick={onDelete} title="Удалить">
        🗑
      </button>
    </div>
  );
}

export interface VectorPanelProps {
  object: VectorObject;
  onChange: (patch: Partial<VectorObject>) => void;
  onDelete: () => void;
}

/** Style controls for a vector shape lifted from the PDF: fill, stroke, width. */
export function VectorPanel(props: VectorPanelProps): ReactElement {
  const { object, onChange, onDelete } = props;
  return (
    <div style={panelStyle}>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>Заливка</span>
      <input
        type="color"
        value={object.fill ? rgbToHex(object.fill) : '#cccccc'}
        onChange={(e) => onChange({ fill: hexToRgb(e.target.value) })}
        style={{ ...controlStyle, width: 36, padding: 0 }}
        title="Цвет заливки"
      />
      <button
        type="button"
        style={object.fill ? toggle : toggleActive}
        onClick={() => onChange({ fill: null })}
        title="Без заливки"
      >
        ⌀
      </button>
      <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>Контур</span>
      <input
        type="color"
        value={object.stroke ? rgbToHex(object.stroke) : '#000000'}
        onChange={(e) => onChange({ stroke: hexToRgb(e.target.value), strokeWidth: object.strokeWidth || 1 })}
        style={{ ...controlStyle, width: 36, padding: 0 }}
        title="Цвет контура"
      />
      <button
        type="button"
        style={object.stroke ? toggle : toggleActive}
        onClick={() => onChange({ stroke: null })}
        title="Без контура"
      >
        ⌀
      </button>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>Толщина</span>
      <input
        type="number"
        min={0}
        max={50}
        step={0.5}
        value={Number(object.strokeWidth.toFixed(1))}
        onChange={(e) => onChange({ strokeWidth: Math.max(0, Number(e.target.value)) })}
        style={{ ...controlStyle, width: 56 }}
        title="Толщина контура"
      />
      <button type="button" style={toggle} onClick={onDelete} title="Удалить">
        🗑
      </button>
    </div>
  );
}

function rgbToHex(c: [number, number, number]): string {
  const h = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

const panelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const controlStyle: CSSProperties = {
  height: 28,
  fontSize: 13,
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'var(--bg)',
  color: 'var(--text)',
};

const toggle: CSSProperties = {
  width: 30,
  height: 28,
  cursor: 'pointer',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--text)',
  fontSize: 13,
};

const toggleActive: CSSProperties = {
  ...toggle,
  background: 'var(--accent)',
  color: '#fff',
  borderColor: 'var(--accent)',
};

// Square buttons that hold an SVG icon (alignment), centred.
const iconToggle: CSSProperties = {
  ...toggle,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
};

const iconToggleActive: CSSProperties = {
  ...iconToggle,
  background: 'var(--accent)',
  borderColor: 'var(--accent)',
};

/** Alignment icon: four rows whose offset/width encode the alignment. */
function AlignIcon({ kind }: { kind: TextAlign }): ReactElement {
  const base = [10, 6, 9, 5];
  const color = 'var(--muted)';
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      {[0, 1, 2, 3].map((r) => {
        const w = kind === 'justify' ? 11 : base[r];
        const y = 3 + r * 3;
        let x = 2.5;
        if (kind === 'center') x = (16 - w) / 2;
        else if (kind === 'right') x = 13.5 - w;
        return <rect key={r} x={x} y={y} width={w} height="1.4" rx="0.7" fill={color} />;
      })}
    </svg>
  );
}

/** Line-spacing icon: an up/down arrow beside stacked lines. */
function LineSpacingIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <path d="M3 3 V13 M3 3 L1.5 4.8 M3 3 L4.5 4.8 M3 13 L1.5 11.2 M3 13 L4.5 11.2" stroke="var(--muted)" strokeWidth="1" fill="none" />
      <rect x="7" y="3.2" width="8" height="1.4" rx="0.7" fill="var(--muted)" />
      <rect x="7" y="7.3" width="8" height="1.4" rx="0.7" fill="var(--muted)" />
      <rect x="7" y="11.4" width="8" height="1.4" rx="0.7" fill="var(--muted)" />
    </svg>
  );
}
