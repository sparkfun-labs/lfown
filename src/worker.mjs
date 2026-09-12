// LFOwn — the Worker. Serves the static site, the launch app, and a small API.
//
// The Helius key lives here and only here: the browser talks to /api/rpc, never
// to Helius directly, so the key is never shipped in client code.

import { buildRegistry, exitCost } from './lib/registry.mjs'
import { EXIT_SIZES, TIERS, MIN_TREASURY_USD, FEES } from './lib/config.mjs'
import { listLaunches, describeLaunch, launchEntry } from './lib/launches.mjs'
import { pendingPartnerFees } from './lib/fees.mjs'
import { lpPositions, buildLpClaim } from './lib/lp-fees.mjs'
import { feeReport } from './lib/fee-report.mjs'
import { readyToGraduate, graduate } from './lib/graduate.mjs'
import { sendAndConfirm } from './lib/confirm.mjs'
import { tradeHistory, ammLeg } from './lib/chart.mjs'
import * as telegram from './lib/telegram.mjs'
import * as x from './lib/x.mjs'

// The filter is part of the key: change the floor and yesterday's catalogue stops
// being served, without anyone having to remember to bump a version.
const CATALOGUE_KEY = `catalogue:v3:t${MIN_TREASURY_USD}`
// Bump these whenever the shape of what they hold changes. A deploy does not clear
// KV, so without a bump the old payload keeps being served until it expires — which
// is how a fix can ship and appear not to work for the next ten minutes.
const LAUNCHES_KEY = 'launches:v2'
// The list lives a day and is served for as long as it exists; past this age a
// request also pushes a rebuild behind its response. Nothing deletes it any more.
// A route that let anyone drop it let anyone make the next twenty visitors each pay
// for a full rebuild, and a rebuild is one program scan per config.
const LAUNCHES_FRESH = 15 * 60_000
const LAUNCHES_TTL = 86_400
// v4: "generated" no longer counts Meteora's cut, so a stored v3 report holds the
// same fields with different meanings — which is exactly what a bump is for.
// v5: every row now carries the wallet that launched it. A deploy does not clear KV,
// so without a bump the leaderboard would have read a day of rows with no wallet on
// them and shown nothing at all.
const FEES_KEY = 'fees:v5'
// How old the fee report may be before a request also triggers a rebuild behind it.
// The stored copy outlives this by a long way, so an expiry never lands on a visitor.
const FEES_FRESH = 60_000
// v3: one descriptor became a list of legs, so a graduated coin keeps a chart. The
// entry holds a shape, not just a value, so changing what is in it means changing
// the key — a stale descriptor silently produced empty charts the last time.
const CHART_KEY = (mint) => `chart:v3:${mint}`
// A chart nobody has opened for a month is built again the next time someone does.
// Without an expiry, every mint ever asked about stayed in KV for good.
const CHART_TTL = 30 * 86_400
// Which coins the Telegram group has already heard about, so a restart or a cache
// rebuild does not replay the whole catalogue into the chat.
// v2: one record per channel. A coin can reach Telegram and fail on X, and a single
// shared list could only ever be wrong one way or the other — either X never retries
// or Telegram posts twice. Migrated on read, so nothing is re-announced on deploy.
const ANNOUNCED_KEY = 'announced:v2'
const ANNOUNCED_KEY_V1 = 'announced:v1'
// A chart just rebuilt is not rebuilt again for a page view a second later. Short,
// because the redraw after someone's own trade has to be able to show it.
const CHART_COOLDOWN = 10_000
// How long an answer that cannot change is remembered, at the edge and in KV: a
// mint with no pool, a pool on somebody else's config. Each costs a program scan to
// work out, and remembering it means the same question is paid for once.
const MISS_TTL = 300
// The two schedules, spelled exactly as wrangler.jsonc declares them: the worker
// tells them apart by string, so these are one half of a pair that has to move together.
const FEE_SWEEP = '0 * * * *'
const CATALOGUE = '*/10 * * * *'
const WATCH = '* * * * *'
const CATALOGUE_TTL = 15 * 60

/** Read-only methods the browser is allowed to proxy. Nothing that can spend. */
const RPC_ALLOWED = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getTokenAccountBalance',
  'getTokenAccountsByOwner', 'getLatestBlockhash', 'getSignatureStatuses',
  'getMinimumBalanceForRentExemption', 'getSlot', 'simulateTransaction',
  'sendTransaction', 'getTransaction', 'getFeeForMessage',
  'getEpochInfo', 'getBlockHeight', 'getVersion', 'getTokenSupply',
  'getRecentPrioritizationFees', 'isBlockhashValid', 'getGenesisHash',
])
// One request may carry a JSON-RPC batch, and without a ceiling one request could
// carry a thousand calls, every one of them billed to us. The pages send one call
// at a time — web3.js only batches getTransactions, which nothing here uses — so
// ten is headroom rather than a limit anyone will feel.
const RPC_MAX_BATCH = 10
const RPC_MAX_BODY = 64 * 1024

// The routes that cost something to answer: a program scan, a Jupiter quote, an
// object in the bucket. They share one per-address ceiling; the RPC proxy has its
// own, because a trade polls it every second while a signature lands.
const HEAVY = ['/api/chart', '/api/launch', '/api/exit', '/api/graduate', '/api/image', '/api/metadata']

/**
 * The RPC proxy and the upload endpoints exist for this site's own pages. Nothing
 * here risks funds — the browser never sees a key and the proxy refuses the
 * expensive methods — but an open relay burns our RPC quota and fills our bucket
 * on someone else's whim. A cross-site browser cannot forge Origin; a script can,
 * so this is a speed bump and the per-address limits below are the fence.
 */
function sameOrigin(request, url, env) {
  const origin = request.headers.get('origin')
  if (!origin) return true // same-origin GETs and server-to-server calls send none
  const allowed = new Set([url.origin, env.PUBLIC_ORIGIN].filter(Boolean))
  if (env.PUBLIC_ORIGIN) allowed.add(env.PUBLIC_ORIGIN.replace('://', '://www.'))
  return allowed.has(origin)
}

/**
 * Per-address ceilings, enforced here so they hold even before the zone's WAF rule
 * is configured. They stop one script, not a botnet — the WAF rule on /api/* is the
 * layer above. A dev server without the bindings runs unlimited and says nothing
 * about it, which is what local work wants; a limiter that errors is treated the
 * same way, because a broken limiter should not take the site down with it.
 */
async function limited(limiter, request) {
  if (!limiter) return false
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown'
  try {
    const { success } = await limiter.limit({ key })
    return !success
  } catch (e) {
    console.error(`rate limiter unavailable: ${e.message}`)
    return false
  }
}

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  })

const tooMany = () => json({ error: 'too many requests from this address — slow down' }, { status: 429, headers: { 'retry-after': '60' } })

async function readCatalogue(env) {
  if (env.REGISTRY) {
    const cached = await env.REGISTRY.get(CATALOGUE_KEY, 'json')
    if (cached) return cached
  }
  const fresh = await buildRegistry(env.HELIUS_RPC)
  await writeCatalogue(env, fresh)
  return fresh
}

async function writeCatalogue(env, catalogue) {
  if (env.REGISTRY) {
    await env.REGISTRY.put(CATALOGUE_KEY, JSON.stringify(catalogue), { expirationTtl: CATALOGUE_TTL * 4 })
  }
}

// Builds in progress in this isolate, by name. Requests that land together share
// the one already running rather than each starting their own.
const inflight = new Map()

