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

const indigo = [16, 185, 129]
const indigoDark = [5, 150, 105]
const paper = [248, 250, 252]
const ring = [199, 205, 222]
const orange = [245, 158, 11]

// calendar body
roundRect(40, 52, 216, 216, 32, indigo)
// header band
roundRect(40, 52, 216, 98, 32, indigoDark)
roundRect(40, 80, 216, 98, 0, indigoDark)
// binder rings
roundRect(92, 36, 108, 68, 7, paper)
roundRect(148, 36, 164, 68, 7, paper)
// white page
roundRect(56, 110, 200, 202, 14, paper)
// checklist: green dot + grey line per row
const line = [205, 213, 225]
for (const y of [124, 150, 176]) {
  roundRect(72, y, 88, y + 16, 8, indigo)
  roundRect(98, y + 4, 184, y + 12, 4, line)
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
