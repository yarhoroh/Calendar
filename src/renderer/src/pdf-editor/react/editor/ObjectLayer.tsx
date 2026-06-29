/**
 * ObjectLayer — the interactive overlay for one page. Renders text/image
 * objects, draws a selection frame with resize handles, and handles
 * move/resize dragging. Empty clicks pass through to the page beneath (the
 * layer itself is pointer-transparent; only objects capture events).
 *
 * For existing text the frame appears OVER the original raster (the real,
 * pixel-perfect glyphs stay visible); the editable field only replaces it once
 * the user actually starts editing.
 */
import { useCallbackRef } from './useCallbackRef.js';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import type { Rect } from '../../types.js';
import {
  cssColor,
  RESIZE_HANDLES,
  resizeBox,
  textEdited,
  vectorEdited,
  vectorPathD,
  type EditorObject,
  type ObjectId,
  type Pivot,
  type ResizeHandle,
} from './objects.js';
import { isEmbeddedFamily } from './fonts.js';
import { measureAscent, measureTextWidth } from './measureText.js';

export interface ObjectLayerProps {
  scale: number;
  objects: EditorObject[];
  selectedId: ObjectId | null;
  editingId: ObjectId | null;
  onSelect: (id: ObjectId) => void;
  onStartEdit: (id: ObjectId) => void;
  onChange: (id: ObjectId, patch: Partial<EditorObject>) => void;
  onTextInput: (id: ObjectId, text: string) => void;
  onCommit: () => void;
  onExitEdit: () => void;
  onDelete: (id: ObjectId) => void;
  onBringForward: (id: ObjectId) => void;
  onSendBackward: (id: ObjectId) => void;
  onCrop: (id: ObjectId) => void;
  onCopy: (id: ObjectId) => void;
  onPaste: () => void;
  /** PDF text-line boxes on this page — extra alignment targets while dragging. */
  guideLines: Rect[];
  /** Vector-shape boxes on this page — outlined in edit mode so they're findable. */
  vectorOutlines: Rect[];
  /** Outline every element (text line + vector) so invisible ones can be found. */
  showOutlines: boolean;
  /** Ids selected together by the marquee — moved as a group. */
  groupIds: ObjectId[];
  /** Move every group member to a new absolute position (during a group drag). */
  onGroupMove: (updates: { id: ObjectId; x: number; y: number }[]) => void;
  /** Group drag finished — let the editor lift the members off the page. */
  onGroupMoveEnd: (ids: ObjectId[]) => void;
  /** Current page raster URL — used to re-reveal page text over edited vectors. */
  pageUrl: string;
}

/** Breathing room (screen px) around a box's text so small text is easy to grab
 *  and edit. The text itself stays at its real PDF coordinates; the padding only
 *  expands the frame outward. Change here to retune everywhere. */
export const FRAME_PAD = 5;

type DragMode = 'move' | 'resize' | 'rotate' | 'pivot';

interface DragState {
  id: ObjectId;
  mode: DragMode;
  handle: ResizeHandle | null;
  startX: number;
  startY: number;
  box: { x: number; y: number; w: number; h: number };
  rotation: number;
  pivot: Pivot;
  pivotClientX: number;
  pivotClientY: number;
  startAngle: number;
  layerLeft: number;
  layerTop: number;
  /** When moving a marquee group, the start position of every member. */
  group: { id: ObjectId; x: number; y: number }[] | null;
}