/**
 * Runs `build` unless it is already running, in which case a caller in the same
 * isolate is handed the running build and a caller elsewhere gets null and serves
 * what it has. Two layers because neither is enough alone: KV cannot make the
 * check-and-set atomic, so a burst of requests in the same millisecond all found
 * the lock free — and a map in memory is only shared within one isolate. The lock
 * expires on its own if a build dies.
 */
function withLock(env, name, build) {
  if (inflight.has(name)) return inflight.get(name)
  const run = (async () => {
    if (!env.REGISTRY) return build()
    const key = `rebuilding:${name}`
    if (await env.REGISTRY.get(key)) return null
    await env.REGISTRY.put(key, String(Date.now()), { expirationTtl: 120 })
    try {
      return await build()
    } finally {
      await env.REGISTRY.delete(key).catch(() => {})
    }
  })()
  inflight.set(name, run)
  return run.finally(() => inflight.delete(name))
}

/** Waits for somebody else's rebuild to land in KV, for a while. */
async function waitForKey(env, key, ms) {
  if (!env.REGISTRY) return null
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    const value = await env.REGISTRY.get(key, 'json')
    if (value) return value
  }
  return null
}

/** Rebuilds the launches list and stores it — unless another request already is. */
function rebuildLaunches(env) {
  return withLock(env, 'launches', async () => {
    const fresh = await collectLaunches(env)
    if (env.REGISTRY) await env.REGISTRY.put(LAUNCHES_KEY, JSON.stringify(fresh), { expirationTtl: LAUNCHES_TTL })
    return fresh
  })
}

const EMPTY_LAUNCHES = () => ({ updatedAt: new Date().toISOString(), count: 0, launches: [], pending: true })

/**
 * The launches list: served from KV, rebuilt behind the response once it is old,
 * and built in the open only when there is nothing stored at all — by one request,
 * while the others wait for that copy rather than each starting their own.
 */
async function readLaunches(env, ctx) {
  const cached = env.REGISTRY ? await env.REGISTRY.get(LAUNCHES_KEY, 'json') : null
  if (cached) {
    if (ctx && Date.now() - Date.parse(cached.updatedAt ?? '') > LAUNCHES_FRESH) {
      ctx.waitUntil(rebuildLaunches(env).catch((e) => console.error('launches rebuild failed:', e.message)))
    }
    return cached
  }
  console.log('launches: nothing stored, rebuilding the list')
  const built = await rebuildLaunches(env)
  if (built) return built
  return (await waitForKey(env, LAUNCHES_KEY, 25_000)) ?? EMPTY_LAUNCHES()
}

/** Adds a coin the list has not heard of, or updates one it has, without a rebuild. */
async function patchLaunches(env, mint, patch) {
  if (!env.REGISTRY) return
  const known = await env.REGISTRY.get(LAUNCHES_KEY, 'json')
  if (!known?.launches) return
  const entry = known.launches.find((l) => l.baseMint === mint)
  if (entry) Object.assign(entry, patch)
  else known.launches.unshift(patch) // newest first, which is how the list is sorted
  known.count = known.launches.length
  await env.REGISTRY.put(LAUNCHES_KEY, JSON.stringify(known), { expirationTtl: LAUNCHES_TTL })
}

