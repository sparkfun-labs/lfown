// LFOwn — graduating a filled curve into its DAMM v2 pool.
//
// Nobody is obliged to do this: the migration instruction takes a payer and two
// throwaway position-NFT keypairs, and no authority at all. So a curve that fills
// stays filled until someone cranks it — a launch frozen at 100% with its liquidity
// stuck in the bonding curve. That is what the keeper is for.

import { PublicKey } from '@solana/web3.js'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { sendAndConfirm } from './confirm.mjs'

/** The DAMM v2 config a pool on this DBC config migrates into, from its migrationFeeOption. */
export const dammConfigOf = (config) =>
  DAMM_V2_MIGRATION_FEE_ADDRESS[Number(config?.migrationFeeOption ?? MigrationFeeOption.FixedBps100)]

/**
 * Pools whose curve is full and which have not migrated yet.
 *
 * Every pool and every config is read in batches of 99. It used to be three reads per
 * pool — the pool, then the pool again and its config for the threshold — one after
 * another, every ten minutes: about 450 calls a run once there were 150 curves, most of
 * Helius's traffic for a check that almost always finds nothing.
 */
export async function readyToGraduate(client, launches) {
  const program = client.state.program ?? client.program
  const live = launches.filter((p) => !p.isMigrated)
  const batched = async (account, keys) => {
    const found = new Map()
    const unique = [...new Set(keys)]
    for (let i = 0; i < unique.length; i += 99) {
      const slice = unique.slice(i, i + 99)
      try {
        const decoded = await account.fetchMultiple(slice.map((k) => new PublicKey(k)))
        decoded.forEach((d, j) => { if (d) found.set(slice[j], d) })
      } catch (e) {
        // One failed batch should not stop the sweep — but swallowing the reason makes
        // "nothing is ready" and "the check is broken" the same silent answer.
        console.error(`readyToGraduate: ${slice.length} accounts could not be read: ${e.message}`)
      }
    }
    return found
  }
  const pools = await batched(program.account.virtualPool, live.map((p) => p.pool))
  const configs = await batched(program.account.poolConfig, [...pools.values()].map((v) => v.poolState.config.toBase58()))

  const ready = []
  for (const p of live) {
    const poolState = pools.get(p.pool)?.poolState
    const config = poolState && configs.get(poolState.config.toBase58())
    if (!config) { if (poolState) console.error(`readyToGraduate: config of ${p.symbol ?? p.pool} unreadable`); continue }
    if (poolState.isMigrated || poolState.quoteReserve.lt(config.migrationQuoteThreshold)) continue
    ready.push({ ...p, poolState })
  }
  return ready
}

/**
 * Migrates one pool. The two position NFTs are minted by this transaction, so
 * their keypairs are generated here and signed alongside the payer.
 */
export async function graduate(client, connection, pool, payer) {
  // The DAMM v2 config must match the migrationFeeOption the pool's config was opened
  // with: FixedBps100 for the first configs, Customizable for those charging a transfer
  // fee, which require it.
  const { poolState } = await client.state.getPool(new PublicKey(pool))
  const config = await client.state.getPoolConfig(poolState.config)
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } =
    await client.migration.migrateToDammV2({
      pool: new PublicKey(pool),
      payer: payer.publicKey,
      dammConfig: dammConfigOf(config),
    })

  transaction.feePayer = payer.publicKey
  // Sent and polled rather than sendAndConfirmTransaction — see confirm.mjs.
  return sendAndConfirm(connection, transaction, [payer, firstPositionNftKeypair, secondPositionNftKeypair].filter(Boolean))
}
