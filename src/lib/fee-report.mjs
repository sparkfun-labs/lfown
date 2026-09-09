// LFOwn — everything every coin has ever earned, and for whom.
//
// Nothing is indexed: a bonding curve records its lifetime fees, and a DAMM v2
// position records what it has claimed. Add the unclaimed remainder and the full
// history falls out of two account reads per coin.

import { PublicKey } from '@solana/web3.js'
import {
  deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk'

const lamports = (x) => Number(x?.toString() ?? 0) / 1e6

/**
 * Per coin: what the curve earned, what the graduated pool has earned since, and
 * how each splits between the creator, LFOwn and Meteora.
 */
export async function feeReport(client, connection, launches, { prices = new Map() } = {}) {
  const cp = new CpAmm(connection)
  const rows = []

  for (const l of launches) {
    const { poolState } = await client.state.getPool(new PublicKey(l.pool))
    const config = await client.state.getPoolConfig(poolState.config)
    const creatorPct = Number(config.creatorTradingFeePercentage ?? 50)
    const price = prices.get(l.quoteMint) ?? l.quoteUsdPrice ?? 0

    // On the curve every fee is quote-side, split creator/partner after Meteora's cut.
    const shared = lamports(poolState.metrics.totalTradingQuoteFee)
    const curve = {
      protocol: lamports(poolState.metrics.totalProtocolQuoteFee),
      creator: (shared * creatorPct) / 100,
      partner: (shared * (100 - creatorPct)) / 100,
      creatorPending: lamports(poolState.creatorQuoteFee),
      partnerPending: lamports(poolState.partnerQuoteFee),
    }

    // After graduation the two locked positions earn in both tokens.
    const graduated = { creator: 0, partner: 0, pending: 0, inCoin: 0 }
    if (poolState.isMigrated) {
      const dammPool = deriveDammV2PoolAddress(
        DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100],
        new PublicKey(l.baseMint),
        new PublicKey(l.quoteMint),
      )
      try {
        const pool = await cp.fetchPoolState(dammPool)
        const quoteIsB = pool.tokenBMint.toBase58() === l.quoteMint
        for (const p of await cp.getAllPositionsByPool(dammPool)) {
          const s = p.positionState ?? p.account
          const unclaimed = getUnClaimLpFee(pool, s)
          const earnedQuote = lamports(quoteIsB ? s.metrics.totalClaimedBFee : s.metrics.totalClaimedAFee)
            + lamports(quoteIsB ? unclaimed.feeTokenB : unclaimed.feeTokenA)
          graduated.pending += lamports(quoteIsB ? unclaimed.feeTokenB : unclaimed.feeTokenA)
          graduated.inCoin += lamports(quoteIsB ? unclaimed.feeTokenA : unclaimed.feeTokenB)
          // The two positions are equal halves: one LFOwn's, one the creator's.
          graduated.partner += earnedQuote / 2
          graduated.creator += earnedQuote / 2
        }
      } catch { /* a pool we cannot read leaves the curve figures intact */ }
    }

    // Meteora's cut is left out on purpose. It is taken off the top and never reaches
    // anyone here, so counting it made "generated" a number that matched neither of
    // the two shares underneath it. What is left adds up exactly: creator + LFOwn.
    // `meteora` below still carries it, for anyone reconciling against the pool.
    const total = curve.creator + curve.partner + graduated.creator + graduated.partner
    rows.push({
      symbol: l.symbol ?? '?',
      baseMint: l.baseMint,
      quoteSymbol: l.quoteSymbol,
      quoteUsdPrice: price,
      graduated: Boolean(poolState.isMigrated),
      curve,
      graduatedFees: graduated,
      total,
      totalUsd: total * price,
      lfown: curve.partner + graduated.partner,
      lfownUsd: (curve.partner + graduated.partner) * price,
      creator: curve.creator + graduated.creator,
      meteora: curve.protocol,
    })
  }

  rows.sort((a, b) => b.totalUsd - a.totalUsd)
  return {
    updatedAt: new Date().toISOString(),
    coins: rows,
    totals: {
      generatedUsd: rows.reduce((t, r) => t + r.totalUsd, 0),
      lfownUsd: rows.reduce((t, r) => t + r.lfownUsd, 0),
      creatorUsd: rows.reduce((t, r) => t + r.creator * r.quoteUsdPrice, 0),
      meteoraUsd: rows.reduce((t, r) => t + r.meteora * r.quoteUsdPrice, 0),
    },
  }
}
