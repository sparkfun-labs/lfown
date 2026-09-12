// LFOwn — telling X what just happened.
//
// The same two moments as the Telegram bot, in the shape X takes them: 280
// characters, no markup, and the picture uploaded rather than linked.
//
// Silent when the four credentials are missing, so the site runs exactly as before
// without them. A post that fails is logged and dropped — a timeline is never worth
// failing a graduation over.

const API = 'https://api.x.com/2/tweets'
// v2, because the v1.1 endpoint on upload.twitter.com has been retired. The answer
// moved with it: the id arrives as `data.id` where v1.1 put `media_id_string` at
// the top level.
const UPLOAD = 'https://api.x.com/2/media/upload'

/**
 * Percent-encoding as OAuth defines it: RFC 3986 unreserved characters only.
 *
 * `encodeURIComponent` leaves `!*'()` alone, and OAuth requires them escaped. One
 * unescaped apostrophe in a coin's name would put the signature out of step with
 * the request and every post would come back 401 with nothing to point at.
 */
const enc = (v) => encodeURIComponent(String(v ?? ''))
  .replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** HMAC-SHA1 over the OAuth signature base string. */
async function sign(baseString, signingKey) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString))
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
}

/**
 * The Authorization header for one request.
 *
 * `extra` carries query-string parameters, which OAuth folds into the signature.
 * Bodies do not: these requests are JSON or multipart, and only an
 * application/x-www-form-urlencoded body would count — which is the reason the
 * image goes up as multipart rather than as a base64 form field.
 */
export async function authorize(creds, method, url, extra = {}) {
  const oauth = {
    oauth_consumer_key: creds.key,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: '1.0',
    ...(creds.nonce ? { oauth_nonce: creds.nonce } : {}),
    ...(creds.timestamp ? { oauth_timestamp: creds.timestamp } : {}),
  }
  const params = { ...oauth, ...extra }
  const normalised = Object.keys(params).sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`).join('&')
  const base = [method.toUpperCase(), enc(url), enc(normalised)].join('&')
  const signature = await sign(base, `${enc(creds.secret)}&${enc(creds.tokenSecret)}`)

  const header = { ...oauth, oauth_signature: signature }
  return {
    signature,
    base,
    header: 'OAuth ' + Object.keys(header).sort()
      .map((k) => `${enc(k)}="${enc(header[k])}"`).join(', '),
  }
}

/** The four secrets, or nothing at all. */
const credentials = (env) => {
  const c = {
    key: env.X_CONSUMER_KEY, secret: env.X_CONSUMER_SECRET,
    token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_SECRET,
  }
  return c.key && c.secret && c.token && c.tokenSecret ? c : null
}

/**
 * Puts the coin's picture on X and returns its media id.
 *
 * Takes the bytes rather than a url on purpose. A coin's artwork is usually served
 * by this very Worker from R2, and a Worker cannot fetch a url it serves itself —
 * the request never leaves and comes back 522. The caller reads R2 directly and
 * hands the result over; the same trap already cost us the OG card images.
 *
 * Multipart on purpose too: a form-urlencoded body would have to be folded into
 * the OAuth signature, which means signing the whole base64 of the image.
 */
async function uploadMedia(creds, { bytes, type }) {
  // X rejects anything over 5 MB on this endpoint, and a coin's artwork is
  // whatever its creator uploaded.
  if (bytes.byteLength > 5_000_000) throw new Error(`image too large (${Math.round(bytes.byteLength / 1024)} KB)`)

  const form = new FormData()
  form.append('media', new Blob([bytes], { type: type || 'image/png' }), 'coin.png')
  // Optional on a simple upload, but it is what tells X the picture is going on a
  // post rather than becoming an avatar or a subtitle track.
  form.append('media_category', 'tweet_image')

  const { header } = await authorize(creds, 'POST', UPLOAD)
  const up = await fetch(UPLOAD, { method: 'POST', headers: { authorization: header }, body: form })
  const body = await up.json().catch(() => null)
  // Read from either shape: v2 nests the id under `data`, v1.1 spelled it
  // `media_id_string` at the top level, and the post below wants the string either way.
  const id = body?.data?.id ?? body?.data?.media_id_string ?? body?.media_id_string
  if (!up.ok || !id) {
    throw new Error(`upload refused: ${body?.detail ?? body?.errors?.[0]?.message ?? body?.title ?? up.status}`)
  }
  return String(id)
}

/**
 * Posts to X. `image` is attempted and abandoned quietly — the words are the news,
 * and a picture X will not take is no reason to say nothing.
 */
export async function announce(env, { text, image }) {
  const creds = credentials(env)
  if (!creds) return { skipped: true }

  let mediaId = null
  if (image) {
    try { mediaId = await uploadMedia(creds, image) }
    catch (e) { console.error(`x: image not attached — ${e.message}`) }
  }

  const payload = { text, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) }
  try {
    const { header } = await authorize(creds, 'POST', API)
    const res = await fetch(API, {
      method: 'POST',
      headers: { authorization: header, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      // X says why in plain words; keep them, they are the whole diagnosis.
      console.error(`x refused: ${body?.detail ?? body?.title ?? res.status}`)
      return { ok: false }
    }
    return { ok: true, id: body?.data?.id }
  } catch (e) {
    console.error(`x failed: ${e.message}`)
    return { ok: false }
  }
}

const money = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
const coinUrl = (coin, origin) => `${origin}/coins/${coin.baseMint}`

/**
 * X counts every link as 23 characters however long it is, so the budget is 257 for
 * the words.
 *
 * Lines marked droppable go first when a long symbol overflows; the rest stay. The
 * contract address is never droppable — it is the one thing people come to a launch
 * post for, and a post without it gets "CA?" as its first reply.
 */
function fit(lines, url) {
  const kept = lines.filter((l) => (typeof l === 'string' ? l : l.text))
  const length = () => kept.map((l) => (typeof l === 'string' ? l : l.text)).join('\n').length + 2 + 23
  while (length() > 280) {
    const i = kept.map((l) => typeof l !== 'string' && l.drop).lastIndexOf(true)
    if (i === -1) break
    kept.splice(i, 1)
  }
  return `${kept.map((l) => (typeof l === 'string' ? l : l.text)).join('\n')}\n\n${url}`
}

/** A coin has opened. */
export function launchedMessage(coin, origin) {
  const symbol = coin.symbol || '?'
  const quote = coin.quoteSymbol || '?'
  return fit([
    `🚀 ${symbol} just launched`,
    { text: `Paired with ${quote}, a MetaDAO ownership coin.`, drop: true },
    { text: coin.threshold ? `Graduates at ${money(coin.threshold)} ${quote}.` : '', drop: true },
    `\nCA: ${coin.baseMint}`,
  ], coinUrl(coin, origin))
}

/** A curve has filled and its liquidity has moved to Meteora. */
export function graduatedMessage(coin, origin) {
  const symbol = coin.symbol || '?'
  const quote = coin.quoteSymbol || '?'
  const raised = Number(coin.quoteReserve ?? 0) / 1e6
  return fit([
    `🎓 ${symbol} graduated`,
    { text: `Raised ${money(raised)} ${quote} and moved to its Meteora pool.`, drop: true },
    { text: 'Liquidity locked for good; fees keep flowing to the creator and the LFOwn DAO.', drop: true },
    `\nCA: ${coin.baseMint}`,
  ], coinUrl(coin, origin))
}
