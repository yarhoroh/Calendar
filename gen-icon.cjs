// Generates resources/icon.png (256x256) — a small calendar glyph.
// No dependencies: builds a valid PNG with Node's zlib.
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const S = 256
const px = Buffer.alloc(S * S * 4) // RGBA

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return
  const i = (y * S + x) * 4
  const sa = a / 255
  const da = px[i + 3] / 255
  const oa = sa + da * (1 - sa)
  if (oa <= 0) return
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa)
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa)
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa)
  px[i + 3] = Math.round(oa * 255)
}

// anti-aliased rounded-rect fill via coverage on the boundary
function roundRect(x0, y0, x1, y1, rad, color) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      let cx = x
      let cy = y
      if (x < x0 + rad) cx = x0 + rad
      else if (x > x1 - rad) cx = x1 - rad
      if (y < y0 + rad) cy = y0 + rad
      else if (y > y1 - rad) cy = y1 - rad
      const dx = x - cx
      const dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      let cov = 1
      if (dist > rad - 1) cov = Math.max(0, rad - dist) // soft edge
      if (x < x0 || x > x1 || y < y0 || y > y1) continue
      if (cov > 0) blend(x, y, color[0], color[1], color[2], Math.round(255 * cov))
    }
  }
}

const indigo = [99, 102, 241]
const indigoDark = [79, 70, 229]
const paper = [248, 250, 252]
const ring = [199, 205, 222]
const orange = [245, 158, 11]

// body of the calendar
roundRect(40, 56, 216, 216, 30, indigo)
// header strip
roundRect(40, 56, 216, 104, 30, indigoDark)
roundRect(40, 92, 216, 104, 0, indigoDark)
// paper area
roundRect(52, 108, 204, 204, 16, paper)
// binder rings
roundRect(90, 40, 106, 74, 7, ring)
roundRect(150, 40, 166, 74, 7, ring)

// mini day grid (4 x 3), one highlighted
const gx = 66
const gy = 122
const cell = 26
const gap = 10
for (let r = 0; r < 3; r++) {
  for (let c = 0; c < 4; c++) {
    const x = gx + c * (cell + gap)
    const y = gy + r * (cell + gap)
    const isToday = r === 1 && c === 2
    roundRect(x, y, x + cell, y + cell, 6, isToday ? orange : indigo)
  }
}

// ---- encode PNG ----
const crcTable = (() => {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA

const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0 // filter: none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}
const idat = zlib.deflateSync(raw, { level: 9 })

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
])

const outDir = path.join(__dirname, 'resources')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'icon.png'), png)
console.log('wrote resources/icon.png', png.length, 'bytes')
