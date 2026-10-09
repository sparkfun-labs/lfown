// LFOWN — token artwork at the size a list shows it, loaded when it is about to be seen.

const OWN_ORIGINS = new Set(['https://letsfuckingown.fun'])
const OWN_IMAGE = /^\/i\/[0-9a-f-]{36}\.(png|jpg|webp|gif)$/

/**
 * The small WebP copy of an image the site hosts (/i/<key>?w=), or `src` unchanged for
 * anything hosted elsewhere. Lists show artwork 42 to 56 pixels wide; the originals run
 * to 300 KB each.
 */
export function thumb(src, width = 160) {
  try {
    const u = new URL(src, location.origin)
    if ((u.origin === location.origin || OWN_ORIGINS.has(u.origin)) && OWN_IMAGE.test(u.pathname)) return `${u.origin}${u.pathname}?w=${width}`
  } catch { /* not a URL: leave it to the caller */ }
  return src
}

const waiting = new WeakMap()
let observer = null

/**
 * Runs `load` once `el` comes within a screen or so of the viewport, instead of for every
 * card on the page at once. Cards hidden by a tab never load until the tab shows them.
 */
export function whenNear(el, load) {
  if (typeof IntersectionObserver !== 'function') return load()
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      observer.unobserve(entry.target)
      const fn = waiting.get(entry.target)
      waiting.delete(entry.target)
      fn?.()
    }
  }, { rootMargin: '600px 0px' })
  waiting.set(el, load)
  observer.observe(el)
}
