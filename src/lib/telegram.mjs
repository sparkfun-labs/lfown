// LFOwn — telling a Telegram group what just happened.
//
// Two moments are worth a message: a coin opening, and a coin graduating. Both are
// already detected elsewhere in the worker — this only carries the news.
//
// Silent when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set, so the site runs
// exactly as before without them. A post that fails is logged and dropped: a group
// chat is never worth failing a graduation over.

const API = 'https://api.telegram.org'

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
/** Telegram's HTML mode. Token names and symbols are whatever a creator typed. */
export const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ESCAPE[c])

/**
 * Posts to the group. `photo` is sent as a URL for Telegram to fetch itself, which
 * is why the image endpoint has to stay publicly readable.
 *
 * `preview` names the page the card should be built from. Telegram otherwise takes
 * the first url it finds *in the text*, and these messages carry none: their links
 * are anchors, so the url lives in an entity where that search does not look.
 */
export async function announce(env, { text, photo, preview }) {
  const token = env.TELEGRAM_BOT_TOKEN
  const chat = env.TELEGRAM_CHAT_ID
  if (!token || !chat) return { skipped: true }

  const [method, body] = photo
    ? ['sendPhoto', { chat_id: chat, photo, caption: text, parse_mode: 'HTML' }]
    : ['sendMessage', {
        chat_id: chat, text, parse_mode: 'HTML',
        link_preview_options: preview ? { url: preview, is_disabled: false } : { is_disabled: false },
      }]

  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const answer = await res.json().catch(() => null)
    if (!answer?.ok) {
      // Telegram says why in plain words; keep them, they are the whole diagnosis.
      console.error(`telegram ${method} refused: ${answer?.description ?? res.status}`)
      // An image it cannot fetch should not cost us the message.
      if (photo) return announce(env, { text, preview })
      return { ok: false }
    }
    return { ok: true }
  } catch (e) {
    console.error(`telegram ${method} failed: ${e.message}`)
    return { ok: false }
  }
}

const money = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })

/** Where a coin lives here. Also the page the group's link preview is built from. */
export const coinUrl = (coin, origin) => `${origin}/coins/${coin.baseMint}`

/**
 * The two ways in, in the order we would rather they were used.
 *
 * Jupiter's token page rather than a prefilled swap: it opens on the coin itself,
 * carries its chart and its own buy box, and needs no query string — which also
 * takes the escaped ampersand out of a message Telegram would reject if it were
 * ever malformed. Jupiter knows these pools from the moment they open, quoting
 * through the Dynamic Bonding Curve, so the page works before graduation too.
 */
const links = (coin, origin) =>
  // <code> is tap-to-copy in every Telegram client, which is the whole point of
  // printing an address somebody is about to paste into a wallet.
  `<code>${esc(coin.baseMint)}</code>\n\n` +
  `<a href="${esc(coinUrl(coin, origin))}">Buy on LFOWN ↗</a>\n` +
  `<a href="https://jup.ag/tokens/${esc(coin.baseMint)}">Buy on Jupiter ↗</a>`

/** A coin has opened. */
export function launchedMessage(coin, origin) {
  return `🚀 <b>${esc(coin.symbol || '?')}</b> paired with <b>${esc(coin.quoteSymbol || '?')}</b>\n` +
    links(coin, origin)
}

/** A curve has filled and its liquidity has moved to Meteora. */
export function graduatedMessage(coin, origin) {
  const quote = esc(coin.quoteSymbol || '?')
  const raised = Number(coin.quoteReserve ?? 0) / 1e6
  return `🎓 <b>${esc(coin.symbol || '?')}</b> graduated · raised ${money(raised)} ${quote}\n` +
    links(coin, origin)
}
