import { app, net } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// Fetch a Google font program once and cache it under userData, so the PDF editor can substitute a
// missing/non-loadable embedded font with a close match (metric-compatible families like Arimo /
// Tinos / Cousine / Carlito mirror Arial / Times / Courier / Calibri). main downloads the bytes
// (renderer then loads them as a FontFace from bytes — no remote URL, so the CSP stays strict).

const cacheDir = () => {
  const d = join(app.getPath('userData'), 'google-fonts')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// family + weight/style → font bytes (woff2), cached on disk. Returns { ok, data } or { ok:false }.
export async function getGoogleFont(family, bold, italic) {
  const variant = `${italic ? 'i' : 'r'}${bold ? '700' : '400'}`
  const file = join(cacheDir(), `${family.replace(/[^\w]/g, '_')}-${variant}.woff2`)
  if (existsSync(file)) {
    try {
      return { ok: true, data: readFileSync(file) }
    } catch {
      /* fall through to refetch */
    }
  }
  try {
    const ital = italic ? '1' : '0'
    const wght = bold ? '700' : '400'
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@${ital},${wght}&display=swap`
    // a modern UA makes Google serve woff2 (smallest); without it we'd get TTF
    const cssRes = await net.fetch(cssUrl, { headers: { 'User-Agent': UA } })
    if (!cssRes.ok) return { ok: false }
    const css = await cssRes.text()
    const m = css.match(/url\((https:\/\/[^)]+\.woff2)\)/)
    if (!m) return { ok: false }
    const fontRes = await net.fetch(m[1])
    if (!fontRes.ok) return { ok: false }
    const buf = Buffer.from(await fontRes.arrayBuffer())
    writeFileSync(file, buf)
    return { ok: true, data: buf }
  } catch (e) {
    return { ok: false, error: e.message } // offline / blocked — caller falls back to a system font
  }
}
