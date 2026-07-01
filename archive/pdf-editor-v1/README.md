# PDF-редактор v1 (хирургический) — АРХИВ

Копии рабочего кода v1 на момент коммита `2bd4a63` (тег `pdf-editor-v1-surgical`,
ветка `archive/pdf-editor-v1-surgical`). Лежит здесь, чтобы **видеть достигнутое
и переиспользовать куски при сборке v2 без git-checkout**.

Это КОПИИ. Живой код v1 — в git-теге. v2 строим в `src/…` заново (дерево объектов).

## Что тут есть и что переиспользовать в v2

**pdf/pdfViewer.worker.js** — движок на MuPDF-WASM. Полезное:
- `tokenizeContent(masked)` — правильный токенайзер потока (операторы, прилепленные
  к операнду: `<hex>Tj`, `[...]TJ`). КРИТИЧНО, без него всё мажет.
- `maskStreamOperands` — маскировка строк/hex (сохранение длины/офсетов).
- `collectPageShows(pageObj, H)` — рекурсивный обход страницы + form-XObject'ов
  (по `Do`, поток формы по номеру объекта, CTM = Matrix × CTM_на_Do): каждый
  показ с device-позицией, потоком, индексом, `Tm`, `Tz/Tc/Ts`, шрифтом.
- `readStreamNum/writeStreamNum` — чтение/запись потока по номеру объекта
  (0=страница→`readPageContent`, иначе `doc.newIndirect(num)`).
- `findTextShows`, `topLevelQBlocks`, `blockBaseScales` — разбор показов/блоков.
- Device-проход: точный размер (`hypot(m[2],m[3])`) и hScale глифа.
- `ensureEditFont`/`encodeGlyphs`/`collectEmbeddedFonts`/`embeddedBytesByName` —
  встраивание шрифта (CID Identity-H), кодирование в glyph-id, родные байты
  встроенного шрифта PDF, фильтр `sfntHasTable(cmap)`.
- move текста правкой `Tm` (`de=dx/sa, df=-dy/sd`); move вектора — cm-обёртка блока.

**pdf/pdfModel.js** — разбор stext в runs: стили, super/sub, выравнивание,
межстрочный/абзацный интервал, `splitTableBlock` (колонки по COL_GAP).

**pdf/StylePanel.jsx** — боковая панель FORMAT (шрифт/размер/цвет/интервалы/
выравнивание/списки), поля-колонки, кнопка «Применить».

**pdf/InlineTextEditor.jsx** — inline HTML-редактор (в v2, вероятно, не нужен —
правим через боковую панель, рендерит MuPDF).

**pdf/PdfEditor.jsx / SelectLayer.jsx / pdfEngine.js / PdfEditorTab.jsx** — UI:
рамки/выделение/marquee/move, воркер-фасад, undo, зум.

**main/systemFonts.js** — подбор системных шрифтов, `fontBytesFor`, алиасы
(Liberation-first), `fontFileFor`.

## Известные факты (см. память pdf-editor-engine / pdf-editor-architecture)
- Весь текст `YAR04042023` — в ОДНОМ `q..Q` блоке obj#38 (516 показов);
  XObject'ы там — appearance-стримы аннотаций. Поэтому move текста = правка `Tm`.
- Subset-CID шрифты без `cmap` браузер (@font-face) не грузит.
