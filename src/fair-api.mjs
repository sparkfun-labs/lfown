// LFOwn — the fair-launch API, loaded only when a /api/fair/ route is asked for.
//
// Fair launches run on a test cluster until their programs are audited, so all of this is
// off unless the Worker is told which cluster to use:
//
//   FAIR_CLUSTER      localnet | devnet — required; anything else keeps fair launches off,
//                     and the RPC's genesis hash must match it
//   FAIR_RPC          that cluster's RPC URL (never sent to the browser: it may hold a key)
//   FAIR_QUOTES       JSON: [{ mint, symbol, name, usdPrice }] — the coins a raise may be
//                     priced in there. Ownership coins do not exist on a test cluster, so
//                     these are stand-ins with a stand-in price.
//   FAIR_TERMS        optional JSON overriding TERMS (a local run wants a three-minute raise)
//   FAIR_GOVERNANCE   optional JSON overriding GOVERNANCE (and five-minute proposals)
//   FAIR_KEEPER_KEY   JSON secret key that cranks raises and DAOs (see lib/fair-keeper.mjs)
//   FAIR_FAUCET_KEY   JSON secret key holding the stand-in coins' mint authority
//
// Without FAIR_RPC every route answers 404 and the site shows no trace of fair launches.
// With it, the pages say which cluster they are on, on every screen.

import { GOVERNANCE, TERMS } from './lib/fair-launch.mjs'

const json = (body, init = {}) => new Response(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), {
  ...init,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(init.headers ?? {}) },
})

/** An option's action with its keys and amounts as strings. */
const plainAction = (a) => (a.transfer
  ? { transfer: { mint: a.transfer.mint.toBase58(), amount: a.transfer.amount.toString(), recipient: a.transfer.recipient.toBase58() } }
  : { mintTo: { amount: a.mintTo.amount.toString(), recipient: a.mintTo.recipient.toBase58() } })

const parse = (value, fallback) => {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

/** The fair-launch settings, or null when fair launches are off. */
export function fairConfig(env) {
  if (!env.FAIR_RPC || !['localnet', 'devnet'].includes(env.FAIR_CLUSTER)) return null
  const terms = { ...TERMS, ...parse(env.FAIR_TERMS, {}) }
  const governance = { ...GOVERNANCE, ...parse(env.FAIR_GOVERNANCE, {}) }
  for (const k of ['tokensForInvestors', 'tokensForPool']) terms[k] = BigInt(terms[k])
  governance.proposalStake = BigInt(governance.proposalStake)
  return {
    cluster: env.FAIR_CLUSTER,
    rpc: env.FAIR_RPC,
    quotes: parse(env.FAIR_QUOTES, []),
    terms,
    governance,
  }
}

// What the browser may ask the test cluster through us. Wider than the mainnet proxy's
// list — reading a raise or a DAO is getProgramAccounts on a small program — but still a
// list: the RPC behind it may be a paid one.
const RPC_ALLOWED = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getTokenAccountBalance', 'getTokenAccountsByOwner',
  'getProgramAccounts', 'getLatestBlockhash', 'getMinimumBalanceForRentExemption', 'getSignatureStatuses',
  'sendTransaction', 'simulateTransaction', 'getSlot', 'getBlockTime', 'getEpochInfo', 'getFeeForMessage',
  'isBlockhashValid', 'getBlockHeight', 'getTokenSupply', 'getRecentPrioritizationFees', 'getGenesisHash', 'getVersion',
])
/** A page's biggest batch is a handful of calls; a transaction is 1,232 bytes. */
const RPC_MAX_CALLS = 20
const RPC_MAX_BYTES = 32 * 1024
/** Accounts read per request, all calls together: what one RPC call allows. */
const RPC_MAX_ACCOUNTS = 100
/** The faucet: three wallets a day per visitor, thirty an hour for everyone. */
const FAUCET_PER_IP_PER_DAY = 3
const FAUCET_PER_HOUR = 30

