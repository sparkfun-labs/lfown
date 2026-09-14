// LFOwn — launching a coin from anything that can make an HTTP request.
//
// The launch page is for people with a browser and a wallet. This is the same launch
// for agents: a script, an autonomous agent with its own wallet, or a chat assistant
// that has no wallet at all and hands a person a link to sign.
//
// Nothing here ever signs for the creator. A launch is signed by the wallet that will
// earn its fees, so there are two ways through:
//
//   with `creator`     the server builds the transactions, signs them with the coin's
//                      own mint key, and hands them back for the creator to sign and
//                      send — or to post to /api/agent/submit, which sends them in
//                      order and waits for each.
//   without `creator`  the server keeps the launch as a draft and answers with a link
//                      to /launch, filled in, for a person to review and sign.
//
// The mint key comes from the reserve in mint-pool.mjs, so an agent's coin ends in
// `own` like everyone else's; when the reserve is empty the launch goes ahead on a
// random address and says so, because an agent must always be able to launch.

import { FEES, TIERS, feeBreakdown } from './lib/config.mjs'
import { HOLDER_MAX_PCT, clampHolderPct, splitFor } from './lib/fee-split.mjs'

/** What a launch shares with holders when the agent does not say. Same as the page. */
export const DEFAULT_HOLDER_PCT = 25

const LIMITS = {
  name: 32,
  symbol: 10,
  description: 500,
  imageBytes: 2 * 1024 * 1024,
  imageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  devBuyMaxPercent: 50,
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const DRAFT_TTL = 7 * 24 * 60 * 60
const LAUNCH_TTL = 15 * 60

class AgentError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

const reply = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors, ...headers },
  })

const httpUrl = (value) => {
  if (!value) return ''
  try {
    const u = new URL(String(value))
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : ''
  } catch {
    return ''
  }
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const digest = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes))

// ── the catalogue an agent chooses from ─────────────────────────────────────

/**
 * Every ownership coin a coin can be paired with right now, with its open tiers.
 * A coin with no tier open is left out: an agent cannot act on it.
 */
export async function agentOptions(env, { readCatalogue }) {
  const { coins = [] } = await readCatalogue(env)
  const rows = await Promise.all(coins.map(async (coin) => {
    const tiers = []
    for (const tier of TIERS) {
      const value = env.REGISTRY ? await env.REGISTRY.get(`config:${coin.mint}:${tier.id}`) : null
      if (!value) continue
      const cfg = JSON.parse(value)
      tiers.push({
        id: tier.id,
        label: tier.label,
        threshold: cfg.threshold,
        thresholdUsd: Math.round(cfg.threshold * (coin.usdPrice ?? 0)),
      })
    }
    return tiers.length
      ? { symbol: coin.symbol, name: coin.name, mint: coin.mint, usdPrice: coin.usdPrice, treasuryUsd: coin.treasury, holders: coin.holders, tiers }
      : null
  }))
  const cut = feeBreakdown(FEES.totalBps)
  return {
    coins: rows.filter(Boolean),
    tradingFee: {
      totalBps: FEES.totalBps,
      note: `Meteora keeps ${cut.protocol / 100}% of every trade; the rest is split evenly between the creator's side and the LFOwn DAO.`,
    },
    holders: {
      default: DEFAULT_HOLDER_PCT,
      max: HOLDER_MAX_PCT,
      note: "Points of the whole trading fee a creator gives the coin's holders, out of their own half. Paid out hourly, pro rata, in the ownership coin. Fixed at launch.",
    },
    limits: LIMITS,
  }
}

// ── storing what a launch needs before anything is signed ───────────────────

