// LFOwn — graduating a filled curve into its DAMM v2 pool.
//
// Nobody is obliged to do this: the migration instruction takes a payer and two
// throwaway position-NFT keypairs, and no authority at all. So a curve that fills
// stays filled until someone cranks it — a launch frozen at 100% with its liquidity
// stuck in the bonding curve. That is what the keeper is for.

import { PublicKey } from '@solana/web3.js'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { sendAndConfirm } from './confirm.mjs'

/** Pools whose curve is full and which have not migrated yet. */
export async function readyToGraduate(client, launches) {
  const ready = []
  for (const p of launches) {
    if (p.isMigrated) continue
    try {
      const { poolState } = await client.state.getPool(new PublicKey(p.pool))
      if (poolState.isMigrated) continue
      const threshold = await client.state.getPoolMigrationQuoteThreshold(new PublicKey(p.pool))
      if (poolState.quoteReserve.lt(threshold)) continue
      ready.push({ ...p, poolState })
    } catch (e) {
      // One unreadable pool should not stop the sweep — but swallowing the reason
      // makes "nothing is ready" and "the check is broken" the same silent answer.
      console.error(`readyToGraduate: ${p.symbol ?? p.pool} could not be read: ${e.message}`)
    }
  }
  return ready
}

/**
 * Migrates one pool. The two position NFTs are minted by this transaction, so
 * their keypairs are generated here and signed alongside the payer.
 */
export async function graduate(client, connection, pool, payer) {
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } =
    await client.migration.migrateToDammV2({
      pool: new PublicKey(pool),
      payer: payer.publicKey,
      // Must match the migrationFeeOption the config was opened with.
      dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100],
    })

  transaction.feePayer = payer.publicKey
  // Sent and polled rather than sendAndConfirmTransaction — see confirm.mjs.
  return sendAndConfirm(connection, transaction, [payer, firstPositionNftKeypair, secondPositionNftKeypair].filter(Boolean))
}
