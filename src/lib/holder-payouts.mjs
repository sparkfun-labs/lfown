// LFOwn — paying a coin's holders the share its creator gave them.
//
// The fee-sharing vault holds that share, but it can only hold it: the program pays
// five fixed addresses and a coin's holders are a crowd that changes with every
// trade. So the vault pays one address, `FEES.holderPot`, and this hands that on.
//
// Per coin, per run, and in this order, because each step is what makes the next one
// safe to do:
//
//   1. read what the pot is owed in that coin's vault
//   2. leave it there unless it is worth more than the accounts paying it out cost
//   3. claim it, snapshot who holds the coin, pay them pro rata
//
// Step 2 is why the pot holds nothing between runs. Everything below the floor stays
// in the vault, where only its shareholders can reach it and where it keeps
// accruing, rather than piling up on a hot key waiting to be worth moving.

import { PublicKey } from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction,
} from '@solana/spl-token'
import { allocate, deriveVault } from './fee-split.mjs'

/**
 * Below this, in dollars, a coin is left alone for the next run.
 *
 * Paying someone a token they have never held means renting them an account for it:
 * 0.00148844 SOL for a 165-byte token account, measured on mainnet, which the payer
 * never gets back. Written in SOL rather than dollars because the dollar figure moves
 * with the price and a comment does not. A pot has to be worth a handful of those
 * before handing it out stops costing more than it hands out.
 */
export const FLOOR_USD = 2

/**
 * And below this, one person's share is not worth the account it would need. Such a
 * holder is left out of the run and their share re-split among the others — not held
 * back, because a vault is claimed all or nothing and a share held back would sit in
 * the pot where nothing reads it again.
 */
export const PER_HOLDER_FLOOR_USD = 0.5

/** How many transfers ride in one transaction, with room for the account each needs. */
const PER_TRANSACTION = 5

/**
 * Everyone holding `mint` right now, straight from the chain.
 *
 * `getTokenAccounts` is Helius's own, and the plain `getProgramAccounts` this would
 * otherwise need is not available on every plan — it answers 403 on ours. Paged,
 * because a coin that works is a coin with more holders than one page.
 */
export async function snapshotHolders(rpcUrl, mint) {
  const holders = []
  let cursor
  for (let page = 0; page < 50; page++) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getTokenAccounts',
        params: { mint, limit: 1000, ...(cursor ? { cursor } : {}) },
      }),
    })
    const body = await res.json()
    if (body.error) throw new Error(`getTokenAccounts: ${body.error.message ?? body.error}`)
    const accounts = body.result?.token_accounts ?? []
    for (const a of accounts) {
      if (BigInt(a.amount) > 0n) holders.push({ address: a.owner, amount: BigInt(a.amount) })
    }
    cursor = body.result?.cursor
    if (!cursor || accounts.length === 0) break
  }
  return holders
}

/**
 * What each vault owes the pot, for the coins that have one.
 *
 * A coin only has a vault if its creator asked for one at launch, and the address is
 * derived from the coin itself — so this needs no registry, just the launches list
 * and one account read each.
 */
export async function pendingHolderFees(dfs, connection, launches, { potAddress, prices = new Map() } = {}) {
  const pot = new PublicKey(potAddress)
  const candidates = launches
    .filter((l) => l.baseMint && l.quoteMint)
    .map((l) => ({ launch: l, vault: deriveVault(l.baseMint, l.quoteMint) }))
  if (!candidates.length) return []

  // One batched read tells us which of them were ever opened; the rest never had a
  // vault and never will, because opening one needs the mint's signature.
  const open = []
  for (let i = 0; i < candidates.length; i += 100) {
    const slice = candidates.slice(i, i + 100)
    const infos = await connection.getMultipleAccountsInfo(slice.map((c) => c.vault))
    slice.forEach((c, j) => { if (infos[j]) open.push(c) })
  }

  const owed = []
  for (const { launch, vault } of open) {
    try {
      const breakdown = await dfs.getFeeBreakdown(vault)
      const mine = breakdown.userFees.find((u) => u.address.equals(pot))
      if (!mine) continue
      const amount = BigInt(mine.feeUnclaimed.toString())
      if (amount <= 0n) continue
      const price = prices.get(launch.quoteMint) ?? launch.quoteUsdPrice ?? 0
      owed.push({ launch, vault, amount, usd: (Number(amount) / 1e6) * price, price })
    } catch (e) {
      console.error(`holder payout: vault ${vault.toBase58()} unreadable — ${e.message}`)
    }
  }
  return owed
}

/**
 * The transfers that hand one coin's pot to its holders.
 *
 * The pool's own vault is left out: on a bonding curve the program holds most of the
 * supply, and paying it would be paying the curve to hold its own tokens.
 *
 * No batches means nobody clears the floor, and the caller must not claim: the share
 * is safer left in the vault than moved to a pot with nobody to hand it to. `totals`
 * is what each batch sends, so a run that fails part way knows what never went out.
 */
export function payoutInstructions({ holders, pot, payer, quoteMint, amount, price, exclude }) {
  const dust = price > 0 ? BigInt(Math.ceil((PER_HOLDER_FLOOR_USD / price) * 1e6)) : 0n
  const { payouts, paid, carried } = allocate(holders, amount, { exclude, dust })
  if (!payouts.length) return { batches: [], totals: [], paid: 0n, carried, payouts: [] }

  const mint = new PublicKey(quoteMint)
  const from = getAssociatedTokenAddressSync(mint, pot, true)
  const batches = []
  const totals = []
  for (let i = 0; i < payouts.length; i += PER_TRANSACTION) {
    const instructions = []
    const slice = payouts.slice(i, i + PER_TRANSACTION)
    totals.push(slice.reduce((t, p) => t + p.amount, 0n))
    for (const p of slice) {
      const owner = new PublicKey(p.address)
      const to = getAssociatedTokenAddressSync(mint, owner, true)
      // Idempotent: a holder who already has an account for this coin is common, and
      // the plain create would fail the whole batch for everyone else in it.
      // The payer rents the account, not the pot: the pot holds what is owed to other
      // people and nothing else, so it never needs a SOL balance of its own.
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(payer, to, owner, mint, TOKEN_PROGRAM_ID))
      instructions.push(createTransferInstruction(from, to, pot, p.amount, [], TOKEN_PROGRAM_ID))
    }
    batches.push(instructions)
  }
  return { batches, totals, paid, carried, payouts }
}