async function storeImage(env, origin, { imageUrl, imageData }) {
  if (!env.IMAGES) throw new AgentError(501, 'image hosting is not configured on this deployment')
  let bytes
  let type
  if (imageData) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(imageData))
    if (!match) throw new AgentError(400, 'imageData must be a base64 data URL of a png, jpeg, webp or gif')
    type = match[1]
    bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))
  } else if (imageUrl) {
    const url = httpUrl(imageUrl)
    if (!url) throw new AgentError(400, 'imageUrl must be an http(s) URL')
    // Already one of ours: kept as it is. A Worker cannot fetch a URL it serves itself.
    if (url.startsWith(`${origin}/i/`)) return url
    let res
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' })
    } catch (e) {
      throw new AgentError(400, `could not fetch imageUrl: ${e.message}`)
    }
    if (!res.ok) throw new AgentError(400, `imageUrl answered ${res.status}`)
    type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    if (Number(res.headers.get('content-length') ?? 0) > LIMITS.imageBytes) throw new AgentError(413, 'the image must be under 2 MB')
    bytes = new Uint8Array(await res.arrayBuffer())
  } else {
    return null
  }
  if (!LIMITS.imageTypes.includes(type)) throw new AgentError(415, 'the image must be a png, jpeg, webp or gif')
  if (bytes.byteLength > LIMITS.imageBytes) throw new AgentError(413, 'the image must be under 2 MB')

  const key = `${crypto.randomUUID()}.${type.split('/')[1].replace('jpeg', 'jpg')}`
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } })
  return `${origin}/i/${key}`
}

async function storeMetadata(env, origin, token) {
  const metadata = {
    name: token.name,
    symbol: token.symbol,
    description: token.description,
    image: token.image ?? '',
    external_url: token.website,
    extensions: { twitter: token.twitter },
  }
  const key = `${crypto.randomUUID()}.json`
  await env.IMAGES.put(key, JSON.stringify(metadata), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' },
  })
  return `${origin}/i/${key}`
}

/** Reads and checks what an agent asked for, before anything is stored or built. */
async function readRequest(env, input, deps) {
  const name = String(input?.name ?? '').trim()
  const symbol = String(input?.symbol ?? '').trim().replace(/^\$/, '')
  if (!name || name.length > LIMITS.name) throw new AgentError(400, `name is required, at most ${LIMITS.name} characters`)
  if (!symbol || symbol.length > LIMITS.symbol) throw new AgentError(400, `symbol is required, at most ${LIMITS.symbol} characters`)

  const options = await agentOptions(env, deps)
  const wanted = String(input?.quote ?? input?.quoteMint ?? input?.quoteSymbol ?? '').trim()
  if (!wanted) throw new AgentError(400, 'quote is required: the symbol or mint of an ownership coin from /api/agent/options')
  const coin = options.coins.find((c) => c.mint === wanted || c.symbol.toLowerCase() === wanted.replace(/^\$/, '').toLowerCase())
  if (!coin) {
    throw new AgentError(400, `no open ownership coin matches "${wanted}"`, { available: options.coins.map((c) => c.symbol) })
  }
  const tier = input?.tier ? coin.tiers.find((t) => t.id === String(input.tier)) : coin.tiers[0]
  if (!tier) throw new AgentError(400, `tier "${input.tier}" is not open for ${coin.symbol}`, { open: coin.tiers.map((t) => t.id) })

  const holderPct = input?.holderPct === undefined ? DEFAULT_HOLDER_PCT : clampHolderPct(input.holderPct)
  const devBuyPercent = Math.max(0, Math.min(LIMITS.devBuyMaxPercent, Number(input?.devBuyPercent ?? 0) || 0))
  const creator = input?.creator ? String(input.creator).trim() : null
  if (creator && !BASE58.test(creator)) throw new AgentError(400, 'creator must be a Solana wallet address')

  return {
    coin,
    tier,
    holderPct,
    devBuyPercent,
    creator,
    token: {
      name,
      symbol,
      description: String(input?.description ?? '').slice(0, LIMITS.description),
      website: httpUrl(input?.website),
      twitter: String(input?.twitter ?? '').slice(0, 100),
    },
  }
}

// ── the launch itself ───────────────────────────────────────────────────────

/**
 * Keeps a launch as a draft, and with a creator also builds its transactions.
 *
 * The transactions come back signed by the mint and by nobody else. The creator signs
 * every one without changing it; the server remembers each message's hash so that
 * /api/agent/submit sends only launches it prepared, rather than acting as an open
 * relay for whatever anyone posts.
 */
