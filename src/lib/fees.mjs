// LFOwn — sweeping the DAO's share of trading fees.
//
// Shared by the daily cron and `scripts/claim-fees.mjs` so both agree on which
// pools to visit and what counts as claimable.

import { PublicKey } from '@solana/web3.js'

/** Pools holding partner fees worth collecting, with the amounts. */
export async function pendingPartnerFees(client, pools, { minimum = 0 } = {}) {
  const out = []
  for (const p of pools) {
    const { poolState } = await client.state.getPool(new PublicKey(p.pool))
    const quote = Number(poolState.partnerQuoteFee.toString()) / 1e6
    const usd = quote * (p.quoteUsdPrice ?? 0)
    if (usd < minimum) continue
    out.push({ ...p, poolState, quote, usd })
  }
  return out
}
