// LFOwn — the fair-launch API, loaded only when a /api/fair/ route is asked for.
//
// Fair launches run on a test cluster until their programs are audited, so all of this is
// off unless the Worker is told which cluster to use:
//
//   FAIR_CLUSTER      localnet | devnet
//   FAIR_RPC          that cluster's RPC URL (never sent to the browser: it may hold a key)
//   FAIR_QUOTES       JSON: [{ mint, symbol, name, usdPrice }] — the coins a raise may be
//                     priced in there. Ownership coins do not exist on a test cluster, so
//                     these are stand-ins with a stand-in price.
//   FAIR_TERMS        optional JSON overriding TERMS (a local run wants a three-minute raise)
//   FAIR_GOVERNANCE   optional JSON overriding GOVERNANCE (and five-minute proposals)
//   FAIR_KEEPER_KEY   JSON secret key that cranks raises and DAOs (see lib/fair-keeper.mjs)
//   FAIR_FAUCET_KEY   JSON secret key holding the stand-in coins' mint authority; localnet only
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
  if (!env.FAIR_RPC) return null
  const terms = { ...TERMS, ...parse(env.FAIR_TERMS, {}) }
  const governance = { ...GOVERNANCE, ...parse(env.FAIR_GOVERNANCE, {}) }
  for (const k of ['tokensForInvestors', 'tokensForPool']) terms[k] = BigInt(terms[k])
  governance.proposalStake = BigInt(governance.proposalStake)
  return {
    cluster: env.FAIR_CLUSTER || 'devnet',
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

export async function handleFair(url, request, env, { limited }) {
  const config = fairConfig(env)
  if (!config) return json({ error: 'not found' }, { status: 404 })
  const path = url.pathname

  if (path === '/api/fair/config') {
    const { rpc, ...open } = config
    return json({ ...open, rpcPath: '/api/fair/rpc', faucet: Boolean(env.FAIR_FAUCET_KEY) })
  }

  if (path === '/api/fair/rpc' && request.method === 'POST') {
    if (await limited(env.RPC_LIMITER, request)) return json({ error: 'slow down' }, { status: 429 })
    const body = await request.json().catch(() => null)
    const calls = Array.isArray(body) ? body : [body]
    if (!body || !calls.length || calls.some((c) => !RPC_ALLOWED.has(c?.method))) {
      return json({ error: 'method not allowed' }, { status: 400 })
    }
    const upstream = await fetch(config.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json' } })
  }

  // Read-only, for agents and anything else that would rather not decode accounts: every
  // raise, or one raise with its DAO and proposals. Opening a raise or backing one stays in
  // the page (and a wallet) until the programs are audited: an agent that moves backers'
  // money should come after that, not before.
  if (path === '/api/fair/raises' && request.method === 'GET') {
    const F = await import('./lib/fair-launch.mjs')
    const { Connection } = await import('@solana/web3.js')
    return json({ cluster: config.cluster, raises: await F.listRaises(new Connection(config.rpc, 'confirmed')) })
  }
  const one = path.match(/^\/api\/fair\/raise\/([1-9A-HJ-NP-Za-km-z]{32,44})$/)
  if (one && request.method === 'GET') {
    const F = await import('./lib/fair-launch.mjs')
    const { Connection } = await import('@solana/web3.js')
    const connection = new Connection(config.rpc, 'confirmed')
    const raise = await F.readRaise(connection, one[1])
    if (!raise) return json({ error: 'no raise for that mint' }, { status: 404 })
    const dao = raise.state === 'succeeded' ? await F.readDao(connection, raise.baseMint, raise.quoteMint) : null
    const proposals = dao ? await F.readProposals(connection, dao, dao.proposalCount) : []
    return json({
      cluster: config.cluster,
      raise,
      dao: dao && {
        address: dao.dao.toBase58(), name: dao.name, pool: dao.pool.toBase58(), treasury: dao.treasury.toBase58(),
        activeProposal: dao.activeProposal, proposalCount: dao.proposalCount,
        governance: { ...dao.governance, proposalStake: dao.governance.proposalStake.toString() },
      },
      proposals: proposals.map(({ actions, ...p }) => ({ ...p, actions: actions.map((list) => list.map(plainAction)) })),
    })
  }

  // Test coins for a wallet — and test SOL on localnet. Devnet's SOL comes from Solana's
  // own faucet (faucet.solana.com): its airdrops are rationed, and not ours to hand out.
  if (path === '/api/fair/faucet' && request.method === 'POST') {
    if (!['localnet', 'devnet'].includes(config.cluster) || !env.FAIR_FAUCET_KEY) return json({ error: 'no faucet here' }, { status: 404 })
    if (await limited(env.HEAVY_LIMITER, request)) return json({ error: 'slow down' }, { status: 429 })
    const { address } = await request.json().catch(() => ({}))
    const { faucet } = await import('./lib/fair-keeper.mjs')
    try {
      return json(await faucet(config, env.FAIR_FAUCET_KEY, address))
    } catch (e) {
      return json({ error: e.message }, { status: 400 })
    }
  }

  return json({ error: 'not found' }, { status: 404 })
}