export async function prepareLaunch(env, origin, input, deps) {
  if (!env.REGISTRY) throw new AgentError(501, 'launches are not configured on this deployment')
  const request = await readRequest(env, input, deps)
  const image = await storeImage(env, origin, { imageUrl: input?.imageUrl, imageData: input?.imageData })
  const token = { ...request.token, image }
  const uri = await storeMetadata(env, origin, token)

  const id = crypto.randomUUID()
  const draft = {
    id,
    createdAt: new Date().toISOString(),
    name: token.name,
    symbol: token.symbol,
    description: token.description,
    image: token.image,
    website: token.website,
    twitter: token.twitter,
    uri,
    quoteMint: request.coin.mint,
    quoteSymbol: request.coin.symbol,
    tier: request.tier.id,
    holderPct: request.holderPct,
    devBuyPercent: request.devBuyPercent,
  }
  await env.REGISTRY.put(`agentdraft:v1:${id}`, JSON.stringify(draft), { expirationTtl: DRAFT_TTL })

  const cut = splitFor(request.holderPct)
  const common = {
    id,
    launchUrl: `${origin}/launch?draft=${id}`,
    token: { name: token.name, symbol: token.symbol, image: token.image, uri },
    quote: { symbol: request.coin.symbol, mint: request.coin.mint },
    tier: request.tier,
    feeShares: {
      note: 'Percent of the trading fee left after Meteora takes its cut.',
      creator: cut.creator,
      holders: cut.holders,
      lfownDao: cut.partner,
    },
  }

  if (!request.creator) {
    return {
      ...common,
      mode: 'link',
      next: 'Give launchUrl to a person with a Solana wallet. Everything is filled in; they review it and sign on the page.',
    }
  }

  const [{ Connection, Keypair, PublicKey }, { DynamicBondingCurveClient }, { take }, builder, { getAssociatedTokenAddressSync }] =
    await Promise.all([
      import('@solana/web3.js'),
      import('@meteora-ag/dynamic-bonding-curve-sdk'),
      import('./lib/mint-pool.mjs'),
      import('./lib/launch-builder.mjs'),
      import('@solana/spl-token'),
    ])
  const connection = new Connection(env.HELIUS_RPC, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  const creator = new PublicKey(request.creator)
  const configValue = JSON.parse(await env.REGISTRY.get(`config:${request.coin.mint}:${request.tier.id}`))

  const warnings = []
  let devBuyQuote = 0
  let devBuy = null
  if (request.devBuyPercent > 0) {
    const cost = await builder.devBuyCost(client, { config: configValue.config, percent: request.devBuyPercent })
    devBuyQuote = Math.ceil(cost.quoteIn * 1e6)
    devBuy = { percent: request.devBuyPercent, tokens: cost.baseOut, costs: cost.quoteIn, in: request.coin.symbol }
    let held = 0
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(request.coin.mint), creator)
      held = Number((await connection.getTokenAccountBalance(ata)).value.amount)
    } catch { /* no account for it yet means none held */ }
    if (held < devBuyQuote) {
      throw new AgentError(400, `a ${request.devBuyPercent}% dev buy costs ${cost.quoteIn} ${request.coin.symbol} and the creator holds ${held / 1e6}. Fund the wallet with ${request.coin.symbol}, lower devBuyPercent, or set it to 0.`)
    }
  }
  const lamports = await connection.getBalance(creator)
  if (lamports < 0.03 * 1e9) warnings.push(`the creator holds ${lamports / 1e9} SOL; a launch needs roughly 0.03 SOL for rent and fees`)

  const drawn = await take(env.REGISTRY)
  const mint = drawn ? Keypair.fromSeed(drawn.seed) : Keypair.generate()
  if (!drawn) warnings.push('the address reserve was empty, so this coin does not end in "own"')

  const built = await builder.buildLaunchTransactions({
    client,
    connection,
    config: configValue.config,
    creator: request.creator,
    token: { name: token.name, symbol: token.symbol, uri },
    devBuyQuote,
    mint,
    quoteMint: request.coin.mint,
    holderPct: request.holderPct,
  })

  const transactions = []
  const hashes = []
  for (const [index, tx] of built.transactions.entries()) {
    tx.partialSign(mint)
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    hashes.push(await digest(tx.serializeMessage()))
    transactions.push({
      index,
      purpose: built.transactions.length > 1 && index === 0 ? 'open-fee-vault' : 'launch',
      base64: btoa(String.fromCharCode(...bytes)),
    })
  }
  await env.REGISTRY.put(`agentlaunch:v1:${id}`, JSON.stringify({
    creator: request.creator,
    mint: built.baseMint,
    hashes,
    lastValidBlockHeight: built.lastValidBlockHeight,
  }), { expirationTtl: LAUNCH_TTL })

  return {
    ...common,
    mode: 'sign',
    mint: built.baseMint,
    vanity: Boolean(drawn),
    pool: built.pool,
    vault: built.vault,
    devBuy,
    signer: request.creator,
    transactions,
    lastValidBlockHeight: built.lastValidBlockHeight,
    coinUrl: `${origin}/coins/${built.baseMint}`,
    submit: { method: 'POST', url: `${origin}/api/agent/submit`, body: { id, transactions: ['<each transaction, signed by the creator, base64>'] } },
    next: 'Sign every transaction with the creator wallet without changing it — the mint has already signed — then POST them to submit, in order, within about a minute. Or send them yourself, each confirmed before the next.',
    warnings,
  }
}

