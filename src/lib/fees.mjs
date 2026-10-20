// LFOwn — sweeping the DAO's share of trading fees.
//
// Shared by the daily cron and `scripts/claim-fees.mjs` so both agree on which
// pools to visit and what counts as claimable.

import { PublicKey } from '@solana/web3.js'
import { tokenUnit } from './config.mjs'

/**
 * Pools holding partner fees worth collecting, with the amounts. Every pool is read in
 * batches of 99: one read a pool, one after another, was 156 Helius calls an hour for
 * a sweep that usually finds nothing over the minimum.
 */
export async function pendingPartnerFees(client, pools, { minimum = 0 } = {}) {
  const program = client.state.program ?? client.program
  const out = []
  for (let i = 0; i < pools.length; i += 99) {
    const slice = pools.slice(i, i + 99)
    const states = await program.account.virtualPool.fetchMultiple(slice.map((p) => new PublicKey(p.pool)))
    states.forEach((state, j) => {
      if (!state) return
      const p = slice[j]
      const { poolState } = state
      const quote = Number(poolState.partnerQuoteFee.toString()) / tokenUnit(p.quoteMint)
      const usd = quote * (p.quoteUsdPrice ?? 0)
      if (usd < minimum) return
      out.push({ ...p, poolState, quote, usd })
    })
  }
  return out
}
