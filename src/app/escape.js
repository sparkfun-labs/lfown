// LFOwn — treating chain data as hostile.
//
// A token's name, symbol and image come from its Metaplex metadata, which whoever
// launched the coin wrote. Interpolating that into innerHTML let a coin called
// `<img src=x onerror=…>` run script on our origin — the origin where launch and
// swap transactions are built before a wallet signs them.

const HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** For text and quoted attribute values alike. */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML[c])

/**
 * For src/href. Anything but http(s) is dropped — `javascript:` in an image URL is
 * the same hole wearing a different hat.
 */
export function safeUrl(value) {
  const raw = String(value ?? '').trim()
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? esc(url.href) : ''
  } catch {
    return ''
  }
}