/** Sends a prepared launch's signed transactions in order, each confirmed before the next. */
export async function submitLaunch(env, origin, input, deps) {
  const id = String(input?.id ?? '')
  const record = env.REGISTRY ? await env.REGISTRY.get(`agentlaunch:v1:${id}`, 'json') : null
  if (!record) throw new AgentError(404, 'no prepared launch with that id; it may have expired — call /api/agent/launch again')
  const signed = Array.isArray(input?.transactions) ? input.transactions : []
  if (signed.length !== record.hashes.length) {
    throw new AgentError(400, `expected ${record.hashes.length} signed transaction(s), received ${signed.length}`)
  }

  const [{ Connection, Transaction }, { waitFor }] = await Promise.all([import('@solana/web3.js'), import('./lib/confirm.mjs')])
  const connection = new Connection(env.HELIUS_RPC, 'confirmed')

  const txs = []
  for (const [i, encoded] of signed.entries()) {
    let tx
    try {
      tx = Transaction.from(Uint8Array.from(atob(String(encoded)), (c) => c.charCodeAt(0)))
    } catch {
      throw new AgentError(400, `transaction ${i} is not a base64 Solana transaction`)
    }
    if (await digest(tx.serializeMessage()) !== record.hashes[i]) {
      throw new AgentError(400, `transaction ${i} is not the one prepared for this launch — sign it without changing it`)
    }
    if (!tx.verifySignatures(true)) throw new AgentError(400, `transaction ${i} is missing the creator's signature`)
    txs.push(tx)
  }

  const signatures = []
  for (const [i, tx] of txs.entries()) {
    let signature
    try {
      signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' })
      await waitFor(connection, signature, record.lastValidBlockHeight, { timeoutMs: 60_000 })
    } catch (e) {
      throw new AgentError(502, `transaction ${i} did not land: ${e.message}`, { landed: signatures })
    }
    signatures.push(signature)
  }
  await env.REGISTRY.delete(`agentlaunch:v1:${id}`)

  // What the launch page does once its launch confirms: the coin is read from chain and
  // added to the list, so it is announced and watched without waiting for a rebuild.
  await deps.crankOne(env, record.mint).catch((e) => console.error(`agent launch ${record.mint}: listing failed: ${e.message}`))
  return { mint: record.mint, signatures, coinUrl: `${origin}/coins/${record.mint}` }
}

