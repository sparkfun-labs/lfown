// LFOwn — a coin's share card, drawn as a PNG.
//
//   GET /og/coins/<mint>.png     1200×630, what X, Telegram and Discord show for a coin link
//
// The coin's artwork, its $TICKER and its market cap, on the site's own paper and ink. Laid
// out with satori (a tree of flexbox nodes into SVG) and rasterised with resvg, both of which
// run in a Worker. Fonts come from Google Fonts once per isolate and are then kept in the
// edge cache; the card itself is cached for ten minutes, so a link pasted into a busy
// channel is drawn once and the number on it is never older than that.

// satori's wasm build, handed its layout engine as a module: the default build, and the
// newer ones' text shaper, locate their wasm through import.meta.url, which a Worker does
// not have.
import satori, { init as initSatori } from 'satori/wasm'
import initYoga from 'yoga-wasm-web'
import yogaWasm from 'yoga-wasm-web/dist/yoga.wasm'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'

const W = 1200
const H = 630
const CARD_TTL = 600

const C = { paper: '#FBF9F7', card: '#FFFFFF', ink: '#111010', soft: '#4A4644', red: '#F01414', rule: 'rgba(17,16,16,0.14)' }

// TTF, as the old CSS API hands it out: satori reads TTF, OTF and WOFF, not WOFF2.
const FONTS = [
  { name: 'Bricolage', weight: 800, url: 'https://fonts.gstatic.com/s/bricolagegrotesque/v9/3y9U6as8bTXq_nANBjzKo3IeZx8z6up5BeSl5jBNz_19PpbpMXuECpwUxJBOm_OJWiaaD30YfKfjZZoLvZvl-Moltw.ttf' },
  { name: 'Martian', weight: 400, url: 'https://fonts.gstatic.com/s/martianmono/v6/2V08KIcADoYhV6w87xrTKjs4CYElh_VS9YA4TlTnQzaVMIE6j15dYY1qu_6RBbo.ttf' },
  { name: 'Martian', weight: 600, url: 'https://fonts.gstatic.com/s/martianmono/v6/2V08KIcADoYhV6w87xrTKjs4CYElh_VS9YA4TlTnQzaVMIE6j15dYY20vP6RBbo.ttf' },
]

let ready = null
let fonts = null
async function prepare() {
  ready ??= Promise.all([initWasm(resvgWasm), initYoga(yogaWasm).then(initSatori)])
  fonts ??= Promise.all(FONTS.map(async (f) => {
    const res = await fetch(f.url, { cf: { cacheTtl: 30 * 86400, cacheEverything: true } })
    if (!res.ok) throw new Error(`font ${f.name} ${f.weight}: ${res.status}`)
    return { name: f.name, weight: f.weight, style: 'normal', data: await res.arrayBuffer() }
  })).catch((e) => { fonts = null; throw e })
  await ready
  return fonts
}

// A node for satori: the shape React would produce, without React.
// Every box is a flex box, as satori requires of any with more than one child.
const h = (type, style, ...children) => ({ type, props: { style: { display: 'flex', ...style }, children: children.flat().filter((c) => c != null && c !== false) } })
const img = (src, style) => ({ type: 'img', props: { src, style } })

