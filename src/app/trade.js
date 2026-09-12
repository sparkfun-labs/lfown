// LFOwn — trading a coin while it is still on its bonding curve.
//
// Quotes come from the SDK's own curve maths against the live pool state, not from
// a router: before graduation the pool is not on any DEX, so nothing else can price it.

import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import {
  DynamicBondingCurveClient, SwapMode, getPriceFromSqrtPrice,
  deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'

export const connection = new Connection(`${location.origin}/api/rpc`, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')

/**
 * Live pool, its config, and everything the screen needs to draw.
 * Takes the pool address rather than the mint: finding a pool from its mint needs
 * getProgramAccounts, which the browser has no business asking an RPC to run.
 */
export async function loadPool(poolAddress) {
  const address = new PublicKey(poolAddress)
  const wrapper = await client.state.getPool(address)
  if (!wrapper?.poolState) throw new Error('no pool at this address')
  const pool = wrapper.poolState
  const config = await client.state.getPoolConfig(pool.config)

  const threshold = Number(config.migrationQuoteThreshold.toString())
  const raised = Number(pool.quoteReserve.toString())

  return {
    address,
    pool,
    config,
    quoteMint: config.quoteMint.toBase58(),
    isMigrated: Boolean(pool.isMigrated),
    raised: raised / 1e6,
    threshold: threshold / 1e6,
    progress: threshold ? Math.min(1, raised / threshold) : 0,
    price: Number(getPriceFromSqrtPrice(pool.sqrtPrice, 6, 6)),
  }
}

/** What this trade would return, priced on the curve as it stands right now. */
export async function quote({ pool, config }, { amountIn, sellingBase, slippageBps = 100 }) {
  const currentPoint = new BN(await connection.getSlot())
  const result = await client.pool.swapQuote2({
    // The quote helpers read `virtualPool.poolState`, so they want the account
    // wrapper rather than the decoded state that every other call takes.
    virtualPool: { poolState: pool },
    config,
    swapBaseForQuote: sellingBase,
    swapMode: SwapMode.PartialFill, // a buy that would overfill the curve is trimmed, not rejected
    amountIn: new BN(Math.floor(amountIn * 1e6)),
    slippageBps,
    hasReferral: false,
    currentPoint,
  })
  return {
    out: Number(result.outputAmount ?? result.amountOut ?? 0) / 1e6,
    minimumOut: Number(result.minimumAmountOut ?? 0) / 1e6,
    consumed: Number(result.actualInputAmount ?? result.amountIn ?? 0) / 1e6,
  }
}

/**
 * What the creator has earned, and what they have already taken.
 *
 * The pool keeps a lifetime total of the fee shared between creator and partner,
 * and a pending balance per side. Subtracting one from the other gives the claimed
 * amount without indexing a single transaction.
 */
export function creatorFees({ pool, config }) {
  const sharePct = Number(config.creatorTradingFeePercentage ?? 50)
  const lifetime = (Number(pool.metrics.totalTradingQuoteFee.toString()) * sharePct) / 100 / 1e6
  const pending = Number(pool.creatorQuoteFee.toString()) / 1e6
  return {
    pending,
    claimed: Math.max(0, lifetime - pending),
    lifetime,
    sharePct,
  }
}

/**
 * After graduation the creator's earnings move to a locked DAMM v2 position: a
 * different program, and fees in both tokens rather than only the quote. Reading
 * only the curve's counters would show a graduated coin earning nothing.
 */
export async function graduatedFees({ pool, config }, owner) {
  const { lpPositions } = await import('../lib/lp-fees.mjs')
  const dammPool = deriveDammV2PoolAddress(
    DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100],
    pool.baseMint,
    config.quoteMint,
  ).toBase58()

  const mine = (await lpPositions(connection, owner)).filter((p) => p.pool === dammPool)
  return mine[0] ?? null
}

export async function buildGraduatedClaim(entry, owner) {
  const { buildLpClaim } = await import('../lib/lp-fees.mjs')
  const tx = await buildLpClaim(connection, entry, { owner })
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = new PublicKey(owner)
  return tx
}

/** Builds the creator's fee claim. Only the creator can sign it. */
export async function buildCreatorClaim({ address, pool }, { creator }) {
  const owner = new PublicKey(creator)
  const tx = await client.creator.claimCreatorTradingFee({
    creator: owner,
    payer: owner,
    pool: address,
    maxBaseAmount: pool.creatorBaseFee,
    maxQuoteAmount: pool.creatorQuoteFee,
    receiver: owner,
  })
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = owner
  return tx
}

/**
 * One claim covering both phases.
 *
 * The curve's fees and the graduated position's belong to different programs and
 * different instructions, but the creator signs both and together they measure 892
 * bytes against a 1232-byte cap. Making someone approve two transactions for one
 * balance bought nothing.
 *
 * Empty legs are left out rather than claimed for zero: an instruction that moves
 * nothing still costs space and still has to be simulated.
 */
/**
 * Everything one coin owes its creator, as instructions rather than a transaction —
 * so several coins can be weighed together before any of them is committed to one.
 */
export async function claimInstructions({ address, pool }, { creator, lp }) {
  const owner = new PublicKey(creator)
  const out = []

  const onCurve = Number(pool.creatorQuoteFee.toString()) > 0 || Number(pool.creatorBaseFee.toString()) > 0
  if (onCurve) {
    const curve = await client.creator.claimCreatorTradingFee({
      creator: owner, payer: owner, pool: address,
      maxBaseAmount: pool.creatorBaseFee, maxQuoteAmount: pool.creatorQuoteFee, receiver: owner,
    })
    out.push(...curve.instructions)
  }

  if (lp && (lp.feeA || lp.feeB)) {
    const { buildLpClaim } = await import('../lib/lp-fees.mjs')
    const claim = await buildLpClaim(connection, lp, { owner: creator })
    out.push(...claim.instructions)
  }
  return out
}

export async function buildClaimAll(state, { creator, lp }) {
  const ixs = await claimInstructions(state, { creator, lp })
  if (!ixs.length) throw new Error('There is nothing to claim right now.')
  const tx = new Transaction().add(...ixs)
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = new PublicKey(creator)
  return tx
}

/**
 * Claims for several coins, packed into as few transactions as will hold them.
 *
 * By measured size, not by a count. Three curve claims fit in the 1232-byte limit
 * and a fourth does not — 526 bytes for the first, 264 for each after it — but a
 * graduated coin also claims from its locked position, which is 660 bytes on its
 * own and 892 beside a curve claim. A fixed "three per transaction" would be wrong
 * for any creator whose coins are a mixture, so each one is added only once the
 * whole thing has been serialised and found to still fit.
 *
 * An address lookup table would take the marginal cost to 47 bytes and hold around
 * twenty — measured — but it has to be created, funded and extended with every new
 * coin, and it is not worth that until creators are launching far more than this.
 */
export async function packClaims(entries, { creator }) {
  const owner = new PublicKey(creator)
  // Any blockhash serialises to the same 32 bytes; this one is only for weighing.
  // Each transaction is given a fresh one immediately before it is signed.
  const { blockhash } = await connection.getLatestBlockhash('confirmed')

  const weigh = (ixs) => {
    const tx = new Transaction().add(...ixs)
    tx.recentBlockhash = blockhash
    tx.feePayer = owner
    try {
      tx.serialize({ requireAllSignatures: false, verifySignatures: false })
      return tx
    } catch {
      return null // over the limit; web3 says so by refusing to serialise
    }
  }

  const batches = []
  for (const entry of entries) {
    const ixs = await claimInstructions(entry.state, { creator, lp: entry.lp })
    if (!ixs.length) continue

    const last = batches[batches.length - 1]
    const merged = last && weigh([...last.ixs, ...ixs])
    if (merged) {
      last.ixs.push(...ixs)
      last.coins.push(entry)
      last.transaction = merged
      continue
    }
    // On its own now. A single claim too large to serialise even alone cannot be
    // helped by splitting further, so it is kept and allowed to fail out loud.
    batches.push({ ixs, coins: [entry], transaction: weigh(ixs) ?? new Transaction().add(...ixs) })
  }
  return batches
}

/** Builds the swap for the wallet to sign. */
export async function buildSwap({ address }, { owner, amountIn, minimumOut, sellingBase }) {
  const tx = await client.pool.swap2({
    owner: new PublicKey(owner),
    payer: new PublicKey(owner),
    pool: address,
    amountIn: new BN(Math.floor(amountIn * 1e6)),
    minimumAmountOut: new BN(Math.floor((minimumOut ?? 0) * 1e6)),
    swapMode: SwapMode.PartialFill,
    swapBaseForQuote: sellingBase,
    referralTokenAccount: null,
  })
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = new PublicKey(owner)
  return tx
}
