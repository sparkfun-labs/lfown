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
//                      send — or to post to submit, which sends them in order and
//                      waits for each.
//   without `creator`  the server keeps the launch as a draft and answers with a link
//                      to /launch, filled in, for a person to review and sign.
//
// Every launch is a draft first, and a draft's id is what makes retrying cheap: calling
// prepare again with it reuses the stored image and metadata and the same mint address,
// so an agent whose transactions expired while it asked a human does not leave a trail
// of abandoned files and burnt `own` addresses behind it. `validate` checks everything
// without storing anything at all.
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
// The mint seed a draft launches under, kept apart from the draft itself because the
// draft is public and the seed is not. A day covers any retry worth making.
const MINT_TTL = 24 * 60 * 60
// Solana's target slot time. Only used to turn a block height into a clock time for
// the agent; the height itself stays the authority.
const SLOT_MS = 400

/** The unit every fee percentage in this API is quoted in. One unit, everywhere. */
export const SHARE_UNIT = "percent of the trading fee left after Meteora's cut"

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
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * A holder share as every number an agent might want, in one unit.
 *
 * The slider, `holderPct` and every share below are percentages of what is left of a
 * trading fee once Meteora has taken its cut — which is also how the config splits it.
 * `perTradeBps` is the same thing in basis points of the trade itself, for an agent
 * that wants to tell a person "0.5% of every trade goes to holders".
 */
export function feeShares(holderPct, feeBps = FEES.totalBps) {
  const cut = splitFor(holderPct)
  const { protocol } = feeBreakdown(feeBps)
  const shared = feeBps - protocol
  const bps = (pct) => (shared * pct) / 100
  return {
    unit: SHARE_UNIT,
    creator: cut.creator,
    holders: cut.holders,
    lfownDao: cut.partner,
    perTradeBps: { fee: feeBps, meteora: protocol, creator: bps(cut.creator), holders: bps(cut.holders), lfownDao: bps(cut.partner) },
  }
}

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
        feeBps: cfg.feeBps ?? FEES.totalBps,
        config: cfg.config,
      })
    }
    return tiers.length
      ? {
          symbol: coin.symbol, name: coin.name, mint: coin.mint, usdPrice: coin.usdPrice, treasuryUsd: coin.treasury, holders: coin.holders,
          financials: coin.financials
            ? { source: '01Resolved', navPerToken: coin.financials.navPerToken, runwayMonths: coin.financials.runwayMonths, marketCap: coin.financials.marketCap, url: coin.financials.url }
            : null,
          tiers,
        }
      : null
  }))
  const cut = feeBreakdown(FEES.totalBps)
  return {
    coins: rows.filter(Boolean),
    tradingFee: {
      bps: FEES.totalBps,
      meteoraBps: cut.protocol,
      note: `Every trade pays ${FEES.totalBps / 100}%. Meteora takes ${cut.protocol / 100}% of the trade first; every share in this API is a ${SHARE_UNIT}.`,
    },
    holders: {
      default: DEFAULT_HOLDER_PCT,
      max: HOLDER_MAX_PCT,
      unit: SHARE_UNIT,
      note: `The LFOwn DAO always takes 50. The creator splits the other 50 with holders: holderPct is the holders' part (0-${HOLDER_MAX_PCT}), the creator keeps the rest. Paid hourly, pro rata, in the ownership coin. Fixed at launch.`,
      example: feeShares(DEFAULT_HOLDER_PCT),
    },
    limits: LIMITS,
  }
}

// ── reading a request ───────────────────────────────────────────────────────