const toBase64 = (bytes) => {
  let s = ''
  const view = new Uint8Array(bytes)
  for (let i = 0; i < view.length; i += 0x8000) s += String.fromCharCode(...view.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Dollars, short: $45.4K. */
export function money(n) {
  if (!isFinite(n) || n <= 0) return '—'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(n >= 1e4 ? 1 : 2)}K`
  return `$${n.toFixed(2)}`
}

/**
 * The card for one coin. `coin` is its launches entry; `artwork` its image as bytes and
 * type, or null; `marketCap` in dollars, or null when unknown; `logo` the
 * LFOwn mark as PNG bytes; `bonded` how far along its curve, in percent.
 */
export async function renderCard({ coin, artwork, marketCap, logo, bonded }) {
  const fontList = await prepare()
  const symbol = String(coin.symbol ?? '?').slice(0, 14).toUpperCase()
  const name = String(coin.name ?? '').slice(0, 40)
  const quote = String(coin.quoteSymbol ?? '').slice(0, 12)
  // The ticker as big as it fits in the 580 pixels beside the artwork, from each letter's
  // rough width in this face (in ems): W and M run wide, I and 1 narrow.
  const em = (ch) => (/[WM]/.test(ch) ? 0.98 : /[I1]/.test(ch) ? 0.34 : /[$J]/.test(ch) ? 0.62 : 0.74)
  const tickerSize = Math.min(168, Math.floor(580 / [...`$${symbol}`].reduce((w, ch) => w + em(ch), 0)))
  const status = coin.isMigrated ? 'GRADUATED · METEORA DAMM V2' : `ON THE CURVE · ${Math.round(bonded ?? 0)}% BONDED`

  // Artwork resvg can draw: PNG, JPEG, GIF. Anything else gets the ticker's initial instead.
  const art = artwork && /image\/(png|jpe?g|gif)/.test(artwork.type)
    ? img(`data:${artwork.type};base64,${toBase64(artwork.bytes)}`, { width: 400, height: 400, objectFit: 'cover' })
    : h('div', { width: 400, height: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.red, color: '#fff', fontFamily: 'Bricolage', fontSize: 220 }, symbol.slice(0, 1))

  const label = (text, color = C.soft) => h('div', { fontFamily: 'Martian', fontSize: 18, letterSpacing: 4, color, textTransform: 'uppercase' }, text)

  const tree = h('div', {
    width: W, height: H, display: 'flex', flexDirection: 'column', background: C.paper, fontFamily: 'Martian', color: C.ink, position: 'relative',
    // The site's ruled paper.
    backgroundImage: `repeating-linear-gradient(90deg, transparent 0px, transparent 119px, ${C.rule} 119px, ${C.rule} 120px)`,
  },
    h('div', { display: 'flex', flex: 1, padding: '84px 72px 0 72px', gap: 64 },
      // The artwork, framed as the site frames a card: ink border, red block shadow.
      h('div', { display: 'flex', width: 412, height: 412, flexShrink: 0, border: `6px solid ${C.ink}`, boxShadow: `14px 14px 0 ${C.red}`, background: C.card }, art),
      h('div', { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, paddingTop: 4 },
        label(quote ? `Paired with ${quote}` : 'On LFOwn', C.red),
        h('div', { fontFamily: 'Bricolage', fontSize: tickerSize, lineHeight: 1, letterSpacing: -4, marginTop: 14 }, `$${symbol}`),
        name && name.toUpperCase() !== symbol ? h('div', { fontSize: 22, color: C.soft, marginTop: 10 }, name) : null,
        h('div', { flexDirection: 'column', marginTop: 'auto', marginBottom: 6 },
          label('Market cap'),
          h('div', { fontFamily: 'Bricolage', fontSize: 104, letterSpacing: -3, lineHeight: 1, marginTop: 12 }, marketCap ? money(marketCap) : '—')))),
    // The foot: the coin's status, and whose site this is.
    h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 96, marginTop: 34, padding: '0 72px', background: C.ink, color: C.paper },
      h('div', { fontSize: 18, letterSpacing: 4, fontWeight: 600 }, status),
      h('div', { display: 'flex', alignItems: 'center', gap: 18 },
        logo ? img(`data:image/png;base64,${toBase64(logo)}`, { height: 46, width: 68 }) : null,
        h('div', { fontSize: 20, letterSpacing: 2 }, 'letsfuckingown.fun'))))

  const svg = await satori(tree, { width: W, height: H, fonts: fontList })
  return new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng()
}

/**
 * GET /og/coins/<mint>.png — from the edge cache when it is there, drawn otherwise.
 * `load(mint)` gathers what the card needs, or null for a coin LFOwn does not know.
 */
export async function handleOg(url, request, env, ctx, load) {
  const mint = url.pathname.match(/^\/og\/coins\/([1-9A-HJ-NP-Za-km-z]{32,44})\.png$/)?.[1]
  if (!mint) return new Response('not found', { status: 404 })
  const cache = caches.default
  const key = new Request(`${url.origin}/og/coins/${mint}.png`, { method: 'GET' })
  const hit = await cache.match(key)
  if (hit) return hit
  const input = await load(mint)
  if (!input) return new Response('not found', { status: 404 })
  let png
  try {
    png = await renderCard(input)
  } catch (e) {
    console.error(`share card for ${mint} failed: ${e.message}`, e.stack)
    // The site's own card rather than nothing: a link should never show a blank box.
    return Response.redirect(`${url.origin}/assets/og-card.png`, 302)
  }
  const res = new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': `public, max-age=${CARD_TTL}` } })
  ctx.waitUntil(cache.put(key, res.clone()))
  return res
}
