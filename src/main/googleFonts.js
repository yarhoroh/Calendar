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

// ONE common clone table (src/shared/fontClones) — the same the renderer's similar() uses
import { cloneFor } from '../shared/fontClones'
export function googleCloneFor(family) {
  return cloneFor(family)?.google || null
}

// family + style → REAL TrueType file cached in userData/fonts — that folder is scanned by
// systemFonts, so once downloaded the face resolves like any installed font (and CAN be embedded
// by the PDF insert pipeline, unlike woff2). The old-IE UA makes css2 serve static TTF urls.
const UA_TTF = 'Mozilla/5.0 (Windows NT 6.1; Trident/5.0)'
const inflight = new Map()
export async function getGoogleFontTTF(family, bold = false, italic = false) {
  const fam = String(family || '').trim()
  if (!fam || !/^[\w \-]+$/.test(fam)) return null
  const key = `${fam}|${bold ? 'b' : ''}${italic ? 'i' : ''}`
  if (inflight.has(key)) return inflight.get(key)
  const p = (async () => {
    const dir = join(app.getPath('userData'), 'fonts')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, `${fam.replace(/[^\w]/g, '_')}-${italic ? 1 : 0}${bold ? 700 : 400}.ttf`)
    if (existsSync(file)) return file
    try {
      const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}:ital,wght@${italic ? 1 : 0},${bold ? 700 : 400}`
      const res = await net.fetch(url, { headers: { 'User-Agent': UA_TTF } })
      if (!res.ok) return null
      const css = await res.text()
      const m = css.match(/url\((https:[^)]+\.ttf)\)/)
      if (!m) return null
      const fr = await net.fetch(m[1])
      if (!fr.ok) return null
      const buf = Buffer.from(await fr.arrayBuffer())
      if (buf.length < 1000) return null
      writeFileSync(file, buf)
      console.log(`[fonts] Google TTF cached: ${fam}${bold ? ' bold' : ''}${italic ? ' italic' : ''}`)
      return file
    } catch { return null }
  })().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

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
