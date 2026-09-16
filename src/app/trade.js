// LFOwn — trading a coin while it is still on its bonding curve.
//
// Quotes come from the SDK's own curve maths against the live pool state, not from
// a router: before graduation the pool is not on any DEX, so nothing else can price it.

import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import { rpcFetch } from './rpc.js'
import {
  DynamicBondingCurveClient, SwapMode, getPriceFromSqrtPrice,
  deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import { COIN_DECIMALS, tokenDecimals, tokenUnit } from '../lib/config.mjs'

// Every call goes through rpc.js, which sends them in batches and retries the ones the
// rate limiter refuses — see the note at the top of that file for why.
export const connection = new Connection(`${location.origin}/api/rpc`, { commitment: 'confirmed', fetch: rpcFetch })
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
  // The coin is always 6 decimals; the coin it is paired with need not be.
  const quoteMint = config.quoteMint.toBase58()
  const quoteDecimals = tokenDecimals(quoteMint)

  return {
    address,
    pool,
    config,
    quoteMint,
    quoteDecimals,
    isMigrated: Boolean(pool.isMigrated),
    raised: raised / 10 ** quoteDecimals,
    threshold: threshold / 10 ** quoteDecimals,
    progress: threshold ? Math.min(1, raised / threshold) : 0,
    price: Number(getPriceFromSqrtPrice(pool.sqrtPrice, COIN_DECIMALS, quoteDecimals)),
  }
}

/** What this trade would return, priced on the curve as it stands right now. */
export async function quote({ pool, config }, { amountIn, sellingBase, slippageBps = 100 }) {
  const currentPoint = new BN(await connection.getSlot())
  const { inUnit, outUnit } = units(config.quoteMint, sellingBase)
  const result = await client.pool.swapQuote2({
    // The quote helpers read `virtualPool.poolState`, so they want the account
    // wrapper rather than the decoded state that every other call takes.
    virtualPool: { poolState: pool },
    config,
    swapBaseForQuote: sellingBase,
    swapMode: SwapMode.PartialFill, // a buy that would overfill the curve is trimmed, not rejected
    amountIn: new BN(Math.floor(amountIn * inUnit)),
    slippageBps,
    hasReferral: false,
    currentPoint,
  })
  return {
    out: Number(result.outputAmount ?? result.amountOut ?? 0) / outUnit,
    minimumOut: Number(result.minimumAmountOut ?? 0) / outUnit,
    consumed: Number(result.actualInputAmount ?? result.amountIn ?? 0) / inUnit,
  }
}

/** Raw units per whole token on each side of a trade: the coin's going one way, its pair's the other. */
function units(quoteMint, sellingBase) {
  const coin = 10 ** COIN_DECIMALS
  const pair = tokenUnit(quoteMint)
  return sellingBase ? { inUnit: coin, outUnit: pair } : { inUnit: pair, outUnit: coin }
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
  const unit = tokenUnit(config.quoteMint)
  const lifetime = (Number(pool.metrics.totalTradingQuoteFee.toString()) * sharePct) / 100 / unit
  const pending = Number(pool.creatorQuoteFee.toString()) / unit
  return {
    pending,
    claimed: Math.max(0, lifetime - pending),
    lifetime,
    sharePct,
  }
}

/**
 * What a shared coin owes its creator and its holders.
 *
 * Read from two places, because fees only reach the vault when a shareholder pulls
 * them in. Whatever trading has earned since the last pull is still in the pool as
 * creator fees, undivided — so the pool's own figure would count the holders' part as
 * the creator's. The vault splits by share the moment fees arrive, so each side's
 * pending figure is what the vault already holds for them plus their share of what the
 * pool still holds.
 *
 * Null for a coin with no vault, which is every coin whose creator kept it all.
 */
