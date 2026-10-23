// LFOwn — everything every coin has ever earned, and for whom.
//
// Nothing is indexed: a bonding curve records its lifetime fees, and a DAMM v2
// position records what it has claimed. Add the unclaimed remainder and the full
// history falls out of a few account reads per coin — made in batches, every pool,
// config and vault at once, because one read per account was 400 calls a report
// (Helius, Oct 2026: 92% of all traffic, at a report every few minutes).

import { PublicKey } from '@solana/web3.js'
import {
  deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk'
import { FEES, tokenUnit } from './config.mjs'
import { vaultSplit } from './fee-split.mjs'

/** Raw units of `mint` in whole tokens. */
const whole = (x, mint) => Number(x?.toString() ?? 0) / tokenUnit(mint)

/**
 * Per coin: what the curve earned, what the graduated pool has earned since, and
 * how each splits between the creator, LFOwn and Meteora.
 */
export async function feeReport(client, connection, launches, { prices = new Map(), holderPot = FEES.holderPot } = {}) {
  const cp = new CpAmm(connection)
  const rows = []
  // Loaded only when some coin shares its fees: every other report never needs it.
  const dfs = launches.some((l) => l.vault)
    ? new (await import('@meteora-ag/dynamic-fee-sharing-sdk')).DynamicFeeSharingClient(connection, 'confirmed')
    : null

  // Every account the loop needs, read up front in batches of 99. A pool or vault
  // that cannot be read is missing from its map and handled where it is used.
  const program = client.state.program ?? client.program
  const fetchAll = async (account, addresses) => {
    const unique = [...new Set(addresses)]
    const found = new Map()
    for (let i = 0; i < unique.length; i += 99) {
      const slice = unique.slice(i, i + 99)
      const decoded = await account.fetchMultiple(slice.map((a) => new PublicKey(a)))
      decoded.forEach((d, j) => { if (d) found.set(slice[j], d) })
    }
    return found
  }
  const pools = await fetchAll(program.account.virtualPool, launches.map((l) => l.pool))
  const configs = await fetchAll(program.account.poolConfig, [...pools.values()].map((p) => p.poolState.config.toBase58()))
  const vaults = dfs ? await fetchAll(dfs.program.account.feeVault, launches.filter((l) => l.vault).map((l) => l.vault)) : new Map()

  for (const l of launches) {
    const pool = pools.get(l.pool)
    if (!pool) { console.error(`fee report: pool ${l.pool} for ${l.symbol ?? l.baseMint} unreadable, left out`); continue }
    const { poolState } = pool
    const config = configs.get(poolState.config.toBase58()) ?? {}
    const creatorPct = Number(config.creatorTradingFeePercentage ?? 50)
    const price = prices.get(l.quoteMint) ?? l.quoteUsdPrice ?? 0
    const lamports = (x) => whole(x, l.quoteMint)

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
        DAMM_V2_MIGRATION_FEE_ADDRESS[Number(config.migrationFeeOption ?? MigrationFeeOption.FixedBps100)],
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
          graduated.inCoin += whole(quoteIsB ? unclaimed.feeTokenA : unclaimed.feeTokenB, l.baseMint)
          // The two positions are equal halves: one LFOwn's, one the creator's.
          graduated.partner += earnedQuote / 2
          graduated.creator += earnedQuote / 2
        }
      } catch { /* a pool we cannot read leaves the curve figures intact */ }
    }

    // A creator who shares fees handed their whole half to a vault, which splits it by
    // share. Every figure above is that half undivided — on the curve and in the
    // position alike — so it is split here, once, and every page reads the result.
    // Left whole if the vault cannot be read: overstating one creator is better than
    // a report that fails to build for everyone.
    //
    // Only the pot's slot is the holders' (see `vaultSplit`). Any other shareholder was
    // put there by whoever opened the vault, and the site cannot say who they are, so
    // their part stays on the creator's side of the ledger and the coin is marked as a
    // split of the creator's own choosing rather than a gift to holders.
    const creatorSide = curve.creator + graduated.creator
    let creatorOwn = creatorSide
    let holders = 0
    let customSplit = false
    if (l.vault && dfs) {
      try {
        const vault = vaults.get(l.vault)
        if (!vault) throw new Error('not found')
        const split = vaultSplit(vault.users, vault.totalShare, { creator: l.feeWallet ?? l.creator, pot: holderPot })
        if (split.total) {
          holders = (creatorSide * split.holders) / split.total
          creatorOwn = creatorSide - holders
          customSplit = split.others > 0
        }
      } catch (e) {
        console.error(`fee report: vault ${l.vault} for ${l.symbol ?? l.baseMint} unreadable, creator figure left unsplit: ${e.message}`)
      }
    }

    // Meteora's cut is left out on purpose. It is taken off the top and never reaches
    // anyone here, so counting it made "generated" a number that matched neither of
    // the shares underneath it. What is left adds up exactly: creator + holders + LFOwn.
    // `meteora` below still carries it, for anyone reconciling against the pool.
    const total = curve.creator + curve.partner + graduated.creator + graduated.partner
    rows.push({
      symbol: l.symbol ?? '?',
      baseMint: l.baseMint,
      // The wallet paid the creator's share: the one that opened the pool, unless it
      // named another at launch. Spelled out rather than `creator`, which is already
      // taken below by the creator's *share* — one word, two meanings, and the
      // leaderboard groups by this one. `launcher` keeps who actually launched it.
      creatorWallet: l.feeWallet ?? l.creator,
      launcher: l.creator,
      quoteSymbol: l.quoteSymbol,
      quoteUsdPrice: price,
      graduated: Boolean(poolState.isMigrated),
      curve,
      graduatedFees: graduated,
      total,
      totalUsd: total * price,
      lfown: curve.partner + graduated.partner,
      lfownUsd: (curve.partner + graduated.partner) * price,
      // The creator's own share. For a coin that shares, the rest of their half is
      // `holders`; for every other coin that is zero and this is the whole half.
      creator: creatorOwn,
      holders,
      holdersUsd: holders * price,
      customSplit,
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
      holdersUsd: rows.reduce((t, r) => t + r.holdersUsd, 0),
      meteoraUsd: rows.reduce((t, r) => t + r.meteora * r.quoteUsdPrice, 0),
    },
  }
}