/** A draft as the launch page reads it back. Nothing in it is secret. */
export async function readDraft(env, id) {
  if (!/^[0-9a-f-]{36}$/.test(id) || !env.REGISTRY) return null
  return env.REGISTRY.get(`agentdraft:v1:${id}`, 'json')
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const OPENAPI = (origin) => ({
  openapi: '3.1.0',
  info: {
    title: 'LFOwn agent API',
    version: '1.0.0',
    description: 'Launch a memecoin paired with a MetaDAO ownership coin on Solana. Nothing is signed for the creator: with a creator wallet you get transactions to sign, without one you get a link for a person to sign.',
  },
  servers: [{ url: origin }],
  paths: {
    '/api/agent/options': {
      get: { operationId: 'listLaunchOptions', summary: 'Ownership coins a coin can be paired with, their open tiers, fee split and limits', responses: { 200: { description: 'Options' } } },
    },
    '/api/agent/launch': {
      post: {
        operationId: 'prepareLaunch',
        summary: 'Prepare a launch: a signing link, or with a creator wallet the transactions to sign',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['name', 'symbol', 'quote'],
            properties: {
              name: { type: 'string', maxLength: LIMITS.name },
              symbol: { type: 'string', maxLength: LIMITS.symbol },
              quote: { type: 'string', description: 'Symbol or mint of an ownership coin from /api/agent/options' },
              tier: { type: 'string', enum: TIERS.map((t) => t.id), description: 'Defaults to the first open tier' },
              description: { type: 'string', maxLength: LIMITS.description },
              imageUrl: { type: 'string', format: 'uri' },
              imageData: { type: 'string', description: 'base64 data URL; png, jpeg, webp or gif, under 2 MB' },
              website: { type: 'string', format: 'uri' },
              twitter: { type: 'string' },
              holderPct: { type: 'integer', minimum: 0, maximum: HOLDER_MAX_PCT, default: DEFAULT_HOLDER_PCT },
              devBuyPercent: { type: 'number', minimum: 0, maximum: LIMITS.devBuyMaxPercent, default: 0, description: 'Percent of supply bought at launch, paid in the ownership coin by the creator' },
              creator: { type: 'string', description: 'The Solana wallet that signs and earns the fees. Omit to get a link for a person to sign.' },
            },
          } } },
        },
        responses: { 200: { description: 'A prepared launch' }, 400: { description: 'Invalid request' } },
      },
    },
    '/api/agent/submit': {
      post: {
        operationId: 'submitLaunch',
        summary: 'Send a prepared launch, signed by the creator, in order',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['id', 'transactions'],
            properties: { id: { type: 'string' }, transactions: { type: 'array', items: { type: 'string', description: 'base64' } } },
          } } },
        },
        responses: { 200: { description: 'Launched' }, 400: { description: 'Not the prepared transactions' }, 404: { description: 'Unknown or expired' } },
      },
    },
  },
})

/**
 * Answers /api/agent/*, or returns null for anything else. Open to every origin:
 * nothing here can move funds, and an agent is by definition somewhere else.
 */
export async function handleAgent(url, request, env, ctx, deps) {
  const path = url.pathname
  if (path !== '/api/agent' && !path.startsWith('/api/agent/')) return null
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  const origin = env.PUBLIC_ORIGIN || url.origin

  try {
    if (path === '/api/agent' && request.method === 'GET') {
      return reply({
        name: 'LFOwn agent API',
        about: 'Launch a memecoin paired with a MetaDAO ownership coin on Solana.',
        guide: `${origin}/llms.txt`,
        openapi: `${origin}/api/agent/openapi.json`,
        mcp: `${origin}/mcp`,
        endpoints: {
          options: `GET ${origin}/api/agent/options`,
          launch: `POST ${origin}/api/agent/launch`,
          submit: `POST ${origin}/api/agent/submit`,
        },
      })
    }
    if (path === '/api/agent/openapi.json' && request.method === 'GET') return reply(OPENAPI(origin))
    if (path === '/api/agent/options' && request.method === 'GET') {
      return reply(await agentOptions(env, deps), { headers: { 'cache-control': 'public, max-age=60' } })
    }
    if (path.startsWith('/api/agent/draft/') && request.method === 'GET') {
      const draft = await readDraft(env, path.slice('/api/agent/draft/'.length))
      return draft ? reply(draft) : reply({ error: 'no draft with that id; drafts are kept for seven days' }, { status: 404 })
    }
    if ((path === '/api/agent/launch' || path === '/api/agent/submit') && request.method === 'POST') {
      if (await deps.limited(env.HEAVY_LIMITER, request)) return reply({ error: 'too many requests; try again in a minute' }, { status: 429, headers: { 'retry-after': '60' } })
      const input = await request.json().catch(() => null)
      if (!input || typeof input !== 'object') return reply({ error: 'send a JSON object' }, { status: 400 })
      const result = path === '/api/agent/launch'
        ? await prepareLaunch(env, origin, input, deps)
        : await submitLaunch(env, origin, input, deps)
      return reply(result)
    }
    return reply({ error: 'not found', see: `${origin}/api/agent` }, { status: 404 })
  } catch (e) {
    if (e instanceof AgentError) return reply({ error: e.message, ...(e.details ? { details: e.details } : {}) }, { status: e.status })
    console.error(`agent api ${path}: ${e.stack ?? e.message}`)
    return reply({ error: 'something went wrong building this launch', detail: e.message }, { status: 500 })
  }
}

export { AgentError }