export function ObjectLayer(props: ObjectLayerProps): ReactElement {
  const {
    scale,
    objects,
    selectedId,
    editingId,
    onSelect,
    onStartEdit,
    onChange,
    onTextInput,
    onExitEdit,
    onDelete,
    onBringForward,
    onSendBackward,
    onCrop,
    onCopy,
    onPaste,
    guideLines,
    vectorOutlines,
    showOutlines,
    groupIds,
    onGroupMove,
    onGroupMoveEnd,
    pageUrl,
  } = props;
  const groupRef = useRef(groupIds);
  groupRef.current = groupIds;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [guides, setGuides] = useState<{
    vx: number | null;
    hy: number | null;
    /** Frame(s) to highlight translucent-grey (the box the element sits in). */
    frames: Rect[];
  }>({ vx: null, hy: null, frames: [] });
  const layerRef = useRef<HTMLDivElement | null>(null);
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const guideLinesRef = useRef(guideLines);
  guideLinesRef.current = guideLines;
  const onChangeRef = useCallbackRef(onChange);
  const onGroupMoveRef = useCallbackRef(onGroupMove);
  const onGroupMoveEndRef = useCallbackRef(onGroupMoveEnd);

  // Global drag handling so the pointer can leave the object while dragging.
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      if (drag.mode === 'rotate') {
        const ang =
          (Math.atan2(e.clientY - drag.pivotClientY, e.clientX - drag.pivotClientX) * 180) /
          Math.PI;
        let rot = drag.rotation + (ang - drag.startAngle);
        if (e.shiftKey) rot = Math.round(rot / 15) * 15;
        onChangeRef.current(drag.id, { rotation: rot });
        return;
      }
      if (drag.mode === 'pivot') {
        // Move the rotation pivot, compensating x/y so the box stays put.
        const mx = (e.clientX - drag.layerLeft) / scale;
        const my = (e.clientY - drag.layerTop) / scale;
        const th = (drag.rotation * Math.PI) / 180;
        const cos = Math.cos(th);
        const sin = Math.sin(th);
        const px = drag.box.x + drag.pivot.x * drag.box.w;
        const py = drag.box.y + drag.pivot.y * drag.box.h;
        const ux = px + cos * (mx - px) + sin * (my - py);
        const uy = py - sin * (mx - px) + cos * (my - py);
        const nx = Math.max(0, Math.min(1, (ux - drag.box.x) / drag.box.w));
        const ny = Math.max(0, Math.min(1, (uy - drag.box.y) / drag.box.h));
        const dOx = (nx - drag.pivot.x) * drag.box.w;
        const dOy = (ny - drag.pivot.y) * drag.box.h;
        const cx = (cos - 1) * dOx - sin * dOy;
        const cy = sin * dOx + (cos - 1) * dOy;
        onChangeRef.current(drag.id, {
          pivot: { x: nx, y: ny },
          x: drag.box.x + cx,
          y: drag.box.y + cy,
        });
        return;
      }
      const dx = (e.clientX - drag.startX) / scale;
      const dy = (e.clientY - drag.startY) / scale;
      if (drag.mode === 'resize' && drag.handle) {
        const resized = resizeBox(drag.box, drag.handle, dx, dy);
        const g = resizeGuides(
          resized,
          drag.handle,
          drag.id,
          objectsRef.current,
          guideLinesRef.current,
          scale,
          !e.shiftKey,
        );
        onChangeRef.current(drag.id, g.box);
        const frame = containerFrame(g.box, drag.id, objectsRef.current, guideLinesRef.current);
        setGuides({ vx: g.vx, hy: g.hy, frames: frame ? [frame] : [] });
      } else if (drag.group) {
        // Group move: shift every member by the same delta (no snapping).
        onGroupMoveRef.current(drag.group.map((g) => ({ id: g.id, x: g.x + dx, y: g.y + dy })));
      } else {
        // Move with alignment guides; magnetizes to the nearest edge/centre by
        // default so texts click into a column/row. Hold Shift for free placement.
        const snap = alignGuides(
          drag.box.x + dx,
          drag.box.y + dy,
          drag.box.w,
          drag.box.h,
          drag.id,
          objectsRef.current,
          guideLinesRef.current,
          scale,
          !e.shiftKey,
        );
        onChangeRef.current(drag.id, { x: snap.x, y: snap.y });
        setGuides({ vx: snap.vx, hy: snap.hy, frames: [] });
      }
    };
    const up = () => {
      if (drag.group) onGroupMoveEndRef.current(drag.group.map((g) => g.id));
      setDrag(null);
      setGuides({ vx: null, hy: null, frames: [] });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [drag, scale, onChangeRef]);

  const beginDrag = (
    e: ReactMouseEvent,
    obj: EditorObject,
    mode: DragMode,
    handle: ResizeHandle | null,
  ) => {
    e.stopPropagation();
    // preventDefault keeps the textarea focused, so dragging while editing
    // doesn't blur the field.
    e.preventDefault();
    // Dragging a member of the marquee group moves the whole group; selecting it
    // singly would clear the group, so don't.
    const inGroup = mode === 'move' && groupRef.current.length > 1 && groupRef.current.includes(obj.id);
    if (!inGroup && obj.id !== editingId) onSelect(obj.id);
    const group = inGroup
      ? groupRef.current.map((id) => {
          const m = objectsRef.current.find((o) => o.id === id);
          return { id, x: m ? m.x : obj.x, y: m ? m.y : obj.y };
        })
      : null;
    const lr = layerRef.current?.getBoundingClientRect();
    const left = lr?.left ?? 0;
    const top = lr?.top ?? 0;
    const pivotClientX = left + (obj.x + obj.pivot.x * obj.w) * scale;
    const pivotClientY = top + (obj.y + obj.pivot.y * obj.h) * scale;
    setDrag({
      id: obj.id,
      mode,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      box: { x: obj.x, y: obj.y, w: obj.w, h: obj.h },
      rotation: obj.rotation,
      pivot: { ...obj.pivot },
      pivotClientX,
      pivotClientY,
      startAngle: (Math.atan2(e.clientY - pivotClientY, e.clientX - pivotClientX) * 180) / Math.PI,
      layerLeft: left,
      layerTop: top,
      group,
    });
  };

  const startDrag = (e: ReactMouseEvent, obj: EditorObject, handle: ResizeHandle | null) =>
    beginDrag(e, obj, handle ? 'resize' : 'move', handle);

  // Is the pointer over a page text line? Used so a click on a vector that has
  // text on top falls through to select the TEXT, not the vector underneath.
  const pointOverText = (e: ReactMouseEvent): boolean => {
    const lr = layerRef.current?.getBoundingClientRect();
    if (!lr) return false;
    const px = (e.clientX - lr.left) / scale;
    const py = (e.clientY - lr.top) / scale;
    return guideLines.some(
      (b) => px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height,
    );
  };

  return (
    <div style={layerStyle} ref={layerRef}>
      {/* Edit-mode outlines: a faint ring around every still-original text line
          and vector so even invisible elements (e.g. white text on a moved
          background) can be seen and clicked. Materialised elements are outlined
          by their own frame (which moves with them), so skip their stale cache
          box here — otherwise a moved element would leave its ring behind. */}
      {showOutlines &&
        (() => {
          const near = (a: Rect, b: Rect) =>
            Math.abs(a.x - b.x) < 2 &&
            Math.abs(a.y - b.y) < 2 &&
            Math.abs(a.width - b.width) < 2 &&
            Math.abs(a.height - b.height) < 2;
          const claimedText: Rect[] = [];
          const claimedVec: Rect[] = [];
          for (const o of objects) {
            if (o.kind === 'text' && o.originalBbox) claimedText.push(o.originalBbox);
            else if (o.kind === 'vector') claimedVec.push(o.origBbox);
          }
          return [
            ...guideLines
              .filter((r) => !claimedText.some((c) => near(c, r)))
              .map((r, i) => ({ r, i, kind: 'text' as const })),
            ...vectorOutlines
              .filter((r) => !claimedVec.some((c) => near(c, r)))
              .map((r, i) => ({ r, i, kind: 'vec' as const })),
          ];
        })().map(({ r, i, kind }) => (
          <div
            key={`outline-${kind}-${i}`}
            style={{
              position: 'absolute',
              left: r.x * scale,
              top: r.y * scale,
              width: r.width * scale,
              height: r.height * scale,
              outline: `1px dashed ${kind === 'text' ? 'rgba(16,185,129,0.55)' : 'rgba(150,90,200,0.5)'}`,
              outlineOffset: 1,
              pointerEvents: 'none',
            }}
          />
        ))}
      {/* White erasers hide the original glyphs ONLY once a line is actually
          changed, moved or being edited — untouched lines keep their crisp,
          pixel-perfect original instead of a substitute-font overlay. */}
      {objects.map((obj) => {
        // Hide the original raster glyphs ONLY while a line is actually being
        // edited or has been changed — a merely-selected line keeps its crisp,
        // pixel-perfect original showing (so its font never changes on select).
        if (obj.kind !== 'text' || !obj.originalBbox || obj.source !== 'existing') return null;
        if (obj.lifted || obj.deleted) return null; // already redacted off the page
        if (obj.id !== editingId && !textEdited(obj)) return null; // pristine — show raster
        // Cover the glyphs fully with a ~1px sub-pixel safety on every side, so no
        // sliver of the original peeks above/below — but keep the bottom margin
        // small so we don't reach into the next line.
        const fs = obj.fontSize * scale;
        const topPad = fs * 0.15 + 1;
        const botPad = fs * 0.05 + 1;
        return (
          <div
            key={`erase-${obj.id}`}
            style={{
              position: 'absolute',
              left: obj.originalBbox.x * scale - 1,
              top: obj.originalBbox.y * scale - topPad,
              width: obj.originalBbox.width * scale + 2,
              height: obj.originalBbox.height * scale + topPad + botPad,
              background: cssColor(obj.eraseColor),
              pointerEvents: 'none',
            }}
          />
        );
      })}
      {objects.map((obj) => {
        // A deleted existing element keeps no frame and draws nothing — its
        // original is erased from the page (eraser for text, redacted line-art
        // for a vector), so it's simply gone.
        if ((obj.kind === 'text' || obj.kind === 'vector') && obj.deleted) return null;
        const selected = obj.id === selectedId;
        const inGroup = groupIds.includes(obj.id);
        const editing = obj.id === editingId;
        // The box is sized to its content (fitTextBox), already a touch larger
        // than the text, so the frame is exactly the box — no scroll, no jump.
        // Frame = text box expanded by FRAME_PAD on every side. The content area
        // (border-box minus padding) lands exactly on the text's real coords, so
        // the padding is a pure grab/edit margin and never moves the text.
        const frame: CSSProperties = {
          position: 'absolute',
          left: obj.x * scale - FRAME_PAD,
          top: obj.y * scale - FRAME_PAD,
          width: obj.w * scale + 2 * FRAME_PAD,
          height: obj.h * scale + 2 * FRAME_PAD,
          padding: FRAME_PAD,
          pointerEvents: 'auto',
          boxSizing: 'border-box',
          // Outline (not border) so the ring never changes the box size. Selected
          // = solid blue; in edit mode every element gets a faint ring (that moves
          // WITH it) so it's findable. This ring replaces the static cache outline.
          outline:
            selected || inGroup
              ? '1px solid var(--accent)'
              : showOutlines
                ? `1px dashed ${obj.kind === 'vector' ? 'rgba(150,90,200,0.5)' : 'rgba(16,185,129,0.55)'}`
                : 'none',
          outlineOffset: 1,
          transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
          // Rotate around the (movable) pivot, measured inside the padded frame.
          transformOrigin: `${FRAME_PAD + obj.pivot.x * obj.w * scale}px ${FRAME_PAD + obj.pivot.y * obj.h * scale}px`,
          cursor: drag?.id === obj.id && drag.mode === 'move' ? 'grabbing' : 'move',
          // Selection no longer overrides stacking: layer order (array order /
          // bring-forward / send-backward) is the single source of z-order.
        };
        const singleLine = obj.kind === 'text' && !obj.text.includes('\n');
        // A substitute font's glyph advances differ from the PDF's, so an
        // unchanged line would visibly compress/expand. Spread the width
        // difference as letter-spacing so the line still spans its original box
        // (approximate, but the overall density matches). Drops once retyped.
        let letterSpacing: string | undefined;
        if (
          obj.kind === 'text' &&
          obj.originalBbox &&
          obj.originalText &&
          singleLine &&
          obj.originalText.length > 1
        ) {
          // Keep the ORIGINAL line's tracking constant (derived from the original text + width), and
          // apply it whether or not the text was edited — so adding/removing a character doesn't
          // suddenly re-space the whole line. (Approximation of the PDF's real Tc/Tz.)
          const measured = measureTextWidth(
            obj.originalText,
            obj.fontSize,
            obj.fontFamily,
            obj.bold,
            obj.italic,
          );
          const perGap = (obj.originalBbox.width - measured) / (obj.originalText.length - 1);
          if (Math.abs(perGap) < obj.fontSize) letterSpacing = `${perGap * scale}px`;
        }
        // Exact baseline WITHOUT touching line-height (line-height stays box-height, which keeps the
        // textarea intact — changing it to fontSize was what broke editing). With line-height = box,
        // the line's baseline sits at half-leading + ascent from the box top; translate so that
        // lands on the PDF baseline. ascent is measured for THIS font/size. No percentages.
        const ascentPx =
          singleLine && obj.kind === 'text'
            ? measureAscent(obj.fontSize * scale, obj.fontFamily, obj.bold, obj.italic)
            : 0;
        const hasBaseline = obj.kind === 'text' && typeof obj.baseline === 'number';
        const baselineTy =
          hasBaseline && obj.kind === 'text'
            ? (obj.baseline! - (obj.originalBbox?.y ?? obj.y)) * scale -
              ((obj.h - obj.fontSize) * scale) / 2 -
              ascentPx
            : -obj.fontSize * scale * 0.08;
        const textCss: CSSProperties = {
          ...textStyle,
          whiteSpace: 'pre',
          overflow: 'visible',
          background:
            obj.kind === 'text' && obj.background ? cssColor(obj.background) : 'transparent',
          lineHeight: singleLine
            ? `${obj.h * scale}px`
            : obj.kind === 'text'
              ? obj.lineHeight
              : 1.2,
          textAlign: obj.kind === 'text' ? obj.align : undefined,
          textDecoration: obj.kind === 'text' && obj.underline ? 'underline' : undefined,
          transform:
            obj.kind === 'text'
              ? `${singleLine ? `translateY(${baselineTy}px)` : ''}${obj.scaleX && obj.scaleX !== 1 ? ` scaleX(${obj.scaleX})` : ''}`.trim() || undefined
              : undefined,
          transformOrigin: 'left top',
          fontFamily: obj.kind === 'text' ? obj.fontFamily : undefined,
          fontSize: obj.kind === 'text' ? obj.fontSize * scale : undefined,
          // An embedded font program already carries its own weight/slant, so
          // don't let the browser synthesize faux bold/italic on top of it.
          fontWeight:
            obj.kind === 'text' && obj.bold && !isEmbeddedFamily(obj.fontFamily) ? 700 : 400,
          fontStyle:
            obj.kind === 'text' && obj.italic && !isEmbeddedFamily(obj.fontFamily)
              ? 'italic'
              : 'normal',
          color: obj.kind === 'text' ? cssColor(obj.color) : undefined,
          // explicit character spacing (from the panel) overrides the auto width-fit tracking
          letterSpacing:
            obj.kind === 'text' && obj.charSpacing != null ? `${obj.charSpacing * scale}px` : letterSpacing,
        };

        return (
          <div
            key={obj.id}
            style={frame}
            onMouseDown={(e) => {
              // A vector with page text on top: let the click reach the text
              // (the vector still drags from its grey areas and the corner grip).
              if (obj.kind === 'vector' && pointOverText(e)) return;
              startDrag(e, obj, null);
            }}
            onClick={(e) => {
              if (obj.kind === 'vector' && pointOverText(e)) return; // bubble → select text
              e.stopPropagation();
              if (!editing) onSelect(obj.id);
            }}
            onDoubleClick={(e) => {
              if (obj.kind === 'vector' && pointOverText(e)) return; // bubble → edit text
              e.stopPropagation();
              if (obj.kind === 'text') onStartEdit(obj.id);
            }}
          >
            {obj.kind === 'image' ? (
              <img src={obj.src} style={imgStyle} alt="" draggable={false} />
            ) : obj.kind === 'rect' ? (
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  background: obj.background ? cssColor(obj.background) : 'transparent',
                  borderRadius: obj.radius * scale,
                }}
              />
            ) : obj.kind === 'vector' ? (
              // Until it's edited, show nothing — the crisp original (correctly
              // layered under the page text) stays visible. Once moved/resized/
              // recoloured, draw our overlay (and an eraser hides the original).
              vectorEdited(obj) ? (
                <svg
                  width="100%"
                  height="100%"
                  viewBox={`0 0 ${Math.max(obj.origBbox.width, 0.01)} ${Math.max(obj.origBbox.height, 0.01)}`}
                  preserveAspectRatio="none"
                  style={{ display: 'block', overflow: 'visible' }}
                >
                  <path
                    d={vectorPathD(obj)}
                    fill={obj.fill ? cssColor(obj.fill) : 'none'}
                    stroke={obj.stroke ? cssColor(obj.stroke) : 'none'}
                    strokeWidth={obj.strokeWidth}
                    fillRule={obj.evenOdd ? 'evenodd' : 'nonzero'}
                  />
                </svg>
              ) : null
            ) : editing ? (
              <textarea
                autoFocus
                wrap="off"
                value={obj.text}
                onChange={(e) => onTextInput(obj.id, e.target.value)}
                onFocus={(e) => {
                  // Place the caret at the end of the line on entering edit.
                  const end = e.target.value.length;
                  e.target.setSelectionRange(end, end);
                }}
                onKeyDown={(e) => {
                  // Ctrl+Enter or Esc: commit and drop the frame.
                  if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) {
                    e.preventDefault();
                    onExitEdit();
                  }
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                onBlur={() => props.onCommit()}
                // reset the browser textarea chrome (padding/border/margin) so the editable text
                // sits exactly where the display overlay / raster did — no shift on entering edit
                style={{ ...textCss, overflow: 'hidden', padding: 0, margin: 0, border: 'none', outline: 'none', resize: 'none', boxSizing: 'border-box' }}
              />
            ) : obj.kind === 'text' &&
              obj.source === 'existing' &&
              !obj.lifted &&
              !textEdited(obj) ? (
              // Selected but not yet edited: render nothing so the crisp original
              // raster glyphs show through the frame — the font must not change
              // just because the line was selected/activated.
              null
            ) : obj.kind === 'text' && obj.runs && obj.runs.length > 1 ? (
              // Rich text: render each style run as its own span (mixed fonts/sizes/bold/colour).
              <div style={textCss}>
                {obj.runs.map((r, i) => (
                  <span
                    key={i}
                    style={{
                      fontFamily: r.fontFamily,
                      fontSize: r.fontSize * scale,
                      fontWeight: r.bold && !isEmbeddedFamily(r.fontFamily) ? 700 : 400,
                      fontStyle: r.italic && !isEmbeddedFamily(r.fontFamily) ? 'italic' : 'normal',
                      textDecoration: r.underline ? 'underline' : undefined,
                      color: cssColor(r.color),
                      letterSpacing: r.charSpacing ? `${r.charSpacing * scale}px` : undefined,
                      ...(r.scaleX && Math.abs(r.scaleX - 1) > 0.01
                        ? { display: 'inline-block', transform: `scaleX(${r.scaleX})`, transformOrigin: 'left top' }
                        : null),
                    }}
                  >
                    {r.text}
                  </span>
                ))}
              </div>
            ) : (
              // Edited / lifted / new single-style text.
              <div style={textCss}>{obj.text}</div>
            )}

            {selected && !editing && (
              <div
                style={barStyle}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  style={barBtn}
                  title="Повернуть влево"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(obj.id, { rotation: obj.rotation - 15 });
                  }}
                >
                  ↺
                </button>
                <button
                  type="button"
                  style={barBtn}
                  title="Повернуть вправо"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(obj.id, { rotation: obj.rotation + 15 });
                  }}
                >
                  ↻
                </button>
                <button
                  type="button"
                  style={barBtn}
                  title="На передний план"
                  onClick={(e) => {
                    e.stopPropagation();
                    onBringForward(obj.id);
                  }}
                >
                  <BringForwardIcon />
                </button>
                <button
                  type="button"
                  style={barBtn}
                  title="На задний план"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSendBackward(obj.id);
                  }}
                >
                  <SendBackwardIcon />
                </button>
                <button
                  type="button"
                  style={barBtn}
                  title="Копировать (Ctrl+C)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopy(obj.id);
                  }}
                >
                  <CopyIcon />
                </button>
                <button
                  type="button"
                  style={barBtn}
                  title="Вставить (Ctrl+V)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPaste();
                  }}
                >
                  <PasteIcon />
                </button>
                {obj.kind === 'text' && (
                  <button
                    type="button"
                    style={barBtn}
                    title="Подогнать рамку под текст"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCrop(obj.id);
                    }}
                  >
                    <CropIcon />
                  </button>
                )}
                <button
                  type="button"
                  style={{ ...barBtn, color: '#d23' }}
                  title="Удалить (Del)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(obj.id);
                  }}
                >
                  🗑
                </button>
              </div>
            )}

            {selected &&
              !editing &&
              RESIZE_HANDLES.filter((h) => h !== 'nw').map((h) => (
                <div
                  key={h}
                  style={handleStyle(h)}
                  onMouseDown={(e) => startDrag(e, obj, h)}
                />
              ))}

            {/* Rotation grips just outside each corner. */}
            {selected &&
              !editing &&
              (['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                <div
                  key={`rot-${c}`}
                  style={rotateGripStyle(c)}
                  title="Вращать (Shift — шаг 15°)"
                  onMouseDown={(e) => beginDrag(e, obj, 'rotate', null)}
                >
                  ↻
                </div>
              ))}

            {/* Rotation pivot — drag to move the centre of rotation. */}
            {selected && !editing && (
              <div
                style={{
                  position: 'absolute',
                  left: FRAME_PAD + obj.pivot.x * obj.w * scale,
                  top: FRAME_PAD + obj.pivot.y * obj.h * scale,
                  transform: 'translate(-50%, -50%)',
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: '#fff',
                  border: '2px solid #e8632a',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.2)',
                  cursor: 'move',
                  pointerEvents: 'auto',
                }}
                title="Центр вращения — перетащите"
                onMouseDown={(e) => beginDrag(e, obj, 'pivot', null)}
              />
            )}

            {/* Top-left move grip: always present (even while editing), so you
                can reposition the box and keep typing. */}
            {selected && (
              <div
                style={moveGripStyle}
                title="Двигать"
                onMouseDown={(e) => startDrag(e, obj, null)}
              />
            )}
          </div>
        );
      })}

      {/* Page text re-revealed over edited vectors: a shape that lived under the
          text stays under it. We redacted the original out of the raster, so this
          clip shows clean text (no ghost) on top of the moved/recoloured shape. */}
      {objects.some((o) => o.kind === 'vector' && o.source === 'existing' && !o.deleted && vectorEdited(o)) &&
        (() => {
          const overlaps = (a: Rect, b: Rect) =>
            a.x < b.x + b.width &&
            a.x + a.width > b.x &&
            a.y < b.y + b.height &&
            a.y + a.height > b.y;
          // Boxes of the edited existing vectors — only reveal text over THEM.
          const vecBoxes = objects
            .filter((o) => o.kind === 'vector' && o.source === 'existing' && !o.deleted && vectorEdited(o))
            .map((o) => ({ x: o.x, y: o.y, width: o.w, height: o.h }));
          const textBoxes = objects
            .filter((o) => o.kind === 'text')
            .map((o) => ({ x: o.x, y: o.y, width: o.w, height: o.h }));
          const reveal = guideLines.filter(
            (b) => vecBoxes.some((v) => overlaps(b, v)) && !textBoxes.some((t) => overlaps(b, t)),
          );
          if (!reveal.length) return null;
          const clip = reveal
            .map((b) => {
              const x0 = b.x * scale;
              const y0 = b.y * scale;
              const x1 = (b.x + b.width) * scale;
              const y1 = (b.y + b.height) * scale;
              return `M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
            })
            .join(' ');
          return (
            <img
              src={pageUrl}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '100%',
                height: '100%',
                clipPath: `path('${clip}')`,
                // multiply lets the shape below show through the white gaps
                // between glyphs, so dark text sits ON the shape, not on a white box.
                mixBlendMode: 'multiply',
                pointerEvents: 'none',
                // Above a selected vector (zIndex 40) so the text it sat under
                // stays visually ON TOP of the moved shape, never beneath it.
                zIndex: 41,
              }}
            />
          );
        })()}

      {/* The frame the element sits in, highlighted grey while resizing. */}
      {guides.frames.map((r, i) => (
        <div
          key={`frame-${i}`}
          style={{
            position: 'absolute',
            left: r.x * scale,
            top: r.y * scale,
            width: r.width * scale,
            height: r.height * scale,
            background: 'rgba(120,120,120,0.18)',
            outline: '1px solid rgba(120,120,120,0.5)',
            pointerEvents: 'none',
          }}
        />
      ))}

      {/* Alignment guides shown while dragging. */}
      {guides.vx !== null && (
        <div
          style={{
            position: 'absolute',
            left: guides.vx * scale,
            top: 0,
            height: '100%',
            borderLeft: '1px dashed rgba(232,99,42,0.85)',
            pointerEvents: 'none',
          }}
        />
      )}
      {guides.hy !== null && (
        <div
          style={{
            position: 'absolute',
            top: guides.hy * scale,
            left: 0,
            width: '100%',
            borderTop: '1px dashed rgba(232,99,42,0.85)',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}

/** Find the nearest edge/centre alignment with other objects. With `snap`,
 *  magnetize the position to it; always report the matched guide line(s). */
function alignGuides(
  nx: number,
  ny: number,
  w: number,
  h: number,
  id: ObjectId,
  objects: EditorObject[],
  lines: Rect[],
  scale: number,
  snap: boolean,
): { x: number; y: number; vx: number | null; hy: number | null } {
  const tol = 5 / scale; // ~5px in document points
  const { v: vTargets, h: hTargets } = collectTargets(objects, lines, id);
  const best = (refs: number[], targets: number[]) => {
    let pick: { line: number; diff: number } | null = null;
    for (const r of refs) {
      for (const t of targets) {
        const diff = t - r;
        if (Math.abs(diff) <= tol && (!pick || Math.abs(diff) < Math.abs(pick.diff))) {
          pick = { line: t, diff };
        }
      }
    }
    return pick;
  };
  const v = best([nx, nx + w / 2, nx + w], vTargets);
  const h2 = best([ny, ny + h / 2, ny + h], hTargets);
  return {
    x: snap && v ? nx + v.diff : nx,
    y: snap && h2 ? ny + h2.diff : ny,
    vx: v ? v.line : null,
    hy: h2 ? h2.line : null,
  };
}

/** Gather snap targets from every other object and PDF text line. Shared by
 *  move- and resize-time guides. Materialised objects (the texts/shapes the user
 *  is arranging) contribute left/centre/right and top/middle/bottom. Page text
 *  lines contribute EDGES ONLY — snapping to the arbitrary mid-point of some line
 *  felt like aligning "between letters"; edges give clean text columns/rows.
 *  Targets are deduped on a 0.5pt grid so a shared margin is a single line. */
function collectTargets(
  objects: EditorObject[],
  lines: Rect[],
  id: ObjectId,
): { v: number[]; h: number[] } {
  const vSet = new Set<number>();
  const hSet = new Set<number>();
  const q = (n: number) => Math.round(n * 2) / 2;
  for (const o of objects) {
    if (o.id === id) continue;
    vSet.add(q(o.x));
    vSet.add(q(o.x + o.w / 2));
    vSet.add(q(o.x + o.w));
    hSet.add(q(o.y));
    hSet.add(q(o.y + o.h / 2));
    hSet.add(q(o.y + o.h));
  }
  for (const l of lines) {
    vSet.add(q(l.x));
    vSet.add(q(l.x + l.width));
    hSet.add(q(l.y));
    hSet.add(q(l.y + l.height));
  }
  return { v: [...vSet], h: [...hSet] };
}

/** Nearest target within `tol` of `value`, or null. */
function nearestTarget(value: number, targets: number[], tol: number): number | null {
  let pick: number | null = null;
  let bestDiff = tol;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d <= bestDiff) {
      bestDiff = d;
      pick = t;
    }
  }
  return pick;
}

/** Alignment guides while RESIZING: only the edge(s) the handle moves snap.
 *  A corner handle moves one vertical + one horizontal edge (both axes); a side
 *  handle moves a single edge (its own axis). With `snap`, magnetize that edge. */
function resizeGuides(
  box: { x: number; y: number; w: number; h: number },
  handle: ResizeHandle,
  id: ObjectId,
  objects: EditorObject[],
  lines: Rect[],
  scale: number,
  snap: boolean,
  min = 8,
): { box: { x: number; y: number; w: number; h: number }; vx: number | null; hy: number | null } {
  const tol = 5 / scale;
  const { v: vTargets, h: hTargets } = collectTargets(objects, lines, id);
  let { x, y, w, h } = box;
  let vx: number | null = null;
  let hy: number | null = null;
  if (handle.includes('e')) {
    const t = nearestTarget(x + w, vTargets, tol);
    if (t !== null) {
      vx = t;
      if (snap) w = Math.max(min, t - x);
    }
  } else if (handle.includes('w')) {
    const right = x + w;
    const t = nearestTarget(x, vTargets, tol);
    if (t !== null) {
      vx = t;
      if (snap) {
        w = Math.max(min, right - t);
        x = right - w;
      }
    }
  }
  if (handle.includes('s')) {
    const t = nearestTarget(y + h, hTargets, tol);
    if (t !== null) {
      hy = t;
      if (snap) h = Math.max(min, t - y);
    }
  } else if (handle.includes('n')) {
    const bottom = y + h;
    const t = nearestTarget(y, hTargets, tol);
    if (t !== null) {
      hy = t;
      if (snap) {
        h = Math.max(min, bottom - t);
        y = bottom - h;
      }
    }
  }
  return { box: { x, y, w, h }, vx, hy };
}

/** The frame the box currently sits in: the other object / PDF line box that it
 *  overlaps most. Shown translucent-grey while resizing for spatial context. */
function containerFrame(
  box: { x: number; y: number; w: number; h: number },
  id: ObjectId,
  objects: EditorObject[],
  lines: Rect[],
): Rect | null {
  const candidates: Rect[] = [
    ...objects
      .filter((o) => o.id !== id)
      .map((o) => ({ x: o.x, y: o.y, width: o.w, height: o.h })),
    ...lines,
  ];
  let best: Rect | null = null;
  let bestArea = 0;
  for (const r of candidates) {
    const ix = Math.min(box.x + box.w, r.x + r.width) - Math.max(box.x, r.x);
    const iy = Math.min(box.y + box.h, r.y + r.height) - Math.max(box.y, r.y);
    if (ix <= 0 || iy <= 0) continue;
    const area = ix * iy;
    if (area > bestArea) {
      bestArea = area;
      best = r;
    }
  }
  return best;
}

/** Copy — two overlapping documents. */
function CopyIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <rect x="2.5" y="2.5" width="8" height="9.5" rx="1.3" fill="#fff" stroke="#555" />
      <rect x="5.5" y="5" width="8" height="9.5" rx="1.3" fill="#fff" stroke="#555" />
    </svg>
  );
}

/** Paste — a clipboard. */
function PasteIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <rect x="3" y="3" width="10" height="11.5" rx="1.3" fill="#fff" stroke="#555" />
      <rect x="6" y="1.6" width="4" height="2.6" rx="0.7" fill="#555" />
    </svg>
  );
}

/** Crop marks — fit the frame to the text. */
function CropIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <path d="M5 1 V11 H15" fill="none" stroke="#444" strokeWidth="1.4" />
      <path d="M1 5 H11 V15" fill="none" stroke="#444" strokeWidth="1.4" />
    </svg>
  );
}

/** Bring-to-front: the highlighted square sits in front of the other. */
function BringForwardIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <rect x="2.5" y="2.5" width="8" height="8" rx="1.5" fill="#fff" stroke="#9aa0a6" />
      <rect x="6" y="6" width="8" height="8" rx="1.5" fill="var(--accent)" />
    </svg>
  );
}

/** Send-to-back: the highlighted square sits behind the other. */
function SendBackwardIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <rect x="2.5" y="2.5" width="8" height="8" rx="1.5" fill="var(--accent)" />
      <rect x="6" y="6" width="8" height="8" rx="1.5" fill="#fff" stroke="#9aa0a6" />
    </svg>
  );
}

const layerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
};

// Floating action bar centred just above the selected object's frame. A high
// z-index keeps it above every other element so its clicks never fall through
// to whatever element happens to overlap it (frames no longer self-elevate).
const barStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 'calc(100% + 8px)',
  transform: 'translateX(-50%)',
  display: 'flex',
  gap: 2,
  padding: 3,
  background: '#fff',
  border: '1px solid #cfcfcf',
  borderRadius: 6,
  boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
  pointerEvents: 'auto',
  whiteSpace: 'nowrap',
  zIndex: 1000,
};

const barBtn: CSSProperties = {
  width: 26,
  height: 26,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 15,
  lineHeight: 1,
};

// Always-visible drag grip at the box's top-left corner.
const moveGripStyle: CSSProperties = {
  position: 'absolute',
  left: -7,
  top: -7,
  width: 14,
  height: 14,
  background: 'var(--accent)',
  border: '2px solid #fff',
  borderRadius: 3,
  boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
  cursor: 'move',
  pointerEvents: 'auto',
};

const imgStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'block',
  objectFit: 'fill',
};

const textStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  border: 'none',
  outline: 'none',
  padding: 0,
  margin: 0,
  resize: 'none',
  overflow: 'hidden',
  lineHeight: 1.15,
  boxSizing: 'border-box',
};

function rotateGripStyle(c: 'nw' | 'ne' | 'sw' | 'se'): CSSProperties {
  const size = 18;
  const off = -(size + 4); // sit a bit beyond the corner / resize squares
  const at: Record<typeof c, CSSProperties> = {
    nw: { left: off, top: off },
    ne: { right: off, top: off },
    sw: { left: off, bottom: off },
    se: { right: off, bottom: off },
  };
  return {
    position: 'absolute',
    width: size,
    height: size,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    lineHeight: 1,
    color: 'var(--accent)',
    background: '#fff',
    border: '1px solid #cfcfcf',
    borderRadius: '50%',
    boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
    cursor: 'grab',
    pointerEvents: 'auto',
    userSelect: 'none',
    ...at[c],
  };
}

function handleStyle(h: ResizeHandle): CSSProperties {
  const size = 8;
  const at: Record<ResizeHandle, CSSProperties> = {
    nw: { left: -size / 2, top: -size / 2, cursor: 'nwse-resize' },
    ne: { right: -size / 2, top: -size / 2, cursor: 'nesw-resize' },
    sw: { left: -size / 2, bottom: -size / 2, cursor: 'nesw-resize' },
    se: { right: -size / 2, bottom: -size / 2, cursor: 'nwse-resize' },
    n: { left: `calc(50% - ${size / 2}px)`, top: -size / 2, cursor: 'ns-resize' },
    s: { left: `calc(50% - ${size / 2}px)`, bottom: -size / 2, cursor: 'ns-resize' },
    e: { right: -size / 2, top: `calc(50% - ${size / 2}px)`, cursor: 'ew-resize' },
    w: { left: -size / 2, top: `calc(50% - ${size / 2}px)`, cursor: 'ew-resize' },
  };
  return {
    position: 'absolute',
    width: size,
    height: size,
    background: '#fff',
    border: '1px solid var(--accent)',
    pointerEvents: 'auto',
    ...at[h],
  };
}