/** Reads and checks what an agent asked for, before anything is stored or built. */
async function readRequest(env, input, deps) {
  const name = String(input?.name ?? '').trim()
  const symbol = String(input?.symbol ?? '').trim().replace(/^\$/, '')
  if (!name || name.length > LIMITS.name) throw new AgentError(400, `name is required, at most ${LIMITS.name} characters`)
  if (!symbol || symbol.length > LIMITS.symbol) throw new AgentError(400, `symbol is required, at most ${LIMITS.symbol} characters`)

  const options = await agentOptions(env, deps)
  const wanted = String(input?.quote ?? input?.quoteMint ?? input?.quoteSymbol ?? '').trim()
  if (!wanted) throw new AgentError(400, 'quote is required: the symbol or mint of an ownership coin from the launch options')
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

  if (input?.imageData && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(String(input.imageData))) {
    throw new AgentError(400, 'imageData must be a base64 data URL of a png, jpeg, webp or gif')
  }
  if (input?.imageData && (String(input.imageData).length * 3) / 4 > LIMITS.imageBytes * 1.01) {
    throw new AgentError(413, 'the image must be under 2 MB')
  }
  if (input?.imageUrl && !httpUrl(input.imageUrl)) throw new AgentError(400, 'imageUrl must be an http(s) URL')

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

/**
 * A request, or a retry of one. With `id`, everything comes from the stored draft and
 * only `creator` and `devBuyPercent` may be given afresh — the rest is what a person
 * may already have been shown, and changing it means a new draft.
 */
async function requestFrom(env, input, deps) {
  if (!input?.id) return readRequest(env, input, deps)
  const draft = await readDraft(env, String(input.id))
  if (!draft) throw new AgentError(404, 'no draft with that id; drafts are kept for seven days. Call prepare_launch without id to start a new one.')
  const request = await readRequest(env, {
    name: draft.name,
    symbol: draft.symbol,
    quote: draft.quoteMint,
    tier: draft.tier,
    description: draft.description,
    website: draft.website,
    twitter: draft.twitter,
    holderPct: draft.holderPct,
    devBuyPercent: input.devBuyPercent ?? draft.devBuyPercent,
    creator: input.creator,
  }, deps)
  return { ...request, draft }
}

/**
 * What chain has to say about a launch before it is built: what the dev buy costs,
 * and whether the creator can pay for it and for the rent. Problems stop a launch;
 * warnings are passed on.
 */
async function chainChecks(env, request) {
  const out = { problems: [], warnings: [], devBuy: null, devBuyQuote: 0 }
  if (!request.creator && !(request.devBuyPercent > 0)) return out

  const [{ Connection, PublicKey }, { DynamicBondingCurveClient }, builder, { getAssociatedTokenAddressSync }] =
    await Promise.all([
      import('@solana/web3.js'),
      import('@meteora-ag/dynamic-bonding-curve-sdk'),
      import('./lib/launch-builder.mjs'),
      import('@solana/spl-token'),
    ])
  const connection = new Connection(env.HELIUS_RPC, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  Object.assign(out, { connection, client, builder })

  const symbol = request.coin.symbol
  if (request.devBuyPercent > 0) {
    const cost = await builder.devBuyCost(client, { config: request.tier.config, percent: request.devBuyPercent })
    out.devBuyQuote = Math.ceil(cost.quoteIn * 1e6)
    out.devBuy = { percent: request.devBuyPercent, tokens: cost.baseOut, costs: cost.quoteIn, in: symbol }
  }
  if (request.creator) {
    const creator = new PublicKey(request.creator)
    if (out.devBuyQuote > 0) {
      let held = 0
      try {
        const ata = getAssociatedTokenAddressSync(new PublicKey(request.coin.mint), creator)
        held = Number((await connection.getTokenAccountBalance(ata)).value.amount)
      } catch { /* no account for it yet means none held */ }
      if (held < out.devBuyQuote) {
        out.problems.push(`A ${request.devBuyPercent}% dev buy costs ${out.devBuy.costs} ${symbol} and the creator holds ${held / 1e6}. Fund the wallet with ${symbol}, lower devBuyPercent, or set it to 0.`)
      }
    }
    const lamports = await connection.getBalance(creator)
    if (lamports < 0.03 * 1e9) {
      out.warnings.push(`the creator holds ${lamports / 1e9} SOL; a launch needs roughly 0.03 SOL for rent and fees`)
    }
  }
  return out
}

const summary = (request) => ({
  token: { name: request.token.name, symbol: request.token.symbol },
  quote: { symbol: request.coin.symbol, mint: request.coin.mint },
  tier: { id: request.tier.id, label: request.tier.label, threshold: request.tier.threshold, thresholdUsd: request.tier.thresholdUsd },
  feeShares: feeShares(request.holderPct, request.tier.feeBps),
})

// ── storing what a launch needs ─────────────────────────────────────────────

async function storeImage(env, origin, { imageUrl, imageData }) {
  if (!env.IMAGES) throw new AgentError(501, 'image hosting is not configured on this deployment')
  let bytes
  let type
  if (imageData) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(imageData))
    type = match[1]
    bytes = fromBase64(match[2])
  } else if (imageUrl) {
    const url = httpUrl(imageUrl)
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

// ── validate, prepare, submit ───────────────────────────────────────────────

/**
 * Everything prepare checks, and nothing it stores: no draft, no image, no metadata,
 * no mint address taken. Invalid input is an answer here, not an error.
 */
export async function validateLaunch(env, origin, input, deps) {
  let request
  try {
    request = await requestFrom(env, input, deps)
  } catch (e) {
    if (!(e instanceof AgentError)) throw e
    return { ok: false, problems: [e.message], warnings: [], ...(e.details ? { details: e.details } : {}) }
  }
  const checks = await chainChecks(env, request)
  return {
    ok: checks.problems.length === 0,
    problems: checks.problems,
    warnings: checks.warnings,
    mode: request.creator ? 'sign' : 'link',
    ...summary(request),
    devBuy: checks.devBuy,
    next: checks.problems.length
      ? 'Fix the problems, then validate again.'
      : 'Nothing was stored. Call prepare_launch with the same arguments to go ahead.',
  }
}

const expiredMessage = (id) =>
  `these transactions have expired — a Solana transaction is only valid for about a minute. Call prepare_launch again with {"id": "${id}", "creator": ...}: same coin, same address, fresh transactions to sign.`

/**
 * Keeps a launch as a draft, and with a creator also builds its transactions.
 *
 * The transactions come back signed by the mint and by nobody else. The creator signs
 * every one without changing it; the server remembers each message's hash so that
 * submit sends only launches it prepared, rather than acting as an open relay for
 * whatever anyone posts.
 */
export async function prepareLaunch(env, origin, input, deps, { via = 'http' } = {}) {
  if (!env.REGISTRY) throw new AgentError(501, 'launches are not configured on this deployment')
  const request = await requestFrom(env, input, deps)
  // Checked before anything is stored, so a launch that cannot go ahead leaves nothing.
  const checks = await chainChecks(env, request)
  if (checks.problems.length) throw new AgentError(400, checks.problems.join(' '))

  let draft = request.draft
  if (!draft) {
    const image = await storeImage(env, origin, { imageUrl: input?.imageUrl, imageData: input?.imageData })
    const token = { ...request.token, image }
    draft = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      name: token.name,
      symbol: token.symbol,
      description: token.description,
      image: token.image,
      website: token.website,
      twitter: token.twitter,
      uri: await storeMetadata(env, origin, token),
      quoteMint: request.coin.mint,
      quoteSymbol: request.coin.symbol,
      tier: request.tier.id,
      holderPct: request.holderPct,
      devBuyPercent: request.devBuyPercent,
    }
    await env.REGISTRY.put(`agentdraft:v1:${draft.id}`, JSON.stringify(draft), { expirationTtl: DRAFT_TTL })
  } else if (draft.devBuyPercent !== request.devBuyPercent) {
    draft = { ...draft, devBuyPercent: request.devBuyPercent }
    await env.REGISTRY.put(`agentdraft:v1:${draft.id}`, JSON.stringify(draft), { expirationTtl: DRAFT_TTL })
  }
  const id = draft.id

  const common = {
    id,
    launchUrl: `${origin}/launch?draft=${id}`,
    ...summary(request),
    token: { name: draft.name, symbol: draft.symbol, image: draft.image, uri: draft.uri },
    devBuy: checks.devBuy,
  }

  if (!request.creator) {
    return {
      ...common,
      mode: 'link',
      next: 'Give launchUrl to a person with a Solana wallet. Everything is filled in; they review it and sign on the page. The link works for seven days.',
      warnings: checks.warnings,
    }
  }

  const { connection, client, builder } = checks
  const [{ Keypair }, { take }] = await Promise.all([import('@solana/web3.js'), import('./lib/mint-pool.mjs')])

  // A retry launches under the address the draft was first given, unless that coin
  // already exists — then it has been launched, and a second one would be a new coin.
  let mint = null
  let vanity = false
  const kept = await env.REGISTRY.get(`agentmint:v1:${id}`)
  if (kept) {
    const previous = Keypair.fromSeed(fromBase64(kept))
    if (await connection.getAccountInfo(previous.publicKey)) {
      throw new AgentError(409, `this draft has already been launched: ${origin}/coins/${previous.publicKey.toBase58()}`)
    }
    mint = previous
    vanity = previous.publicKey.toBase58().endsWith('own')
  }
  const warnings = [...checks.warnings]
  if (!mint) {
    const drawn = await take(env.REGISTRY)
    mint = drawn ? Keypair.fromSeed(drawn.seed) : Keypair.generate()
    vanity = Boolean(drawn)
    if (!drawn) warnings.push('the address reserve was empty, so this coin does not end in "own"')
    await env.REGISTRY.put(`agentmint:v1:${id}`, toBase64(mint.secretKey.slice(0, 32)), { expirationTtl: MINT_TTL })
  }

  const built = await builder.buildLaunchTransactions({
    client,
    connection,
    config: request.tier.config,
    creator: request.creator,
    token: { name: draft.name, symbol: draft.symbol, uri: draft.uri },
    devBuyQuote: checks.devBuyQuote,
    mint,
    quoteMint: request.coin.mint,
    holderPct: request.holderPct,
  })

  const transactions = []
  const hashes = []
  for (const [index, tx] of built.transactions.entries()) {
    tx.partialSign(mint)
    hashes.push(await digest(tx.serializeMessage()))
    transactions.push({
      index,
      purpose: built.transactions.length > 1 && index === 0 ? 'open-fee-vault' : 'launch',
      base64: toBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false })),
    })
  }
  await env.REGISTRY.put(`agentlaunch:v1:${id}`, JSON.stringify({
    creator: request.creator,
    mint: built.baseMint,
    hashes,
    lastValidBlockHeight: built.lastValidBlockHeight,
  }), { expirationTtl: LAUNCH_TTL })

  const height = await connection.getBlockHeight('confirmed').catch(() => built.lastValidBlockHeight - 150)
  const expiresInSeconds = Math.max(0, Math.floor(((built.lastValidBlockHeight - height) * SLOT_MS) / 1000))
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString()

  const how = via === 'mcp'
    ? 'call the submit_launch tool with {id, transactions}'
    : `POST {id, transactions} to ${origin}/api/agent/submit`
  return {
    ...common,
    mode: 'sign',
    mint: built.baseMint,
    vanity,
    pool: built.pool,
    vault: built.vault,
    signer: request.creator,
    expiresAt,
    expiresInSeconds,
    lastValidBlockHeight: built.lastValidBlockHeight,
    transactions,
    coinUrl: `${origin}/coins/${built.baseMint}`,
    next: `Sign every transaction with ${request.creator} without changing it — the mint has already signed — then ${how} before ${expiresAt}. transactions may be these objects as returned or their base64 strings, in order. Do not ask a person to confirm in between: if they need to review, use launchUrl instead. If it expires, call prepare_launch again with {id, creator} for fresh transactions under the same address.`,
    warnings,
  }
}