export async function vaultFees({ pool }, { vault, creator, lp = null }) {
  if (!vault) return null
  const { DynamicFeeSharingClient } = await import('@meteora-ag/dynamic-fee-sharing-sdk')
  const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
  const address = new PublicKey(vault)
  const [state, breakdown] = await Promise.all([dfs.getFeeVault(address), dfs.getFeeBreakdown(address)])
  const total = BigInt(state.totalShare)
  const unit = tokenUnit(state.tokenMint)
  // After graduation the undivided fees sit in the locked position the vault owns
  // rather than on the curve. Same split, other place.
  const inPosition = lp
    ? BigInt(Math.round((lp.tokenB === state.tokenMint.toBase58() ? lp.feeB : lp.feeA) * unit))
    : 0n
  const inPool = BigInt(pool.creatorQuoteFee.toString()) + inPosition
  const nobody = { share: 0, pending: 0, claimed: 0 }

  const side = (who) => {
    const user = state.users.find((u) => u.share > 0 && u.address.toBase58() === who)
    if (!user || !total) return nobody
    const funded = breakdown.userFees.find((u) => u.address.toBase58() === who)
    const share = BigInt(user.share)
    return {
      share: Number(share),
      pending: Number(BigInt(funded?.feeUnclaimed.toString() ?? '0') + (inPool * share) / total) / unit,
      claimed: Number(BigInt(user.feeClaimed.toString())) / unit,
    }
  }
  // Only the pot's slot is the holders'. A vault opened through the SDK can give its
  // second slot to any wallet at all, and a coin page that called that "holders" would
  // be announcing a gift to holders that pays them nothing.
  const { FEES } = await import('../lib/config.mjs')
  return {
    vault: address.toBase58(),
    totalShare: Number(total),
    creator: side(creator),
    holders: FEES.holderPot ? side(FEES.holderPot) : nobody,
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
export async function claimInstructions({ address, pool, config }, { creator, lp, vault }) {
  const owner = new PublicKey(creator)
  const out = []

  // A shared coin's creator fees are not the creator's to take from the pool: the pool
  // answers only to its creator, which is the vault. So they are pulled into the vault
  // — which splits them by share on arrival — and the creator takes their own part, in
  // the same transaction. Pulling in moves the holders' part too, which is what the
  // program means by it; it cannot be taken, only left waiting for the hourly payout.
  if (vault) {
    const { DynamicFeeSharingClient } = await import('@meteora-ag/dynamic-fee-sharing-sdk')
    const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
    const feeVault = new PublicKey(vault)
    const state = await dfs.getFeeVault(feeVault)
    const mine = state.users.find((u) => u.share > 0 && u.address.equals(owner))
    // Only a shareholder may pull fees in, and a creator who gave holders everything is
    // not one. There is nothing of theirs to claim; the payout moves the holders' part.
    if (!mine) return out

    const inCurve = BigInt(pool.creatorQuoteFee.toString())
    if (inCurve > 0n) {
      const pull = await dfs.fundByClaimDbcCreatorTradingFee({
        signer: owner, creator: owner, feeVault,
        poolConfig: pool.config, virtualPool: address,
        poolConfigState: config, virtualPoolState: { poolState: pool },
      })
      out.push(...pull.instructions)
    }

    // After graduation the vault owns the creator's locked position — it was the pool's
    // creator when the pool migrated — so that position's fees are pulled the same way,
    // from DAMM v2. The program checks only the account it pays into the vault, which
    // must be the pool's token B; every pool migrated so far puts the quote there and
    // collects fees in nothing else. The token A account must still exist, and gets 0.
    const inPosition = lp
      ? BigInt(Math.round((lp.tokenB === state.tokenMint.toBase58() ? lp.feeB : lp.feeA) * tokenUnit(state.tokenMint)))
      : 0n
    if (inPosition > 0n) {
      const { derivePositionNftAccount } = await import('@meteora-ag/cp-amm-sdk')
      const pull = await dfs.fundByClaimDammV2Fee({
        signer: owner, owner, feeVault,
        dammV2Pool: new PublicKey(lp.pool),
        dammV2Position: new PublicKey(lp.position),
        dammV2PositionNftAccount: derivePositionNftAccount(new PublicKey(lp.nftMint)),
        dammV2PoolState: lp.poolState,
      })
      out.push(...pull.instructions)
    }

    const breakdown = await dfs.getFeeBreakdown(feeVault)
    const waiting = BigInt(breakdown.userFees.find((u) => u.address.equals(owner))?.feeUnclaimed.toString() ?? '0')
    if (waiting + ((inCurve + inPosition) * BigInt(mine.share)) / BigInt(state.totalShare) > 0n) {
      const take = await dfs.claimUserFee({ feeVault, user: owner, payer: owner })
      out.push(...take.instructions)
    }
    return out
  }

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

export async function buildClaimAll(state, { creator, lp, vault }) {
  const ixs = await claimInstructions(state, { creator, lp, vault })
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
    const ixs = await claimInstructions(entry.state, { creator, lp: entry.lp, vault: entry.coin?.vault })
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
export async function buildSwap({ address, config }, { owner, amountIn, minimumOut, sellingBase }) {
  const { inUnit, outUnit } = units(config.quoteMint, sellingBase)
  const tx = await client.pool.swap2({
    owner: new PublicKey(owner),
    payer: new PublicKey(owner),
    pool: address,
    amountIn: new BN(Math.floor(amountIn * inUnit)),
    minimumAmountOut: new BN(Math.floor((minimumOut ?? 0) * outUnit)),
    swapMode: SwapMode.PartialFill,
    swapBaseForQuote: sellingBase,
    referralTokenAccount: null,
  })
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = new PublicKey(owner)
  return tx
}