async function handleApi(url, request, env, ctx) {
  const path = url.pathname

  if (path === '/api/rpc') {
    if (await limited(env.RPC_LIMITER, request)) return tooMany()
  } else if (HEAVY.some((p) => path === p || path.startsWith(`${p}/`))) {
    if (await limited(env.HEAVY_LIMITER, request)) return tooMany()
  }

  // The catalogue of ownership coins usable as a quote asset. Nothing is filtered
  // out for being thin — the exit cost is published instead.
  if (path === '/api/quote-assets') {
    const catalogue = await readCatalogue(env)
    return json(catalogue, {
      headers: { 'cache-control': `public, max-age=60, s-maxage=${CATALOGUE_TTL}` },
    })
  }

  // What a holder really gets selling `usd` worth of this coin into USDC, right now.
  if (path.startsWith('/api/exit/')) {
    const mint = path.slice('/api/exit/'.length)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json({ error: 'bad mint' }, { status: 400 })

    // Sizes are whatever the caller asks for, within reason: as many as the defaults,
    // whole dollars, no duplicates. Each one is a Jupiter quote, and an unbounded
    // list was an unbounded number of them from a single request.
    const asked = (url.searchParams.get('usd') ?? '').split(',').map(Number)
      .filter((n) => Number.isFinite(n) && n >= 1)
      .map((n) => Math.min(Math.round(n), 10_000_000))
    const sizes = [...new Set(asked.length ? asked : EXIT_SIZES)].slice(0, EXIT_SIZES.length)

    // Keyed on the sizes as normalised, so two spellings of one request share an answer.
    const cache = caches.default
    const cacheKey = new Request(`${url.origin}/api/exit/${mint}?usd=${sizes.join(',')}`, { method: 'GET' })
    const hit = await cache.match(cacheKey)
    if (hit) return hit

    const { coins } = await readCatalogue(env)
    const coin = coins.find((c) => c.mint === mint)
    if (!coin) return json({ error: 'not an ownership coin' }, { status: 404 })

    const exits = await Promise.all(sizes.map((usd) => exitCost(mint, coin.usdPrice, usd)))

    const res = json({ mint, symbol: coin.symbol, usdPrice: coin.usdPrice, exits },
      { headers: { 'cache-control': 'public, max-age=60' } })
    ctx.waitUntil(cache.put(cacheKey, res.clone()))
    return res
  }

  // Every coin launched on our configs, read from chain.
  if (path === '/api/launches') {
    const list = await readLaunches(env, ctx)
    return json(list, { headers: { 'cache-control': list.pending ? 'no-store' : 'public, max-age=30' } })
  }

  // What every coin has earned, for whom. Public on purpose: these numbers are on
  // chain anyway, and a launchpad that hides its own take has no business showing
  // creators theirs.
  // Served from cache even when the cache is old, with the rebuild pushed behind the
  // response. This report walks every pool and every graduated position and takes
  // about seven seconds; with a one-minute life, somebody paid those seven seconds
  // every single minute, and on a coin page that wait came before anything was drawn.
  if (path === '/api/fees') {
    const report = await readFeeReport(env, ctx)
    return json(report, { headers: { 'cache-control': report.pending ? 'no-store' : 'public, max-age=30' } })
  }

  // One coin, read from chain rather than from the catalogue: a launch that
  // confirmed a second ago has to open, and the cached list is up to ten minutes old.
  if (path.startsWith('/api/launch/')) {
    const mint = path.slice('/api/launch/'.length)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json({ error: 'bad mint' }, { status: 400 })

    const cache = caches.default
    const cacheKey = new Request(`${url.origin}${path}`, { method: 'GET' })
    const hit = await cache.match(cacheKey)
    if (hit) return hit

    // A coin the list already knows is answered from the list; the chain is for the
    // ones it has not caught up with.
    const listed = (await env.REGISTRY?.get(LAUNCHES_KEY, 'json'))?.launches?.find((l) => l.baseMint === mint)
    if (listed) return json(listed, { headers: { 'cache-control': 'public, max-age=15' } })

    const [{ Connection, PublicKey }, { DynamicBondingCurveClient }] = await Promise.all([
      import('@solana/web3.js'),
      import('@meteora-ag/dynamic-bonding-curve-sdk'),
    ])
    const connection = new Connection(env.HELIUS_RPC, 'confirmed')
    const client = new DynamicBondingCurveClient(connection, 'confirmed')
    const { coins } = await readCatalogue(env)

    // This lookup is a getProgramAccounts: trivial to ask for, expensive to answer.
    // A miss is remembered at the edge, not only by the browser that asked: a stream
    // of made-up mints from a script used to cost one scan each, whatever the
    // response said about caching.
    const launch = await describeLaunch(client, connection, PublicKey, mint, coins).catch(() => null)
    const res = launch
      ? json(launch, { headers: { 'cache-control': 'public, max-age=15' } })
      : json({ error: 'no pool for this mint' }, { status: 404, headers: { 'cache-control': `public, max-age=${MISS_TTL}` } })
    ctx.waitUntil(cache.put(cacheKey, res.clone()))
    return res
  }

  // The price history of one coin. Built once from every trade the pool has seen,
  // then extended: the stored `newest` signature is where the next fetch starts, so
  // only the first build of a busy coin is expensive.
  if (path.startsWith('/api/chart/')) {
    const mint = path.slice('/api/chart/'.length)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json({ error: 'bad mint' }, { status: 400 })

    const cache = caches.default
    const cacheKey = new Request(`${url.origin}${path}`, { method: 'GET' })
    const hit = await cache.match(cacheKey)
    if (hit) return hit

    const chart = await chartFor(env, mint)
    if (!chart.denied) return json(chart, { headers: { 'cache-control': 'public, max-age=15' } })
    const res = json(chart, { status: 404, headers: { 'cache-control': `public, max-age=${MISS_TTL}` } })
    ctx.waitUntil(cache.put(cacheKey, res.clone()))
    return res
  }

  // Which DBC configs a creator can launch against. LFOwn opens one per coin per
  // tier with `scripts/create-config.mjs`, then publishes them here. The graduation
  // threshold lives in the config, which is why the raise is a tier and not a field.
  if (path.startsWith('/api/config/')) {
    const mint = path.slice('/api/config/'.length)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json({ error: 'bad mint' }, { status: 400 })

    const entries = await Promise.all(
      TIERS.map(async (t) => [t.id, env.REGISTRY ? await env.REGISTRY.get(`config:${mint}:${t.id}`) : null])
    )
    const configs = {}
    for (const [id, value] of entries) {
      configs[id] = value ? JSON.parse(value) : null // { config, threshold, feeBps, creatorSharePct, openedAt }
    }
    return json({ mint, configs }, { headers: { 'cache-control': 'public, max-age=300' } })
  }

  // Token images. Kept on our own bucket rather than asking a creator to go find
  // hosting, and served back from a URL that will still resolve in a year.
  if (path === '/api/image' && request.method === 'POST') {
    if (!sameOrigin(request, url, env)) return json({ error: 'cross-site requests are not accepted here' }, { status: 403 })
    if (!env.IMAGES) {
      return json({ error: 'image hosting is not configured yet — paste a URL instead' }, { status: 501 })
    }
    const type = request.headers.get('content-type') ?? ''
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) {
      return json({ error: 'png, jpeg, webp or gif only' }, { status: 415 })
    }
    const body = await request.arrayBuffer()
    if (body.byteLength > 2 * 1024 * 1024) return json({ error: 'keep it under 2 MB' }, { status: 413 })

    const ext = type.split('/')[1].replace('jpeg', 'jpg')
    const key = `${crypto.randomUUID()}.${ext}`
    await env.IMAGES.put(key, body, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } })
    return json({ url: `${env.PUBLIC_ORIGIN || url.origin}/i/${key}` })
  }

  // Token metadata. The on-chain `uri` must point at a JSON document, not at the
  // image itself — wallets fetch it and read `image` out of it.
  if (path === '/api/metadata' && request.method === 'POST') {
    if (!sameOrigin(request, url, env)) return json({ error: 'cross-site requests are not accepted here' }, { status: 403 })
    if (!env.IMAGES) return json({ error: 'metadata hosting is not configured' }, { status: 501 })
    const body = await request.json().catch(() => null)
    if (!body?.name || !body?.symbol) return json({ error: 'name and symbol are required' }, { status: 400 })

    const metadata = {
      name: String(body.name).slice(0, 32),
      symbol: String(body.symbol).slice(0, 10),
      description: String(body.description ?? '').slice(0, 500),
      // Links are http(s) or nothing. A `javascript:` image would be every wallet's
      // and every card's problem to filter, and it should not have to be.
      image: httpUrl(body.image),
      external_url: httpUrl(body.website),
      extensions: { twitter: String(body.twitter ?? '').slice(0, 100) },
    }
    // The uri is written on-chain and never changes. Pinning it to the public origin
    // keeps a launch made from a dev server from carrying a dead link forever.
    const origin = env.PUBLIC_ORIGIN || url.origin
    // This used to drop the cached launches list so the new coin would show up
    // sooner. Anyone could post here, so anyone could drop it, and every visitor
    // after them paid for the rebuild. The coin is added to the list instead, once
    // its pool exists — see crankOne, which the launch page calls after confirmation.

    const key = `${crypto.randomUUID()}.json`
    await env.IMAGES.put(key, JSON.stringify(metadata), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' },
    })
    return json({ uri: `${origin}/i/${key}`, ephemeral: !env.PUBLIC_ORIGIN && url.hostname === 'localhost' })
  }

  // Signing happens in the browser; this only relays reads and the send itself.
  // A curve that fills is stuck until someone cranks it, and ten minutes is a long
  // time to stare at a full bar. The trade that filled it can say so immediately.
  // This is a hint, not an instruction: every claim in it is checked against chain
  // before a lamport is spent, so the worst a caller can do is make us read.
  if (path === '/api/graduate' && request.method === 'POST') {
    if (!sameOrigin(request, url, env)) return json({ error: 'cross-site requests are not accepted here' }, { status: 403 })
    const { mint } = (await request.json().catch(() => ({}))) ?? {}
    if (typeof mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return json({ error: 'a base mint is required' }, { status: 400 })
    }

    // Two answers cannot change — a mint with no pool does not get one later, and a
    // pool's config is immutable — so they are kept rather than looked up again.
    // Each is a program scan to reach. "No pool" is kept for less: the launch page
    // waits for its transaction to confirm before asking, but an RPC node that lags
    // a second behind should not hide a real launch for five minutes.
    const cache = caches.default
    const cacheKey = new Request(`${url.origin}/api/graduate/${mint}`, { method: 'GET' })
    const hit = await cache.match(cacheKey)
    if (hit) return hit

    const result = await crankOne(env, mint)
    const keep = { 'no pool for that mint': 60, 'not a pool LFOwn opened': MISS_TTL }[result.reason]
    if (keep) ctx.waitUntil(cache.put(cacheKey, json(result, { headers: { 'cache-control': `public, max-age=${keep}` } })))
    return json(result)
  }

  if (path === '/api/rpc' && request.method === 'POST') {
    if (!sameOrigin(request, url, env)) return json({ error: 'cross-site requests are not accepted here' }, { status: 403 })
    if (Number(request.headers.get('content-length') ?? 0) > RPC_MAX_BODY) return json({ error: 'request too large' }, { status: 413 })
    const text = await request.text()
    if (text.length > RPC_MAX_BODY) return json({ error: 'request too large' }, { status: 413 })
    let body = null
    try { body = JSON.parse(text) } catch { /* answered below */ }
    const calls = Array.isArray(body) ? body : [body]
    if (calls.length > RPC_MAX_BATCH) return json({ error: `at most ${RPC_MAX_BATCH} calls per request` }, { status: 413 })
    if (!body || !calls.length || calls.some((c) => !RPC_ALLOWED.has(c?.method))) {
      return json({ error: 'method not allowed' }, { status: 403 })
    }
    const upstream = await fetch(env.HELIUS_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
    })
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    })
  }

  return json({ error: 'not found' }, { status: 404 })
}

