// Reusable MIME helpers shared by the sync (to list attachments without
// downloading bodies) and the reader/download path. In IMAP an attachment is a
// part of the message's MIME tree, not a separate list — imapflow already parses
// BODYSTRUCTURE into a nested object, so we just walk it.

// Walk an imapflow BODYSTRUCTURE node and collect the real (downloadable)
// attachments: Content-Disposition: attachment, or any leaf with a filename that
// isn't an inline body image. Each keeps its MIME `part` number so the file can be
// lazily fetched later via BODY.PEEK[part].
export function extractAttachments(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    for (const child of node.childNodes) extractAttachments(child, out)
    return out
  }
  const type = (node.type || '').toLowerCase()
  if (type.startsWith('multipart/')) return out
  const disposition = (node.disposition || '').toLowerCase()
  const filename = node.dispositionParameters?.filename || node.parameters?.name || ''
  const isAttachment = disposition === 'attachment' || (!!filename && disposition !== 'inline')
  if (!isAttachment) return out
  out.push({
    part: node.part || '1',
    name: filename || 'attachment',
    contentType: type || 'application/octet-stream',
    size: node.size || 0,
    contentId: node.id || null
  })
  return out
}

// Walk the structure and pick only the parts needed to DISPLAY the message: the
// text/html body, the text/plain fallback, and inline (CID) images. Attachment
// parts are deliberately ignored so the reader can show the body without
// downloading attachment bytes. Returns { htmlPart, textPart, inline:[{part,cid,type}] }.
export function pickBodyParts(node, acc) {
  acc = acc || { htmlPart: null, textPart: null, inline: [] }
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    for (const child of node.childNodes) pickBodyParts(child, acc)
    return acc
  }
  const type = (node.type || '').toLowerCase()
  const disp = (node.disposition || '').toLowerCase()
  const filename = node.dispositionParameters?.filename || node.parameters?.name || ''
  const cid = node.id ? String(node.id).replace(/[<>]/g, '') : null
  if (type.startsWith('image/') && (cid || disp === 'inline')) {
    acc.inline.push({ part: node.part || '1', cid, type })
    return acc
  }
  if (disp === 'attachment' || filename) return acc // a real attachment — not body
  if (type === 'text/html' && !acc.htmlPart) acc.htmlPart = node.part || '1'
  else if (type === 'text/plain' && !acc.textPart) acc.textPart = node.part || '1'
  return acc
}
