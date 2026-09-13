// LFOwn — giving part of a creator's fees to the people holding the coin.
//
// The config's split is immutable and stays as it is: of every trading fee Meteora
// leaves behind, half is the partner's and half the creator's. What a creator now
// chooses at launch is how to cut *their own* half — anything from all of it to an
// even split with their holders. The DAO's half is untouched either way.
//
// The cut is enforced on chain rather than promised. Meteora's dynamic-fee-sharing
// program (dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh) owns a small vault that
// becomes the pool's creator, so the creator's fees are paid into it and each side
// claims its own share with its own signature. Nobody, LFOwn included, can take the
// other's part, and the shares cannot be edited once the vault exists.
//
// That program pays at most five fixed addresses (`MAX_USER = 5`), so it cannot pay
// holders directly — a coin's holders are a crowd that changes with every trade.
// It pays two: the creator, and one LFOwn address that collects the holders' part.
// Handing that part out is this file's other half: a snapshot, a pro-rata split, and
// a floor under which paying someone costs more than it gives them.

import { PublicKey } from '@solana/web3.js'

/**
 * The most of their own half a creator can hand over, in points of the whole trading
 * fee. It is the creator's entire share: at the top of the slider they keep nothing
 * and holders take 50% of every fee, which is the same 50% the DAO takes.
 */
export const HOLDER_MAX_PCT = 50

/** The vault is derived from the coin, so it can be found again from the mint alone. */
export const DFS_PROGRAM_ID = new PublicKey('dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh')

/**
 * A creator's choice, as the two numbers every screen quotes.
 *
 * Percentages here are of the *whole* trading fee, which is what a creator is really
 * asking about, rather than of the half the vault happens to see.
 */
export function splitFor(holderPct, creatorSharePct = 50) {
  const holders = clampHolderPct(holderPct)
  return {
    holderPct: holders,
    creator: creatorSharePct - holders,
    holders,
    partner: 100 - creatorSharePct,
  }
}

/** Out of range, backwards, or not a number at all: all of it means "keep it all". */
export function clampHolderPct(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return 0
  return Math.min(HOLDER_MAX_PCT, Math.max(0, n))
}

/**
 * The vault's two shareholders.
 *
 * `share` is a u32 and only its ratio matters, so the percentages themselves are the
 * shares — 30 and 20 rather than a scaled pair nobody can read against the slider.
 * A zero share is not written at all: a shareholder who can never be owed anything
 * is a slot spent, and there are only five.
 */
export function vaultShares(holderPct, { creator, holders }) {
  const pct = clampHolderPct(holderPct)
  const shares = []
  if (pct < HOLDER_MAX_PCT) shares.push({ address: new PublicKey(creator), share: HOLDER_MAX_PCT - pct })
  if (pct > 0) shares.push({ address: new PublicKey(holders), share: pct })
  return shares
}

/** Whether a launch needs a vault at all. Keeping it all is the plain old path. */
export const needsVault = (holderPct) => clampHolderPct(holderPct) > 0

/**
 * Where a coin's vault lives. Seeded by the coin so it is found from the mint alone,
 * and holding the quote mint because that is the token trading fees are paid in.
 *
 * Spelled out rather than called through `deriveFeeVaultPdaAddress`, so the launch
 * screen can show the address without pulling the fee-sharing SDK into the browser
 * bundle. The test asserts the two agree.
 */
export function deriveVault(baseMint, quoteMint) {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_vault'), new PublicKey(baseMint).toBuffer(), new PublicKey(quoteMint).toBuffer()],
    DFS_PROGRAM_ID,
  )
  return vault
}

/**
 * Who gets what out of a pot, given a snapshot of balances.
 *
 * In base units and integer arithmetic throughout: a pro-rata split done in floats
 * leaks a few lamports on every run, and the leak is the kind that only shows up as
 * a failed transfer months later when the vault is a hair short.
 *
 * `exclude` is how the pool's own vault stays out of it. On a bonding curve the
 * program holds most of the supply — 77% to 99% of the coins launched here so far —
 * and paying it would be paying the curve to hold its own tokens.
 *
 * `dust` is the floor per person. Receiving a token costs rent if the recipient has
 * no account for it yet, so a share below the floor is worth less than the account
 * it would need. Those shares stay in the pot for the next run, where they may
 * clear it; `carried` says how much that was.
 */
export function allocate(holders, pot, { exclude = [], dust = 0n } = {}) {
  const out = new Set(exclude.map(String))
  const eligible = holders
    .map((h) => ({ address: String(h.address), amount: BigInt(h.amount) }))
    .filter((h) => h.amount > 0n && !out.has(h.address))

  const supply = eligible.reduce((t, h) => t + h.amount, 0n)
  const amount = BigInt(pot)
  if (supply === 0n || amount <= 0n) return { payouts: [], paid: 0n, carried: amount > 0n ? amount : 0n }

  // Floor division leaves a remainder smaller than the number of holders. It goes to
  // the largest holder rather than to whoever the snapshot happened to list first,
  // which would quietly favour an ordering nobody chose.
  const shares = eligible
    .map((h) => ({ address: h.address, share: (amount * h.amount) / supply, weight: h.amount }))
    .sort((a, b) => (b.weight === a.weight ? 0 : b.weight > a.weight ? 1 : -1))
  const remainder = amount - shares.reduce((t, s) => t + s.share, 0n)
  if (shares.length) shares[0].share += remainder

  const payouts = shares.filter((s) => s.share >= dust && s.share > 0n)
    .map(({ address, share }) => ({ address, amount: share }))
  const paid = payouts.reduce((t, p) => t + p.amount, 0n)
  return { payouts, paid, carried: amount - paid }
}
