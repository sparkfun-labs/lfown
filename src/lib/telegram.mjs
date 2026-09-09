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
 */
export async function announce(env, { text, photo }) {
  const token = env.TELEGRAM_BOT_TOKEN
  const chat = env.TELEGRAM_CHAT_ID
  if (!token || !chat) return { skipped: true }

  const [method, body] = photo
    ? ['sendPhoto', { chat_id: chat, photo, caption: text, parse_mode: 'HTML' }]
    : ['sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: false } }]

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
      if (photo) return announce(env, { text })
      return { ok: false }
    }
    return { ok: true }
  } catch (e) {
    console.error(`telegram ${method} failed: ${e.message}`)
    return { ok: false }
  }
}

const money = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })

/**
 * Jupiter routes into these pools from the moment they open — verified against a
 * coin minutes old, quoted through the Dynamic Bonding Curve — so the link works
 * before graduation as well as after.
 *
 * Kept as an anchor below the bare LFOwn url: Telegram builds its preview from the
 * first link it finds, and the preview worth having is the coin's own card.
 */
const jupiter = (coin) =>
  `<a href="https://jup.ag/swap?sell=${esc(coin.quoteMint)}&amp;buy=${esc(coin.baseMint)}">Buy on Jupiter ↗</a>`

/** A coin has opened. */
export function launchedMessage(coin, origin) {
  const symbol = esc(coin.symbol || '?')
  const name = esc(coin.name || symbol)
  const quote = esc(coin.quoteSymbol || '?')
  return `🚀 <b>${symbol}</b> just launched\n` +
    `${name} · paired with <b>${quote}</b>, a MetaDAO ownership coin\n` +
    (coin.threshold ? `Graduates at ${money(coin.threshold)} ${quote}\n` : '') +
    `${origin}/coins/${coin.baseMint}\n` +
    jupiter(coin)
}

/** A curve has filled and its liquidity has moved to Meteora. */
export function graduatedMessage(coin, origin) {
  const symbol = esc(coin.symbol || '?')
  const quote = esc(coin.quoteSymbol || '?')
  const raised = Number(coin.quoteReserve ?? 0) / 1e6
  return `🎓 <b>${symbol}</b> graduated\n` +
    `Raised ${money(raised)} ${quote} and moved to its Meteora pool. Liquidity is locked; ` +
    `fees keep flowing to the creator and the LFOwn DAO.\n` +
    `${origin}/coins/${coin.baseMint}\n` +
    jupiter(coin)
}