// '/launch/index.html' would be redirected to '/launch/' by the assets handler's
// trailing-slash rule, so ask for the directory form directly.
const shell = (section, url, request, env) =>
  env.ASSETS.fetch(new Request(new URL(`${section}/`, url.origin), request))

/** On-chain text, kept to one tidy line before it goes anywhere near a card. */
const oneLine = (v, cap = 140) => {
  const clean = String(v ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > cap ? clean.slice(0, cap - 1) + '…' : clean
}

/**
 * Absolute http(s) only, or nothing. A creator's links are fetched by strangers'
 * servers and shown in strangers' wallets, so anything else is dropped at the door.
 */
function httpUrl(value) {
  try {
    const url = new URL(String(value ?? ''))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
  } catch {
    return ''
  }
}

/** The same, as null: a card would rather have no image than an empty one. */
const cardImage = (value) => httpUrl(value) || null

/**
 * Where the news goes. Each is silent unless its own credentials are set, so adding
 * one never disturbs the other — and neither disturbs a site running without both.
 */
const CHANNELS = [
  {
    id: 'telegram',
    ready: (env) => Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    launched: (env, coin, origin, image) => telegram.announce(env, {
      text: telegram.launchedMessage(coin, origin), photo: image, preview: telegram.coinUrl(coin, origin),
    }),
    graduated: (env, coin, origin, image) => telegram.announce(env, {
      text: telegram.graduatedMessage(coin, origin), photo: image, preview: telegram.coinUrl(coin, origin),
    }),
  },
  {
    id: 'x',
    ready: (env) => Boolean(env.X_CONSUMER_KEY && env.X_CONSUMER_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET),
    launched: async (env, coin, origin, image) =>
      x.announce(env, { text: x.launchedMessage(coin, origin), image: await imageBytes(env, image) }),
    graduated: async (env, coin, origin, image) =>
      x.announce(env, { text: x.graduatedMessage(coin, origin), image: await imageBytes(env, image) }),
  },
]

/**
 * What each channel has already said, migrating the single-channel record.
 *
 * The old list becomes Telegram's, because that is whose it was. X gets nothing,
 * which its first run reads as "learn the state and say nothing" — the alternative
 * is thirty-six coins arriving on the timeline at once.
 */
async function announcedSoFar(env) {
  const v2 = await env.REGISTRY.get(ANNOUNCED_KEY, 'json')
  if (v2) return v2
  const v1 = await env.REGISTRY.get(ANNOUNCED_KEY_V1, 'json')
  return v1 ? { telegram: { launched: v1.launched ?? [], graduated: v1.graduated ?? [] } } : {}
}

/** The coin's artwork as a url, for a channel that fetches it itself. */
async function coinArtwork(env, coin) {
  try { return cardImage((await launchMetadata(env, coin.uri))?.image) } catch { return null }
}

/**
 * The same artwork as bytes, for a channel that needs us to upload it.
 *
 * Read straight out of R2 when the url is one of ours: a Worker fetching a url it
 * serves itself never gets an answer — the subrequest loops back and times out at
 * 522. Anything hosted elsewhere is fetched normally, with a ceiling, because
 * whoever launched the coin chose where "elsewhere" is.
 */
async function imageBytes(env, url) {
  if (!url) return null
  try {
    const key = String(url).match(/\/i\/([^/?#]+)$/)?.[1]
    if (key && env.IMAGES) {
      const object = await env.IMAGES.get(key)
      if (!object) return null
      return { bytes: await object.arrayBuffer(), type: object.httpMetadata?.contentType ?? 'image/png' }
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const bytes = await res.arrayBuffer()
    return bytes.byteLength > 5_000_000 ? null : { bytes, type: res.headers.get('content-type') ?? 'image/png' }
  } catch (e) {
    console.error(`artwork bytes unavailable: ${e.message}`)
    return null
  }
}

/**
 * Posts new coins, once each, to every channel that is configured.
 *
 * The record is written even when nothing is announced, and a channel's very first
 * run only writes it — otherwise switching one on would fire every coin ever
 * launched into it at once.
 */
async function announceLaunches(env, launches) {
  if (!env.REGISTRY) return
  const live = CHANNELS.filter((c) => c.ready(env))
  if (!live.length) return

  const origin = env.PUBLIC_ORIGIN || 'https://letsfuckingown.fun'
  const seen = await announcedSoFar(env)
  const next = { ...seen }
  // Fetched once and shared: two channels want the same picture, and the metadata
  // lives behind a request to whatever uri the creator published.
  const artwork = new Map()
  let changed = false

  for (const channel of live) {
    const record = seen[channel.id]
    const known = new Set(record?.launched ?? [])
    const fresh = launches.filter((l) => !known.has(l.baseMint))
    if (!fresh.length) continue

    const posted = []
    if (record) {
      for (const coin of fresh) {
        if (!artwork.has(coin.baseMint)) artwork.set(coin.baseMint, await coinArtwork(env, coin))
        // Written down only once the channel has actually heard it. A wrong token or
        // a brief outage then retries on the next pass, rather than marking the news
        // as delivered and losing it.
        if ((await channel.launched(env, coin, origin, artwork.get(coin.baseMint)))?.ok) {
          posted.push(coin.baseMint)
        }
      }
    } else {
      posted.push(...fresh.map((l) => l.baseMint))
      console.log(`${channel.id}: first run, remembering ${launches.length} coin(s) without announcing`)
    }
    if (!posted.length) continue

    next[channel.id] = {
      launched: [...known, ...posted].slice(-500),
      graduated: record?.graduated ?? [],
    }
    changed = true
  }

  if (changed) await env.REGISTRY.put(ANNOUNCED_KEY, JSON.stringify(next))
}

/** Posts one graduation to every channel that has not already said it. */
async function announceGraduation(env, coin) {
  if (!env.REGISTRY) return
  const live = CHANNELS.filter((c) => c.ready(env))
  if (!live.length) return

  const origin = env.PUBLIC_ORIGIN || 'https://letsfuckingown.fun'
  const seen = await announcedSoFar(env)
  const next = { ...seen }
  let image
  let changed = false

  for (const channel of live) {
    const record = seen[channel.id]
    const graduated = new Set(record?.graduated ?? [])
    if (graduated.has(coin.baseMint)) continue
    if (image === undefined) image = await coinArtwork(env, coin)

    // Retried on the next pass rather than silently dropped.
    if (!(await channel.graduated(env, coin, origin, image))?.ok) continue
    graduated.add(coin.baseMint)
    next[channel.id] = { launched: record?.launched ?? [], graduated: [...graduated].slice(-500) }
    changed = true
  }

  if (changed) await env.REGISTRY.put(ANNOUNCED_KEY, JSON.stringify(next))
}

// A metadata document is a few hundred bytes of JSON. A uri that answers with
// something else, or slowly, is not worth waiting on.
const METADATA_MAX_BYTES = 64 * 1024
const METADATA_TIMEOUT = 5_000

/**
 * The JSON a launch published for its token.
 *
 * Read straight from the bucket when it is ours. Fetching the uri instead sends the
 * request out of the worker, across Cloudflare's edge and back in as an anonymous
 * visitor — which the zone's bot protection answers with a 403. That is exactly why
 * every shared coin link fell back to the site banner: the fetch threw, the image
 * stayed null, and the rewrite quietly left the defaults alone.
 */
async function launchMetadata(env, uri) {
  const key = String(uri ?? '').match(/\/i\/([^/?#]+)$/)?.[1]
  if (key && env.IMAGES) {
    const object = await env.IMAGES.get(key)
    return object ? JSON.parse(await object.text()) : null
  }
  // A token whose metadata lives somewhere else is still worth reading — within
  // limits, because whoever launched it chose where "somewhere else" is.
  if (!httpUrl(uri)) return null
  const res = await fetch(uri, { signal: AbortSignal.timeout(METADATA_TIMEOUT), cf: { cacheTtl: 3600, cacheEverything: true } })
  if (!res.ok || Number(res.headers.get('content-length') ?? 0) > METADATA_MAX_BYTES) return null
  const text = await res.text()
  return text.length > METADATA_MAX_BYTES ? null : JSON.parse(text)
}

/**
 * What a link to one coin should say when it is pasted somewhere.
 *
 * Read from the cached launches list, which is what makes this cheap enough to do
 * on every crawl; the picture comes from the metadata JSON the launch published, so
 * it is the coin's own artwork rather than the site's banner. A coin the list has
 * not caught up with yet simply keeps the site card.
 */
async function coinCard(env, mint, origin) {
  const cached = env.REGISTRY ? await env.REGISTRY.get(LAUNCHES_KEY, 'json') : null
  const coin = (cached?.launches ?? []).find((l) => l.baseMint === mint)
  if (!coin) return null

  let image = null
  if (coin.uri) {
    try {
      image = cardImage((await launchMetadata(env, coin.uri))?.image)
    } catch (e) {
      console.error(`card for ${mint}: metadata unreadable: ${e.message}`)
    }
  }

  const symbol = oneLine(coin.symbol || '?', 24)
  const name = oneLine(coin.name || symbol, 60)
  const quote = oneLine(coin.quoteSymbol || '?', 24)
  const raised = Number(coin.quoteReserve ?? 0) / 1e6
  const pct = coin.threshold ? Math.min(100, (raised / coin.threshold) * 100) : 0
  const progress = coin.isMigrated
    ? 'Graduated to its Meteora pool.'
    : `${raised.toLocaleString('en-US', { maximumFractionDigits: 0 })} of ${Number(coin.threshold).toLocaleString('en-US')} ${quote} raised — ${pct.toFixed(1)}% of the way to graduation.`

  return {
    title: `${symbol} — paired with ${quote} · LFOwn`,
    description: `${name} is a memecoin on LFOwn, paired with ${quote}, an ownership coin launched on MetaDAO with a treasury behind it. ${progress}`,
    url: `${origin}/coins/${mint}`,
    image,
  }
}

// Which card field each tag carries. Anything not listed is left alone.
const CARD_TAGS = {
  description: (c) => c.description,
  'og:url': (c) => c.url,
  'og:title': (c) => c.title,
  'og:description': (c) => c.description,
  'og:image': (c) => c.image,
  'twitter:title': (c) => c.title,
  'twitter:description': (c) => c.description,
  'twitter:image': (c) => c.image,
}

/**
 * One creator's card: what they have launched, and what it has taken.
 *
 * The picture is their best-earning coin's artwork. A wallet has no image of its
 * own, and a generic banner tells a reader nothing about whose page they are being
 * shown — whereas the coin they are best known for does.
 */
async function creatorCard(env, wallet, origin) {
  const cached = env.REGISTRY ? await env.REGISTRY.get(LAUNCHES_KEY, 'json') : null
  const mine = (cached?.launches ?? []).filter((l) => l.creator === wallet)
  if (!mine.length) return null

  const report = env.REGISTRY ? (await env.REGISTRY.get(FEES_KEY, 'json'))?.report : null
  const earned = new Map((report?.coins ?? []).map((c) => [c.baseMint, c]))
  const best = [...mine].sort(
    (a, b) => (earned.get(b.baseMint)?.totalUsd ?? 0) - (earned.get(a.baseMint)?.totalUsd ?? 0))[0]

  const generated = mine.reduce((t, c) => t + (earned.get(c.baseMint)?.totalUsd ?? 0), 0)
  const graduated = mine.filter((c) => c.isMigrated).length

  let image = null
  if (best?.uri) {
    try { image = cardImage((await launchMetadata(env, best.uri))?.image) }
    catch (e) { console.error(`creator card ${wallet}: metadata unreadable: ${e.message}`) }
  }

  const money = generated >= 1
    ? `$${Math.round(generated).toLocaleString('en-US')}`
    : `$${generated.toFixed(2)}`
  const coins = `${mine.length} coin${mine.length > 1 ? 's' : ''}`
  const grad = graduated ? `, ${graduated} graduated` : ''

  return {
    title: `${wallet.slice(0, 4)}…${wallet.slice(-4)} — ${coins} on LFOwn`,
    description: `This wallet has launched ${coins} on LFOwn${grad}. Together they have taken ${money} in trading fees, split between the creator and the LFOwn DAO.`,
    url: `${origin}/creator/${wallet}`,
    image,
  }
}

/** The creator shell, with its card rewritten for this one wallet. */
async function creatorShell(wallet, url, request, env) {
  const page = await shell('/creator', url, request, env)
  const card = await creatorCard(env, wallet, env.PUBLIC_ORIGIN || url.origin).catch((e) => {
    console.error(`card for ${wallet} failed: ${e.message}`)
    return null
  })
  return card ? rewriteCard(page, card) : page
}

/**
 * The coins shell, with its card rewritten for this one coin.
 *
 * Crawlers do not run JavaScript, so this has to happen on the way out. HTMLRewriter
 * streams, so the page is not buffered to do it.
 */
async function coinShell(mint, url, request, env) {
  const page = await shell('/coins', url, request, env)
  const card = await coinCard(env, mint, env.PUBLIC_ORIGIN || url.origin).catch((e) => {
    console.error(`card for ${mint} failed: ${e.message}`)
    return null
  })
  if (!card) return page
  return rewriteCard(page, card)
}

/**
 * Stamps one card onto a shell on the way out. Crawlers do not run JavaScript, so
 * this has to happen here rather than in the page's own script.
 */
function rewriteCard(page, card) {
  return new HTMLRewriter()
    .on('title', { element: (el) => el.setInnerContent(card.title) })
    .on('meta', {
      element(el) {
        const key = el.getAttribute('property') ?? el.getAttribute('name')
        // The banner's dimensions are the banner's. A token's artwork is whatever
        // its creator uploaded, and stating a size we have not measured is worse
        // than stating none.
        if (key === 'og:image:width' || key === 'og:image:height') {
          if (card.image) el.remove()
          return
        }
        const value = CARD_TAGS[key]?.(card)
        if (value) el.setAttribute('content', value)
      },
    })
    .transform(page)
}

/**
 * Every DBC config LFOwn has opened. This is what makes a pool ours: the migration
 * is permissionless and costs the payer real SOL, so anything that spends the
 * keeper's key has to be able to prove the pool came from one of these.
 *
 * Read in one go rather than one key after another: with a few dozen coins and three
 * tiers this is a hundred-odd reads, and in sequence they were most of what a
 * graduation request cost.
 */
async function ourConfigs(env) {
  const { coins } = await readCatalogue(env)
  if (!env.REGISTRY) return []
  const wanted = []
  for (const coin of coins) {
    for (const tier of TIERS) {
      // Retired configs are read too: a coin launched on one still trades, and a
      // fee change should not make it disappear from the site.
      for (const prefix of ['config', 'retired']) wanted.push({ coin, tier, key: `${prefix}:${coin.mint}:${tier.id}` })
    }
  }
  const values = await Promise.all(wanted.map(({ key }) => env.REGISTRY.get(key)))
  const configs = []
  wanted.forEach(({ coin, tier }, i) => {
    if (!values[i]) return
    const { config, threshold } = JSON.parse(values[i])
    configs.push({ config, threshold, mint: coin.mint, symbol: coin.symbol, usdPrice: coin.usdPrice, tier: tier.id })
  })
  return configs
}

/** Pools across every config LFOwn has opened, with their tokens' metadata. */
async function collectLaunches(env) {
  const [{ Connection, PublicKey }, { DynamicBondingCurveClient }] = await Promise.all([
    import('@solana/web3.js'),
    import('@meteora-ag/dynamic-bonding-curve-sdk'),
  ])
  const connection = new Connection(env.HELIUS_RPC, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')

  const launches = await listLaunches(client, connection, PublicKey, await ourConfigs(env))
  return { updatedAt: new Date().toISOString(), count: launches.length, launches }
}

/**
 * The Worker's one signing key, used to claim fees and to crank graduations.
 *
 * It is a hot key, and it is worth more than it looks: it is the fee claimer written
 * into every config, which cannot be changed, and after a graduation it holds
 * LFOwn's position in the coin's pool, which is a transferable NFT. Whoever takes it
 * takes the partner's share of every curve opened so far and the graduated income of
 * every coin already graduated, for good. The treasury itself is out of reach — it is
 * a receiver, and receiving needs no signature — but "at most the fees since the
 * last sweep" would be the wrong thing to believe. See the README before moving it.
 */
async function loadCollector(env) {
  if (!env.FEE_COLLECTOR_KEY) return null
  const { Keypair } = await import('@solana/web3.js')
  const secret = env.FEE_COLLECTOR_KEY.trim()
  const bytes = secret.startsWith('[') ? Uint8Array.from(JSON.parse(secret)) : decodeBase58(secret)
  return Keypair.fromSecretKey(bytes)
}

/**
 * A minute-by-minute look for a curve that has filled.
 *
 * The instant trigger only fires on trades made through these screens — and Jupiter
 * routes into these pools, so a buy on jup.ag, or in any wallet that swaps through
 * it, fills a curve without ever telling us. Ten minutes is a long time to leave a
 * launch frozen at 100% with its liquidity stuck on the curve.
 *
 * Cheap enough to run every minute: the thresholds come from KV, where they were
 * written when the config was opened and never change, and every live pool is read
 * in a single batched call whatever their number. Deciding is all this does — the
 * spending is left to crankOne, which validates everything again from chain.
 */
async function watchGraduations(env) {
  // Rebuilt rather than skipped when the list is missing. It goes missing in
  // ordinary circumstances — the catalogue job failed, the entry expired — and
  // reading without rebuilding left this watch blind exactly when a curve was most
  // likely to be sitting full.
  const cached = await readLaunches(env)

  // The same pass that watches for a full curve is the one that notices a new coin.
  await announceLaunches(env, cached.launches ?? []).catch((e) => console.error(`telegram launches: ${e.message}`))

  const live = (cached.launches ?? []).filter((l) => !l.isMigrated && l.threshold)
  if (!live.length) return { checked: 0 }

  const [{ Connection, PublicKey }, { DynamicBondingCurveClient }] =
    await Promise.all([import('@solana/web3.js'), import('@meteora-ag/dynamic-bonding-curve-sdk')])
  const connection = new Connection(env.HELIUS_RPC, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  const program = client.state.program ?? client.program

  const infos = await connection.getMultipleAccountsInfo(live.map((l) => new PublicKey(l.pool)))
  for (let i = 0; i < live.length; i++) {
    if (!infos[i]) continue
    let state
    try {
      state = program.coder.accounts.decode('virtualPool', infos[i].data).poolState
    } catch (e) {
      console.error(`graduation watch: ${live[i].symbol ?? live[i].pool} could not be decoded: ${e.message}`)
      continue
    }
    if (state.isMigrated) continue
    if (Number(state.quoteReserve.toString()) / 1e6 < live[i].threshold) continue
    console.log(`graduation watch: ${live[i].symbol ?? live[i].baseMint} has filled`)
    return crankOne(env, live[i].baseMint)
  }
  return { checked: live.length }
}

const EMPTY_REPORT = () => ({
  updatedAt: new Date().toISOString(),
  coins: [],
  totals: { generatedUsd: 0, lfownUsd: 0, creatorUsd: 0, meteoraUsd: 0 },
  pending: true,
})

/** The fee report from KV, rebuilt behind the response once it is a minute old. */
async function readFeeReport(env, ctx) {
  const cached = env.REGISTRY ? await env.REGISTRY.get(FEES_KEY, 'json') : null
  if (cached?.report) {
    if (ctx && Date.now() - (cached.at ?? 0) > FEES_FRESH) {
      ctx.waitUntil(buildFeeReport(env).catch((e) => console.error('fee report rebuild failed:', e.message)))
    }
    return cached.report
  }
  // Nothing stored at all — the only case anyone still waits for the whole build,
  // and only one of them builds it. The rest wait for that copy to land.
  const built = await buildFeeReport(env)
  if (built) return built
  return (await waitForKey(env, FEES_KEY, 25_000))?.report ?? EMPTY_REPORT()
}

/** Builds the fee report and stores it with the time it was built — one at a time. */
function buildFeeReport(env) {
  return withLock(env, 'fees', async () => {
    const [{ Connection }, { DynamicBondingCurveClient }] = await Promise.all([
      import('@solana/web3.js'),
      import('@meteora-ag/dynamic-bonding-curve-sdk'),
    ])
    const connection = new Connection(env.HELIUS_RPC, 'confirmed')
    const client = new DynamicBondingCurveClient(connection, 'confirmed')
    const [list, { coins }] = await Promise.all([readLaunches(env), readCatalogue(env)])

    const report = await feeReport(client, connection, list.launches, {
      prices: new Map(coins.map((c) => [c.mint, c.usdPrice])),
    })
    // A report built from a list that was still being rebuilt is not worth keeping.
    if (env.REGISTRY && !list.pending) {
      await env.REGISTRY.put(FEES_KEY, JSON.stringify({ report, at: Date.now() }), { expirationTtl: 86_400 })
    }
    return report
  })
}

/** Remembers that a mint has no chart to build, so the next request does not look again. */
async function denyChart(env, mint, error) {
  if (env.REGISTRY) {
    await env.REGISTRY.put(CHART_KEY(mint), JSON.stringify({ denied: true, error, at: Date.now() }), { expirationTtl: 3600 })
  }
  return { points: [], error, denied: true }
}

async function chartFor(env, mint) {
  const cached = env.REGISTRY ? JSON.parse((await env.REGISTRY.get(CHART_KEY(mint))) ?? 'null') : null
  if (cached?.denied) return { points: [], error: cached.error, denied: true }
  if (cached && Date.now() - (cached.at ?? 0) < CHART_COOLDOWN) return { points: cached.points, cached: true }

  const [{ Connection, PublicKey }, { DynamicBondingCurveClient }] =
    await Promise.all([import('@solana/web3.js'), import('@meteora-ag/dynamic-bonding-curve-sdk')])
  const connection = new Connection(env.HELIUS_RPC, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')

  // Addresses are looked up once and kept. A coin the list knows is read by address,
  // which is one account; anything else is found by scanning the program, once, and
  // is then required to sit on one of our configs. This route used to index any
  // pool on the program for whoever asked, thirty parsed-transaction calls at a
  // time, and remember the result for ever.
  let legs = cached?.legs
  if (!legs) {
    const listed = (await env.REGISTRY?.get(LAUNCHES_KEY, 'json'))?.launches?.find((l) => l.baseMint === mint)
    let pool, state, quoteMint
    if (listed) {
      pool = listed.pool
      quoteMint = listed.quoteMint
      state = (await client.state.getPool(new PublicKey(listed.pool)))?.poolState
    } else {
      const wrapper = await client.state.getPoolByBaseMint(new PublicKey(mint)).catch(() => null)
      if (!wrapper) return denyChart(env, mint, 'no pool for this mint')
      const ours = new Set((await ourConfigs(env)).map((c) => c.config))
      if (!ours.has(wrapper.account.poolState.config.toBase58())) return denyChart(env, mint, 'not a pool LFOwn opened')
      pool = wrapper.publicKey.toBase58()
      state = wrapper.account.poolState
      quoteMint = (await client.state.getPoolConfig(state.config)).quoteMint.toBase58()
    }
    if (!state) return denyChart(env, mint, 'no pool for this mint')
    legs = [{
      kind: 'curve',
      pool,
      baseMint: state.baseMint.toBase58(),
      // Kept so the graduated pool can be derived later without another scan.
      quoteMint,
      baseVault: state.baseVault.toBase58(),
      quoteVault: state.quoteVault.toBase58(),
      baseDecimals: 6,
      quoteDecimals: 6,
      newest: null,
    }]
  }

  // The second leg appears the day the coin graduates, and is kept from then on.
  if (!legs.some((l) => l.kind === 'amm')) {
    const amm = await ammLeg(connection, PublicKey, legs[0].baseMint, legs[0].quoteMint).catch((e) => {
      console.error(`chart for ${mint}: graduated pool unreadable: ${e.message}`)
      return null
    })
    if (amm) legs.push(amm)
  }

  const points = [...(cached?.points ?? [])]
  try {
    for (const leg of legs) {
      const fresh = await tradeHistory(connection, PublicKey, env.HELIUS_RPC, leg, { until: leg.newest })
      points.push(...fresh.points)
      if (fresh.newest) leg.newest = fresh.newest
    }
  } catch (e) {
    // A chart that cannot be extended is still worth drawing from what we have.
    console.error(`chart for ${mint} could not be built: ${e.message}`)
    return cached ? { points: cached.points, stale: true } : { points: [], error: e.message }
  }

  points.sort((a, b) => a.t - b.t)
  if (env.REGISTRY) {
    await env.REGISTRY.put(CHART_KEY(mint), JSON.stringify({ legs, points, at: Date.now() }), { expirationTtl: CHART_TTL })
  }
  return { points }
}

/**
 * Graduates one coin on request, if it really is ready.
 *
 * Nothing the caller says is taken on trust. The pool is read from chain; its
 * config has to be one LFOwn opened, or anyone could point this at a curve of their
 * own making — threshold set to nothing, filled for a few lamports — and have the
 * keeper pay ~0.03 SOL a time to migrate it; and the reserve has to have genuinely
 * reached the threshold.
 */
async function crankOne(env, mint) {
  const [{ Connection, PublicKey }, { DynamicBondingCurveClient }] =
    await Promise.all([import('@solana/web3.js'), import('@meteora-ag/dynamic-bonding-curve-sdk')])
  const connection = new Connection(env.HELIUS_RPC, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')

  // A coin the list knows is read by address, which is one account. Anything else
  // costs a scan of the program, which is why the route that calls this remembers
  // the answer for a mint that turns out to have no pool.
  const known = env.REGISTRY ? await env.REGISTRY.get(LAUNCHES_KEY, 'json') : null
  const listed = known?.launches?.find((l) => l.baseMint === mint)
  let poolAddress, pool
  if (listed) {
    poolAddress = new PublicKey(listed.pool)
    pool = (await client.state.getPool(poolAddress))?.poolState
  } else {
    const wrapper = await client.state.getPoolByBaseMint(new PublicKey(mint))
    if (wrapper) {
      poolAddress = wrapper.publicKey
      pool = wrapper.account.poolState
    }
  }
  if (!pool) return { ok: false, reason: 'no pool for that mint' }
  if (pool.isMigrated) return { ok: false, reason: 'already migrated' }

  const cfg = (await ourConfigs(env)).find((c) => c.config === pool.config.toBase58())
  if (!cfg) return { ok: false, reason: 'not a pool LFOwn opened' }

  // A coin the cached list has never heard of cannot be followed by the watch, and a
  // coin launched a minute ago is exactly that. It is added to the list here, now
  // that its pool has been read and found to be on one of our configs — so a curve
  // filled from Jupiter three minutes after launch is caught within a minute rather
  // than at the next catalogue rebuild. The launch page calls this endpoint once its
  // transaction has confirmed precisely so that this happens. The list used to be
  // dropped instead, and dropping it was something anyone could do to everyone.
  let record = listed
  if (known && !listed) {
    record = await launchEntry(connection, PublicKey, poolAddress, pool, cfg)
    await patchLaunches(env, mint, record)
  }

  const threshold = await client.state.getPoolMigrationQuoteThreshold(poolAddress)
  if (pool.quoteReserve.lt(threshold)) return { ok: false, reason: 'the curve is not full yet' }

  // Loaded last, once every claim in the request has been checked against chain.
  // Nothing that reaches this line can be refused any more, so this is the point
  // where the key becomes necessary — and until it, no test can spend anything.
  const collector = await loadCollector(env)
  if (!collector) return { ok: false, reason: 'the keeper key is not set' }

  // Best effort only: two buyers can fill the same curve a second apart and KV will
  // not stop both. The second transaction is rejected on chain for a signature fee
  // and nothing else, so this keeps the log quiet rather than protecting funds.
  const lock = `graduating:${mint}`
  if (env.REGISTRY) {
    if (await env.REGISTRY.get(lock)) return { ok: false, reason: 'already under way' }
    await env.REGISTRY.put(lock, '1', { expirationTtl: 120 })
  }

  try {
    const signature = await graduate(client, connection, poolAddress.toBase58(), collector)
    console.log(`graduated on request ${mint}: ${signature}`)
    await announceGraduation(env, record ?? { baseMint: mint, symbol: '?', quoteSymbol: '?', quoteReserve: pool.quoteReserve.toString() })
      .catch((e) => console.error(`telegram graduation: ${e.message}`))
    // Its status just changed; the list is told rather than thrown away.
    await patchLaunches(env, mint, { isMigrated: true, quoteReserve: pool.quoteReserve.toString() })
    return { ok: true, signature }
  } catch (e) {
    console.error(`graduation failed on request for ${mint}: ${e.message}`)
    return { ok: false, reason: e.message }
  }
}

/**
 * The ten-minute sweep stays as the backstop. Before graduation a pool is on no
 * DEX, so in practice every trade comes through our own screens and the call above
 * catches it — but a hand-built swap straight at the DBC program would not ping us,
 * and a curve nobody is watching should still graduate.
 *
 * One pool per run: migration is a heavy transaction and a backlog can wait ten
 * minutes.
 */
async function crankGraduations(env) {
  const collector = await loadCollector(env)
  if (!collector) {
    console.log('graduation keeper skipped: FEE_COLLECTOR_KEY is not set')
    return { skipped: true }
  }

  const [{ Connection }, { DynamicBondingCurveClient }] =
    await Promise.all([import('@solana/web3.js'), import('@meteora-ag/dynamic-bonding-curve-sdk')])
  const connection = new Connection(env.HELIUS_RPC, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')

  const { launches } = await readLaunches(env)
  const ready = await readyToGraduate(client, launches)
  if (!ready.length) {
    console.log(`graduation keeper: nothing ready (${launches.length} launches)`)
    return { graduated: 0 }
  }

  const target = ready[0]
  try {
    const signature = await graduate(client, connection, target.pool, collector)
    console.log(`graduated ${target.symbol ?? target.baseMint}: ${signature}`)
    await patchLaunches(env, target.baseMint, { isMigrated: true }) // its status just changed
    return { graduated: 1, pool: target.pool, signature }
  } catch (e) {
    console.error(`graduation failed on ${target.symbol ?? target.pool}: ${e.message}`)
    return { graduated: 0, error: e.message }
  }
}

/**
 * Sweeps the DAO's share of trading fees into the treasury.
 *
 * The program accepts one signer for a claim — the config's fee claimer — so this
 * only runs when FEE_COLLECTOR_KEY holds that key. Without the secret it does
 * nothing and says so: a cron that silently claims nothing is worse than none.
 */
async function sweepFees(env) {
  const collector = await loadCollector(env)
  if (!collector) {
    console.log('fee sweep skipped: FEE_COLLECTOR_KEY is not set')
    return { skipped: true }
  }

  const [{ Connection, PublicKey }, { DynamicBondingCurveClient }] =
    await Promise.all([import('@solana/web3.js'), import('@meteora-ag/dynamic-bonding-curve-sdk')])

  if (collector.publicKey.toBase58() !== FEES.recipient) {
    console.error(`fee sweep aborted: collector ${collector.publicKey.toBase58()} is not the fee claimer ${FEES.recipient}`)
    return { skipped: true, reason: 'wrong key' }
  }

  const connection = new Connection(env.HELIUS_RPC, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  const { launches } = await readLaunches(env)

  // A claim costs a signature and possibly an account rent; sweeping dust would
  // spend more than it collects.
  const claimable = await pendingPartnerFees(client, launches, { minimum: 1 })
  const done = []
  for (const p of claimable) {
    try {
      const tx = await client.partner.claimPartnerTradingFeeToReceiver({
        feeClaimer: collector.publicKey,
        payer: collector.publicKey,
        pool: new PublicKey(p.pool),
        maxBaseAmount: p.poolState.partnerBaseFee,
        maxQuoteAmount: p.poolState.partnerQuoteFee,
        receiver: new PublicKey(FEES.treasury),
      })
      tx.feePayer = collector.publicKey
      const signature = await sendAndConfirm(connection, tx, [collector])
      done.push({ pool: p.pool, symbol: p.symbol, quote: p.quote, usd: p.usd, signature })
    } catch (e) {
      console.error(`fee sweep failed on ${p.symbol ?? p.pool}: ${e.message}`)
    }
  }

  // Graduated coins keep earning, in a DAMM v2 position rather than the curve.
  // Sweeping only the curve would abandon everything a coin makes after it graduates.
  const { coins } = await readCatalogue(env)
  const prices = new Map(coins.map((c) => [c.mint, c.usdPrice]))
  for (const p of await lpPositions(connection, collector.publicKey.toBase58())) {
    if (!p.feeA && !p.feeB) continue
    const usd = p.feeA * (prices.get(p.tokenA) ?? 0) + p.feeB * (prices.get(p.tokenB) ?? 0)
    if (usd < 1) continue
    try {
      const tx = await buildLpClaim(connection, p, {
        owner: collector.publicKey.toBase58(),
        receiver: FEES.treasury,
        feePayer: collector.publicKey.toBase58(),
      })
      tx.feePayer = collector.publicKey
      const signature = await sendAndConfirm(connection, tx, [collector])
      done.push({ pool: p.pool, symbol: 'graduated', quote: p.feeB, usd, signature })
    } catch (e) {
      console.error(`lp fee sweep failed on ${p.pool}: ${e.message}`)
    }
  }

  console.log(`fee sweep: ${done.length} claim(s), ≈$${done.reduce((t, d) => t + d.usd, 0).toFixed(2)}`)
  if (env.REGISTRY) {
    await env.REGISTRY.put('sweep:last', JSON.stringify({ at: new Date().toISOString(), done }))
  }
  return { swept: done.length }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function decodeBase58(str) {
  let n = 0n
  for (const c of str) {
    const i = B58.indexOf(c)
    if (i < 0) throw new Error('FEE_COLLECTOR_KEY is neither base58 nor a JSON array')
    n = n * 58n + BigInt(i)
  }
  const bytes = []
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n }
  for (const c of str) { if (c !== '1') break; bytes.unshift(0) }
  return Uint8Array.from(bytes)
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) return handleApi(url, request, env, ctx)

    // Uploaded token images.
    if (url.pathname.startsWith('/i/') && env.IMAGES) {
      const object = await env.IMAGES.get(url.pathname.slice(3))
      if (!object) return new Response('not found', { status: 404 })
      const headers = new Headers()
      object.writeHttpMetadata(headers)
      headers.set('etag', object.httpEtag)
      // Token metadata is read by wallets, explorers and aggregators from their own
      // origins — without this the image simply never shows up anywhere.
      headers.set('access-control-allow-origin', '*')
      // The content type is pinned at upload from an allowlist; say so, so no
      // browser decides for itself that a stored file is really HTML.
      headers.set('x-content-type-options', 'nosniff')
      return new Response(object.body, { headers })
    }

    // The launch app is a single page. Real files under /launch (its script, any
    // future chunk) must still be served as themselves — only unknown paths fall
    // through to the shell, so client-side routes survive a reload.
    for (const section of ['/launch', '/coins', '/creator']) {
      if (url.pathname !== section && !url.pathname.startsWith(`${section}/`)) continue
      if (url.pathname === section || url.pathname === `${section}/`) return shell(section, url, request, env)
      const asset = await env.ASSETS.fetch(request)
      if (asset.status !== 404) return asset
      // A coin's own page carries its own card.
      const tail = url.pathname.slice(section.length + 1)
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tail)) {
        if (section === '/coins') return coinShell(tail, url, request, env)
        if (section === '/creator') return creatorShell(tail, url, request, env)
      }
      return shell(section, url, request, env)
    }

    return env.ASSETS.fetch(request)
  },

  // Keeps the catalogue warm so a visitor never waits on getProgramAccounts.
  async scheduled(event, env, ctx) {
    if (event.cron === FEE_SWEEP) {
      ctx.waitUntil(sweepFees(env))
      return
    }
    if (event.cron === WATCH) {
      ctx.waitUntil(watchGraduations(env))
      return
    }
    // Everything unrecognised still runs the frequent job, because that is the safe
    // default — but it says so. Editing a schedule in wrangler.jsonc without editing
    // the constant above would otherwise stop the sweep for good, in silence.
    if (event.cron !== CATALOGUE) {
      console.warn(`unrecognised cron ${event.cron}: running the catalogue job. Does it match FEE_SWEEP, WATCH or CATALOGUE in worker.mjs?`)
    }
    ctx.waitUntil((async () => {
      await writeCatalogue(env, await buildRegistry(env.HELIUS_RPC))
      if (env.REGISTRY) {
        await rebuildLaunches(env).catch((e) => console.error('launches rebuild failed:', e.message))
        // Warmed here so that visitors read it rather than build it.
        await buildFeeReport(env).catch((e) => console.error('fee report warm-up failed:', e.message))
      }
      await crankGraduations(env)
    })())
  },
}
