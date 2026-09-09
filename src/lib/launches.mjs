// LFOwn — the coins launched on our configs.
//
// The list is read from chain rather than recorded by the browser: a launch that
// confirmed but whose callback never fired still has to appear, and a pool opened
// directly against one of our configs is just as real as one opened through the UI.

const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

/** Metaplex metadata PDA: ["metadata", program, mint]. */
function metadataPda(mint, PublicKey) {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('metadata'), new PublicKey(METAPLEX).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(METAPLEX)
  )[0]
}

/** name, symbol and uri are borsh strings starting after key + authority + mint. */
function decodeMetadata(bytes) {
  let o = 1 + 32 + 32
  const str = () => {
    const len = new DataView(bytes.buffer, bytes.byteOffset + o, 4).getUint32(0, true)
    o += 4
    const value = new TextDecoder().decode(bytes.subarray(o, o + len)).replace(/\0+$/, '')
    o += len
    return value
  }
  return { name: str(), symbol: str(), uri: str() }
}

/**
 * One launch, resolved straight from chain.
 *
 * The catalogue is a cache and a fresh launch is not in it yet; a coin's own page
 * must not depend on that. Everything here is read from the pool and its metadata.
 */
export async function describeLaunch(client, connection, PublicKey, baseMint, coins) {
  const wrapper = await client.state.getPoolByBaseMint(new PublicKey(baseMint))
  if (!wrapper) return null
  const pool = wrapper.account.poolState
  const config = await client.state.getPoolConfig(pool.config)
  const quoteMint = config.quoteMint.toBase58()
  const quote = coins.find((c) => c.mint === quoteMint)

  const launch = {
    pool: wrapper.publicKey.toBase58(),
    config: pool.config.toBase58(),
    baseMint,
    creator: pool.creator.toBase58(),
    quoteMint,
    quoteSymbol: quote?.symbol ?? '?',
    quoteUsdPrice: quote?.usdPrice ?? 0,
    baseReserve: pool.baseReserve.toString(),
    quoteReserve: pool.quoteReserve.toString(),
    isMigrated: Boolean(pool.isMigrated),
    activationPoint: Number(pool.activationPoint?.toString() ?? 0),
  }

  const account = await connection.getAccountInfo(metadataPda(baseMint, PublicKey))
  if (account) {
    try { Object.assign(launch, decodeMetadata(new Uint8Array(account.data))) } catch {}
  }
  return launch
}

/**
 * The list's view of one pool, from its decoded state and the config it opened on.
 * One shape for the full listing and for a coin added on its own, so the two cannot
 * drift apart.
 */
export function poolEntry(publicKey, poolState, { config, tier, mint: quoteMint, symbol, usdPrice, threshold }) {
  return {
    pool: typeof publicKey === 'string' ? publicKey : publicKey.toBase58(),
    config,
    tier,
    baseMint: poolState.baseMint.toBase58(),
    creator: poolState.creator.toBase58(),
    quoteMint,
    quoteSymbol: symbol,
    quoteUsdPrice: usdPrice,
    // Carried from the config KV entry: without it the list cannot draw a
    // progress bar, and every coin looked as if nothing had been raised.
    threshold,
    baseReserve: poolState.baseReserve.toString(),
    quoteReserve: poolState.quoteReserve.toString(),
    isMigrated: Boolean(poolState.isMigrated),
    activationPoint: Number(poolState.activationPoint?.toString() ?? 0),
  }
}

/**
 * One entry with its token's metadata, for a pool read outside the full listing —
 * a coin launched a minute ago, being added to the list without rebuilding it.
 */
export async function launchEntry(connection, PublicKey, publicKey, poolState, cfg) {
  const entry = poolEntry(publicKey, poolState, cfg)
  const account = await connection.getAccountInfo(metadataPda(entry.baseMint, PublicKey))
  if (account) {
    try { Object.assign(entry, decodeMetadata(new Uint8Array(account.data))) } catch {}
  }
  return entry
}

/**
 * Every pool opened on the given configs, newest first.
 * `client` is a DynamicBondingCurveClient; PublicKey is passed in so this module
 * stays usable from both the Worker bundle and Node scripts.
 */
export async function listLaunches(client, connection, PublicKey, configs) {
  const pools = []
  for (const cfg of configs) {
    let found = []
    try {
      found = await client.state.getPoolsByConfig(new PublicKey(cfg.config))
    } catch (e) {
      // One bad config should not empty the whole list — but swallowing the reason
      // turns "no launches" and "the lookup broke" into the same silent answer.
      console.error(`listLaunches: config ${cfg.config} (${cfg.symbol}) failed: ${e.message}`)
      continue
    }
    for (const p of found) pools.push(poolEntry(p.publicKey, p.account.poolState, cfg))
  }

  // One batched read for every token's on-chain name, symbol and image.
  const pdas = pools.map((p) => metadataPda(p.baseMint, PublicKey))
  for (let i = 0; i < pdas.length; i += 100) {
    const slice = pdas.slice(i, i + 100)
    const accounts = await connection.getMultipleAccountsInfo(slice)
    accounts.forEach((account, j) => {
      const target = pools[i + j]
      if (!account) return
      try {
        Object.assign(target, decodeMetadata(new Uint8Array(account.data)))
      } catch { /* a token without readable metadata still trades */ }
    })
  }

  pools.sort((a, b) => b.activationPoint - a.activationPoint)
  return pools
}
