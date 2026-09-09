// LFOwn — fees earned after a coin graduates.
//
// On the curve, fees sit in the DBC pool and are claimed with the partner or creator
// key. After migration the liquidity lives in a DAMM v2 pool as two permanently
// locked positions — one for LFOwn, one for the creator — and locked liquidity still
// earns. Those fees are a different program, a different instruction, and they come
// in both tokens rather than only the quote.

import { PublicKey } from '@solana/web3.js'
import { CpAmm, getUnClaimLpFee, derivePositionNftAccount } from '@meteora-ag/cp-amm-sdk'

/**
 * Every graduated position an owner holds, with what is actually claimable.
 *
 * `feeAPending` on the account is a checkpoint, not a balance: it only moves when
 * the position is touched. The real figure is the growth since that checkpoint,
 * which is what getUnClaimLpFee works out.
 */
export async function lpPositions(connection, owner) {
  const cp = new CpAmm(connection)
  const held = await cp.getPositionsByUser(new PublicKey(owner))
  if (!held.length) return []

  const pools = new Map()
  const out = []
  for (const { position, positionState } of held) {
    const key = positionState.pool.toBase58()
    if (!pools.has(key)) pools.set(key, await cp.fetchPoolState(positionState.pool))
    const pool = pools.get(key)
    const fee = getUnClaimLpFee(pool, positionState)

    out.push({
      position: position.toBase58(),
      pool: key,
      poolState: pool,
      positionState,
      nftMint: positionState.nftMint.toBase58(),
      tokenA: pool.tokenAMint.toBase58(),
      tokenB: pool.tokenBMint.toBase58(),
      feeA: Number(fee.feeTokenA.toString()) / 1e6,
      feeB: Number(fee.feeTokenB.toString()) / 1e6,
      // Lifetime payouts, kept by the position itself. Without these a graduated
      // coin reads as if it had never paid its creator anything.
      claimedA: Number(positionState.metrics?.totalClaimedAFee?.toString() ?? 0) / 1e6,
      claimedB: Number(positionState.metrics?.totalClaimedBFee?.toString() ?? 0) / 1e6,
    })
  }
  return out
}

/** Builds the claim. Only the position's owner can sign it. */
export async function buildLpClaim(connection, entry, { owner, receiver, feePayer }) {
  const cp = new CpAmm(connection)
  const { poolState, positionState } = entry
  const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token')

  return cp.claimPositionFee2({
    owner: new PublicKey(owner),
    receiver: new PublicKey(receiver ?? owner),
    feePayer: feePayer ? new PublicKey(feePayer) : undefined,
    pool: new PublicKey(entry.pool),
    position: new PublicKey(entry.position),
    positionNftAccount: derivePositionNftAccount(positionState.nftMint),
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
  })
}
