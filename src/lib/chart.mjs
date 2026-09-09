// LFOwn — the price history of a coin, rebuilt from its own trades.
//
// Nothing external prices these coins. DexScreener does index the pools, both the
// curve and the graduated one, but reports no price for either: the quote side is
// an ownership coin it does not value. An embedded chart would have been blank on
// exactly the coins this site exists for. So the history is read from the pool.
//
// Every swap moves the two vaults in opposite directions — quote in, base out, or
// the reverse — and the ratio of those two movements is the price that trade
// actually paid. Migration moves both the same way, liquidity leaving the curve
// together, which is how it is told apart and left out.
//
// A coin's life has two halves and the same rule reads both. Trading moves to a
// DAMM v2 pool at graduation, so a chart that followed only the curve would stop at
// the exact moment the coin got interesting. Each half is a leg, each leg remembers
// how far it has been read, and their points are merged in time.

const HELIUS_TX = 'https://api.helius.xyz/v0/transactions'
const BATCH = 100
// Every coin launched here and every ownership coin it can be paired with is six.
const DECIMALS = 6

/** The api key lives in the RPC url and nowhere else. */
function heliusKey(rpcUrl) {
  return String(rpcUrl ?? '').match(/api-key=([^&\s"]+)/)?.[1] ?? null
}

/**
 * Signatures touching the pool, oldest first.
 * `until` is the newest signature already known, so a rebuild only ever fetches
 * what has happened since — the first build of a busy coin is the expensive one
 * and it happens once.
 */
async function newSignatures(connection, PublicKey, pool, until, cap) {
  const out = []
  let before
  while (out.length < cap) {
    const page = await connection.getSignaturesForAddress(new PublicKey(pool), { limit: 1000, before, until })
    if (!page.length) break
    out.push(...page.filter((s) => !s.err))
    if (page.length < 1000) break
    before = page[page.length - 1].signature
  }
  return out.reverse()
}

/**
 * Prices every trade in a batch of parsed transactions.
 * Helius reports balance changes per account, which is what makes this a handful of
 * requests rather than one per transaction.
 */
function pricePoints(parsed, { kind, baseMint, baseVault, quoteVault, baseDecimals, quoteDecimals }) {
  const points = []
  for (const tx of parsed) {
    const accounts = tx.accountData ?? []
    const delta = (vault, decimals) => {
      const change = accounts.find((a) => a.account === vault)?.tokenBalanceChanges?.[0]
      if (!change) return 0
      return Number(change.rawTokenAmount?.tokenAmount ?? 0) / 10 ** (change.rawTokenAmount?.decimals ?? decimals)
    }
    const quote = delta(quoteVault, quoteDecimals)
    const base = delta(baseVault, baseDecimals)

    if (!quote || !base) continue

    // A launch with a dev buy opens the pool and trades in the same transaction:
    // the base vault takes in the whole supply at the very moment part of it leaves
    // again, so both vaults rise and netting them hides the trade entirely. What the
    // buyer actually received is on the buyer's own account, not the vault's.
    if (kind === 'curve' && quote > 0 && base > 0) {
      const received = accounts
        .filter((a) => a.account !== baseVault)
        .flatMap((a) => a.tokenBalanceChanges ?? [])
        .filter((c) => c.mint === baseMint)
        .reduce((max, c) => {
          const v = Number(c.rawTokenAmount?.tokenAmount ?? 0) / 10 ** (c.rawTokenAmount?.decimals ?? baseDecimals)
          return v > max ? v : max
        }, 0)
      if (!received) continue
      points.push({ t: tx.timestamp, price: quote / received, quote, base: received, buy: true, sig: tx.signature })
      continue
    }

    // Opposite signs means one side really was traded for the other. Both moving the
    // same way is liquidity, not a trade: the migration draining the curve, or the
    // same migration filling the DAMM pool it drained into.
    if (quote * base > 0) continue

    points.push({
      t: tx.timestamp,
      price: Math.abs(quote) / Math.abs(base),
      quote: Math.abs(quote),
      base: Math.abs(base),
      buy: quote > 0,
      sig: tx.signature,
    })
  }
  return points
}

/**
 * Every trade on a pool, oldest first, priced in the quote token.
 *
 * Returns `newest` so the caller can store it and ask only for what came after.
 */
export async function tradeHistory(connection, PublicKey, rpcUrl, pool, { until = null, cap = 3000 } = {}) {
  const key = heliusKey(rpcUrl)
  if (!key) throw new Error('the chart needs the Helius parsed-transaction api')

  const signatures = await newSignatures(connection, PublicKey, pool.pool, until, cap)
  if (!signatures.length) return { points: [], newest: until }

  const points = []
  for (let i = 0; i < signatures.length; i += BATCH) {
    const slice = signatures.slice(i, i + BATCH).map((s) => s.signature)
    const res = await fetch(`${HELIUS_TX}?api-key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactions: slice }),
    })
    if (!res.ok) throw new Error(`parsed transactions returned ${res.status}`)
    const parsed = await res.json()
    if (!Array.isArray(parsed)) throw new Error('parsed transactions returned no list')
    points.push(...pricePoints(parsed, pool))
  }

  points.sort((a, b) => a.t - b.t)
  return { points, newest: signatures[signatures.length - 1].signature }
}

/**
 * The graduated half of a coin's life, or null while it is still on its curve.
 *
 * DAMM v2 orders its two tokens by mint rather than by role, so which vault holds
 * the quote has to be read off the pool instead of assumed.
 */
export async function ammLeg(connection, PublicKey, baseMint, quoteMint) {
  const [{ CpAmm }, dbc] = await Promise.all([
    import('@meteora-ag/cp-amm-sdk'),
    import('@meteora-ag/dynamic-bonding-curve-sdk'),
  ])
  const address = dbc.deriveDammV2PoolAddress(
    dbc.DAMM_V2_MIGRATION_FEE_ADDRESS[dbc.MigrationFeeOption.FixedBps100],
    new PublicKey(baseMint),
    new PublicKey(quoteMint),
  )
  if (!(await connection.getAccountInfo(address))) return null // not graduated yet

  const state = await new CpAmm(connection).fetchPoolState(address)
  const baseIsA = state.tokenAMint.toBase58() === baseMint
  return {
    kind: 'amm',
    pool: address.toBase58(),
    baseMint,
    quoteMint,
    baseVault: (baseIsA ? state.tokenAVault : state.tokenBVault).toBase58(),
    quoteVault: (baseIsA ? state.tokenBVault : state.tokenAVault).toBase58(),
    baseDecimals: DECIMALS,
    quoteDecimals: DECIMALS,
    newest: null,
  }
}
