// LFOwn — the coins launched on our configs.
//
// The list is read from chain rather than recorded by the browser: a launch that
// confirmed but whose callback never fired still has to appear, and a pool opened
// directly against one of our configs is just as real as one opened through the UI.

import { FEES } from './config.mjs'
import { feeWalletOf } from './fee-wallet.mjs'

const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
const FEE_SHARING = 'dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh'
/** Anchor's account discriminator for `FeeVault`, read from the program's IDL. */
const FEE_VAULT_DISCRIMINATOR = [192, 178, 69, 232, 58, 149, 157, 132]

/**
 * Who actually launched each coin.
 *
 * A creator who shares fees with holders hands the pool to a fee vault at launch, so
 * from then on the pool's `creator` is that vault — and the leaderboard, the profile
 * page, the creator pages and the coin page's claim button all go by this field. The
 * vault remembers who opened it: `owner` is its first field, written from the
 * launching wallet, and it is there even when a creator gave holders everything and
 * holds no share of their own, which is the case the shareholder list cannot answer.
 *
 * Checked by program and discriminator, not by guessing from the address: anything
 * else the fee-sharing program owns is left exactly as it was.
 *
 * The launcher is not always who earns. A launch can write another wallet into the
 * creator's slot (see src/lib/fee-wallet.mjs); that wallet is `feeWallet`, and every
 * page that pays or credits the creator's part goes by it. `creator` stays the person
 * who launched the coin.
 */
export async function resolveVaultCreators(connection, PublicKey, entries) {
  for (let i = 0; i < entries.length; i += 100) {
    const slice = entries.slice(i, i + 100)
    const infos = await connection.getMultipleAccountsInfo(slice.map((e) => new PublicKey(e.creator)))
    infos.forEach((info, j) => {
      if (!info || info.owner.toBase58() !== FEE_SHARING || info.data.length < 40) return
      if (!FEE_VAULT_DISCRIMINATOR.every((b, k) => info.data[k] === b)) return
      slice[j].vault = slice[j].creator
      slice[j].creator = new PublicKey(info.data.subarray(8, 40)).toBase58()
      const feeWallet = feeWalletOf(info.data, { pot: FEES.holderPot })
      if (feeWallet) slice[j].feeWallet = feeWallet
    })
  }
  return entries
}

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
 * The same three fields from a Token-2022 mint's TokenMetadata extension. A coin minted
 * as Token-2022 (every config with a transfer fee) keeps its metadata in the mint itself
 * and has no Metaplex account. The extensions follow the 165-byte base and a one-byte
 * account type, as type (u16) · length (u16) · value; TokenMetadata is type 19, and its
 * value is update authority (32) · mint (32) · name · symbol · uri, borsh strings.
 */
export function decodeTokenMetadata(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let o = 166; o + 4 <= bytes.length;) {
    const type = view.getUint16(o, true)
    const length = view.getUint16(o + 2, true)
    // decodeMetadata skips Metaplex's one-byte key before the two 32-byte keys; the
    // extension has no key, so its slice starts one byte early.
    if (type === 19) return decodeMetadata(bytes.subarray(o + 4 - 1, o + 4 + length))
    if (type === 0 && length === 0) break
    o += 4 + length
  }
  return null
}

/**
 * Each entry's on-chain name, symbol and uri, in batches: the Metaplex account first, and
 * for the coins that have none, the Token-2022 mint itself. A coin whose metadata cannot
 * be read keeps trading under whatever the entry already says.
 */
async function readMetadata(connection, PublicKey, entries) {
  const batched = async (keys, apply) => {
    for (let i = 0; i < keys.length; i += 100) {
      const accounts = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100))
      accounts.forEach((account, j) => { if (account) try { apply(i + j, new Uint8Array(account.data)) } catch { /* unreadable: left as it is */ } })
    }
  }
  await batched(entries.map((e) => metadataPda(e.baseMint, PublicKey)), (n, bytes) => Object.assign(entries[n], decodeMetadata(bytes)))
  const missing = entries.filter((e) => !e.name && !e.symbol)
  await batched(missing.map((e) => new PublicKey(e.baseMint)), (n, bytes) => {
    const found = decodeTokenMetadata(bytes)
    if (found) Object.assign(missing[n], found)
  })
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

  // A coin page credited to a vault address would offer its creator no claim button.
  await resolveVaultCreators(connection, PublicKey, [launch]).catch((e) => {
    console.error(`describeLaunch: vault creator for ${baseMint} unresolved: ${e.message}`)
  })

  await readMetadata(connection, PublicKey, [launch])
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
  await resolveVaultCreators(connection, PublicKey, [entry]).catch((e) => {
    console.error(`launchEntry: vault creator for ${entry.baseMint} unresolved: ${e.message}`)
  })
  await readMetadata(connection, PublicKey, [entry])
  return entry
}

/**
 * The list brought up to date without looking for new pools: every known pool's reserves
 * and graduation re-read in batches of 99, and each pair's price taken from `prices`.
 * Finding new pools (listLaunches: one getProgramAccounts per config) runs far less
 * often — a coin launched from these pages is added the moment it confirms anyway.
 */
export async function refreshLaunches(client, PublicKey, launches, prices = new Map()) {
  const program = client.state.program ?? client.program
  for (let i = 0; i < launches.length; i += 99) {
    const slice = launches.slice(i, i + 99)
    const pools = await program.account.virtualPool.fetchMultiple(slice.map((l) => new PublicKey(l.pool)))
    pools.forEach((pool, j) => {
      if (!pool) return
      const { poolState } = pool
      Object.assign(slice[j], {
        baseReserve: poolState.baseReserve.toString(),
        quoteReserve: poolState.quoteReserve.toString(),
        isMigrated: Boolean(poolState.isMigrated),
      })
    })
  }
  for (const l of launches) if (prices.get(l.quoteMint) > 0) l.quoteUsdPrice = prices.get(l.quoteMint)
  return launches
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

  // One more batched read, so a shared coin is credited to the person who launched it.
  // Failing it costs attribution, not the list: every coin still appears.
  await resolveVaultCreators(connection, PublicKey, pools).catch((e) => {
    console.error(`listLaunches: vault creators unresolved: ${e.message}`)
  })

  // Batched reads for every token's on-chain name, symbol and image.
  await readMetadata(connection, PublicKey, pools)

  pools.sort((a, b) => b.activationPoint - a.activationPoint)
  return pools
}