/** Sends a prepared launch's signed transactions in order, each confirmed before the next. */
export async function submitLaunch(env, origin, input, deps) {
  const id = String(input?.id ?? '')
  const record = env.REGISTRY ? await env.REGISTRY.get(`agentlaunch:v1:${id}`, 'json') : null
  if (!record) {
    throw new AgentError(410, `no transactions are waiting for id "${id}". They are dropped once expired. Call prepare_launch again with {id, creator} for fresh ones — same coin, same address.`)
  }
  // As prepare returned them, or just their base64: both are what an agent would pass.
  const signed = (Array.isArray(input?.transactions) ? input.transactions : [])
    .map((t) => (typeof t === 'string' ? t : t?.base64))
  if (signed.length !== record.hashes.length) {
    throw new AgentError(400, `expected ${record.hashes.length} signed transaction(s), received ${signed.length}`)
  }

  const [{ Connection, Transaction }, { waitFor }] = await Promise.all([import('@solana/web3.js'), import('./lib/confirm.mjs')])
  const connection = new Connection(env.HELIUS_RPC, 'confirmed')

  const txs = []
  for (const [i, encoded] of signed.entries()) {
    let tx
    try {
      tx = Transaction.from(fromBase64(String(encoded)))
    } catch {
      throw new AgentError(400, `transaction ${i} is not a base64 Solana transaction`)
    }
    if (await digest(tx.serializeMessage()) !== record.hashes[i]) {
      throw new AgentError(400, `transaction ${i} is not the one prepared for this launch — sign it without changing it`)
    }
    if (!tx.verifySignatures(true)) throw new AgentError(400, `transaction ${i} is missing the creator's signature`)
    txs.push(tx)
  }

  if (await connection.getBlockHeight('confirmed') > record.lastValidBlockHeight) {
    throw new AgentError(410, expiredMessage(id))
  }

  const signatures = []
  for (const [i, tx] of txs.entries()) {
    let signature
    try {
      signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' })
      await waitFor(connection, signature, record.lastValidBlockHeight, { timeoutMs: 60_000 })
    } catch (e) {
      if (/blockhash not found|block height exceeded|expired/i.test(e.message)) {
        throw new AgentError(410, expiredMessage(id), { landed: signatures })
      }
      throw new AgentError(502, `transaction ${i} did not land: ${e.message}`, { landed: signatures })
    }
    signatures.push(signature)
  }
  await Promise.all([env.REGISTRY.delete(`agentlaunch:v1:${id}`), env.REGISTRY.delete(`agentmint:v1:${id}`)])

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

const LAUNCH_PROPERTIES = {
  id: { type: 'string', description: 'A draft id from an earlier prepare. Reuses its token, image, metadata and mint address; only creator and devBuyPercent may be given with it.' },
  name: { type: 'string', maxLength: LIMITS.name },
  symbol: { type: 'string', maxLength: LIMITS.symbol },
  quote: { type: 'string', description: 'Symbol or mint of an ownership coin from the launch options' },
  tier: { type: 'string', enum: TIERS.map((t) => t.id), description: 'Defaults to the first open tier' },
  description: { type: 'string', maxLength: LIMITS.description },
  imageUrl: { type: 'string', format: 'uri' },
  imageData: { type: 'string', description: 'base64 data URL; png, jpeg, webp or gif, under 2 MB' },
  website: { type: 'string', format: 'uri' },
  twitter: { type: 'string' },
  holderPct: { type: 'integer', minimum: 0, maximum: HOLDER_MAX_PCT, default: DEFAULT_HOLDER_PCT, description: `Holders' share, as a ${SHARE_UNIT}. The DAO always takes 50; the creator keeps 50 minus this.` },
  devBuyPercent: { type: 'number', minimum: 0, maximum: LIMITS.devBuyMaxPercent, default: 0, description: 'Percent of supply bought at launch, paid in the ownership coin by the creator' },
  creator: { type: 'string', description: 'The Solana wallet that signs and earns the fees. Omit to get a link for a person to sign.' },
}

const OPENAPI = (origin) => ({
  openapi: '3.1.0',
  info: {
    title: 'LFOwn agent API',
    version: '1.1.0',
    description: `Launch a memecoin paired with a MetaDAO ownership coin on Solana. Nothing is signed for the creator: with a creator wallet you get transactions to sign, without one you get a link for a person to sign. Every fee share is a ${SHARE_UNIT}. MCP clients should use ${origin}/mcp instead; it exposes the same operations as tools.`,
  },
  servers: [{ url: origin }],
  paths: {
    '/api/agent/options': {
      get: { operationId: 'listLaunchOptions', summary: 'Ownership coins a coin can be paired with, their open tiers, fee split and limits', responses: { 200: { description: 'Options' } } },
    },
    '/api/agent/validate': {
      post: {
        operationId: 'validateLaunch',
        summary: 'Check a launch without storing anything: answers {ok, problems, warnings} and what the launch would be',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: LAUNCH_PROPERTIES } } } },
        responses: { 200: { description: 'The verdict' } },
      },
    },
    '/api/agent/launch': {
      post: {
        operationId: 'prepareLaunch',
        summary: 'Prepare a launch: a signing link, or with a creator wallet the transactions to sign (valid about a minute, see expiresAt)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['name', 'symbol', 'quote'], properties: LAUNCH_PROPERTIES } } },
        },
        responses: { 200: { description: 'A prepared launch' }, 400: { description: 'Invalid request' }, 409: { description: 'That draft was already launched' } },
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
            properties: {
              id: { type: 'string' },
              transactions: {
                type: 'array',
                description: 'In the order returned. Either the objects prepare returned, or their base64 strings, signed by the creator.',
                items: { oneOf: [{ type: 'string' }, { type: 'object', required: ['base64'], properties: { base64: { type: 'string' } } }] },
              },
            },
          } } },
        },
        responses: { 200: { description: 'Launched' }, 400: { description: 'Not the prepared transactions' }, 410: { description: 'Expired: prepare again with the same id' } },
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
        note: 'MCP clients: use /mcp. Everyone else: these endpoints. Both do exactly the same thing.',
        endpoints: {
          options: `GET ${origin}/api/agent/options`,
          validate: `POST ${origin}/api/agent/validate`,
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
    const routes = { '/api/agent/validate': validateLaunch, '/api/agent/launch': prepareLaunch, '/api/agent/submit': submitLaunch }
    if (routes[path] && request.method === 'POST') {
      if (await deps.limited(env.HEAVY_LIMITER, request)) return reply({ error: 'too many requests; try again in a minute' }, { status: 429, headers: { 'retry-after': '60' } })
      const input = await request.json().catch(() => null)
      if (!input || typeof input !== 'object') return reply({ error: 'send a JSON object' }, { status: 400 })
      return reply(await routes[path](env, origin, input, deps))
    }
    return reply({ error: 'not found', see: `${origin}/api/agent` }, { status: 404 })
  } catch (e) {
    if (e instanceof AgentError) return reply({ error: e.message, ...(e.details ? { details: e.details } : {}) }, { status: e.status })
    console.error(`agent api ${path}: ${e.stack ?? e.message}`)
    return reply({ error: 'something went wrong building this launch', detail: e.message }, { status: 500 })
  }
}

export { AgentError }