/** Only this site's pages use the proxy: a request from another origin is refused. */
const sameOrigin = (request, url) => {
  const origin = request.headers.get('origin')
  return !origin || origin === url.origin
}

/** Cached for a few seconds at the edge: the read API is polled, and every read is a scan. */
async function cached(request, ctx, build) {
  const cache = globalThis.caches?.default
  const hit = cache && await cache.match(request)
  if (hit) return hit
  const response = await build()
  if (cache && response.ok) {
    const copy = new Response(response.clone().body, response)
    copy.headers.set('cache-control', 'public, max-age=10')
    ctx?.waitUntil?.(cache.put(request, copy))
  }
  return response
}

export async function handleFair(url, request, env, { limited, ctx }) {
  const config = fairConfig(env)
  if (!config) return json({ error: 'not found' }, { status: 404 })
  const path = url.pathname
  const [{ assertCluster, PROGRAM_IDS }, { Connection }] = await Promise.all([import('./lib/fair-launch.mjs'), import('@solana/web3.js')])
  const connection = new Connection(config.rpc, 'confirmed')
  try {
    await assertCluster(connection, config.cluster)
  } catch (e) {
    console.error(`fair launches off: ${e.message}`)
    return json({ error: 'not found' }, { status: 404 })
  }

  if (path === '/api/fair/config') {
    const { rpc, ...open } = config
    return json({ ...open, rpcPath: '/api/fair/rpc', faucet: Boolean(env.FAIR_FAUCET_KEY) })
  }

  if (path === '/api/fair/rpc' && request.method === 'POST') {
    if (!sameOrigin(request, url)) return json({ error: 'forbidden' }, { status: 403 })
    if (await limited(env.RPC_LIMITER, request)) return json({ error: 'slow down' }, { status: 429 })
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (bytes.length > RPC_MAX_BYTES) return json({ error: 'too large' }, { status: 413 })
    let body = null
    try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch {}
    const calls = Array.isArray(body) ? body : [body]
    if (!body || !calls.length || calls.length > RPC_MAX_CALLS || calls.some((c) => !RPC_ALLOWED.has(c?.method))) {
      return json({ error: 'method not allowed' }, { status: 400 })
    }
    // Scanning a whole program, only over LFOwn's own fair-launch programs, which are small
    // (not Meteora's, which holds every DAMM pool there is).
    const scannable = new Set([PROGRAM_IDS.raise, PROGRAM_IDS.futarchy, PROGRAM_IDS.amm, PROGRAM_IDS.vault].map((id) => id.toBase58()))
    if (calls.some((c) => c.method === 'getProgramAccounts' && !scannable.has(c.params?.[0]))) {
      return json({ error: 'method not allowed' }, { status: 400 })
    }
    const accounts = calls.reduce((n, c) => n + (c.method === 'getMultipleAccounts' ? (Array.isArray(c.params?.[0]) ? c.params[0].length : RPC_MAX_ACCOUNTS + 1) : 0), 0)
    if (accounts > RPC_MAX_ACCOUNTS) return json({ error: 'too many accounts' }, { status: 400 })
    // What we checked is what we send: re-serialized, so a key given twice is sent once.
    const upstream = await fetch(config.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json' } })
  }

  // Read-only, for agents and anything else that would rather not decode accounts: every
  // raise, or one raise with its DAO and proposals. Opening a raise or backing one stays in
  // the page (and a wallet) until the programs are audited: an agent that moves backers'
  // money should come after that, not before.
  const one = path.match(/^\/api\/fair\/raise\/([1-9A-HJ-NP-Za-km-z]{32,44})$/)
  if (one) {
    const { PublicKey } = await import('@solana/web3.js')
    try { new PublicKey(one[1]) } catch { return json({ error: 'not a mint address' }, { status: 400 }) }
  }
  if ((path === '/api/fair/raises' || one) && request.method === 'GET') {
    if (await limited(env.HEAVY_LIMITER, request)) return json({ error: 'slow down' }, { status: 429 })
    return cached(request, ctx, () => readApi(config, connection, one?.[1]))
  }

  // Test coins for a wallet — and test SOL on localnet. Devnet's SOL comes from Solana's
  // own faucet (faucet.solana.com): its airdrops are rationed, and not ours to hand out.
  if (path === '/api/fair/faucet' && request.method === 'POST') {
    if (!env.FAIR_FAUCET_KEY) return json({ error: 'no faucet here' }, { status: 404 })
    if (!sameOrigin(request, url)) return json({ error: 'forbidden' }, { status: 403 })
    if (await limited(env.HEAVY_LIMITER, request)) return json({ error: 'slow down' }, { status: 429 })
    // Rationed: every wallet it serves costs its key the accounts' rent.
    if (await faucetSpent(env, request)) return json({ error: 'the faucet is rationed: try again later' }, { status: 429 })
    const { address } = await request.json().catch(() => ({}))
    const { faucet } = await import('./lib/fair-keeper.mjs')
    try {
      return json(await faucet(config, env.FAIR_FAUCET_KEY, address))
    } catch (e) {
      // Ours are safe to show; anything else (the RPC's, a key setting's) is logged only.
      const known = ['not a wallet address', 'this wallet already has test coins']
      if (known.includes(e.message)) return json({ error: e.message }, { status: 400 })
      console.error(`faucet failed: ${e.message}`)
      return json({ error: 'the faucet failed; try again later' }, { status: 502 })
    }
  }

  return json({ error: 'not found' }, { status: 404 })
}

/**
 * Counts one faucet use against this visitor's day and everyone's hour, and says whether
 * either was already spent. KV is not atomic: a burst can pass a few over, never many.
 */
async function faucetSpent(env, request) {
  const kv = env.REGISTRY
  if (!kv) return false
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const now = new Date()
  const keys = [
    [`fair:faucet:ip:${ip}:${now.toISOString().slice(0, 10)}`, FAUCET_PER_IP_PER_DAY, 2 * 86_400],
    [`fair:faucet:hour:${now.toISOString().slice(0, 13)}`, FAUCET_PER_HOUR, 2 * 3_600],
  ]
  const counts = await Promise.all(keys.map(([k]) => kv.get(k).then((v) => Number(v ?? 0))))
  if (counts.some((n, i) => n >= keys[i][1])) return true
  await Promise.all(keys.map(([k, , ttl], i) => kv.put(k, String(counts[i] + 1), { expirationTtl: ttl })))
  return false
}

/** The read API: every raise, or one raise with its DAO and proposals. */
async function readApi(config, connection, mint) {
  const F = await import('./lib/fair-launch.mjs')
  // `standard`: on LFOwn's terms, the only raises the site asks anyone to back.
  const withStandard = async (r) => ({ ...r, standard: await F.isStandardRaise(connection, config, r) })
  if (!mint) {
    const raises = await F.listRaises(connection)
    return json({ cluster: config.cluster, raises: await Promise.all(raises.map(withStandard)) })
  }
  const found = await F.readRaise(connection, mint)
  if (!found) return json({ error: 'no raise for that mint' }, { status: 404 })
  const raise = await withStandard(found)
  const dao = raise.state === 'succeeded' ? await F.readDao(connection, raise.baseMint, raise.quoteMint) : null
  const proposals = dao ? await F.readProposals(connection, dao, dao.proposalCount) : []
  return json({
    cluster: config.cluster,
    raise,
    dao: dao && {
      address: dao.dao.toBase58(), name: dao.name, pool: dao.pool.toBase58(), treasury: dao.treasury.toBase58(),
      activeProposal: dao.activeProposal, proposalCount: dao.proposalCount, pendingReturn: dao.pendingReturn,
      governance: { ...dao.governance, proposalStake: dao.governance.proposalStake.toString() },
    },
    proposals: proposals.map(({ actions, ...p }) => ({ ...p, actions: actions.map((list) => list.map(plainAction)) })),
  })
}
