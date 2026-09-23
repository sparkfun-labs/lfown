// LFOwn — what holders have actually been paid.
//
// Every coin that shares its fees pays its holders from one address, the holder pot
// (FEES.holderPot), in the coin it is paired with. So the pot's own history is the
// full record: each outgoing token transfer is one holder paid once. Nothing is
// indexed on our side; the transfers are read back from chain and added up.
//
// Kept incrementally: the stored report remembers the newest signature it has read,
// and a rebuild only parses what came after it.

const HELIUS_TX = 'https://api.helius.xyz/v0/transactions'
const BATCH = 100
const RECENT = 20

const heliusKey = (rpcUrl) => String(rpcUrl ?? '').match(/api-key=([^&\s"]+)/)?.[1] ?? null

/** Signatures touching `address`, oldest first, stopping at `until`. */
async function signaturesSince(connection, PublicKey, address, until) {
  const out = []
  let before
  for (;;) {
    const page = await connection.getSignaturesForAddress(new PublicKey(address), { before, until: until ?? undefined, limit: 1000 })
    out.push(...page.filter((s) => !s.err))
    if (page.length < 1000) break
    before = page[page.length - 1].signature
  }
  return out.reverse()
}

/** The payouts in a batch of parsed transactions: transfers out of the pot to someone else. */
export function payoutsIn(parsed, pot) {
  const rounds = []
  for (const tx of parsed) {
    const paid = (tx.tokenTransfers ?? []).filter((t) => t.fromUserAccount === pot && t.toUserAccount && t.toUserAccount !== pot && Number(t.tokenAmount) > 0)
    if (!paid.length) continue
    rounds.push({
      signature: tx.signature,
      at: (tx.timestamp ?? 0) * 1000,
      mint: paid[0].mint,
      transfers: paid.map((t) => ({ to: t.toUserAccount, mint: t.mint, amount: Number(t.tokenAmount) })),
    })
  }
  return rounds
}

/** Folds new rounds into the running totals. */
export function fold(state, rounds) {
  const next = {
    newest: state?.newest ?? null,
    rounds: state?.rounds ?? 0,
    payments: state?.payments ?? 0,
    wallets: new Set(state?.wallets ?? []),
    byMint: { ...(state?.byMint ?? {}) },
    recent: [...(state?.recent ?? [])],
  }
  for (const r of rounds) {
    next.rounds++
    next.payments += r.transfers.length
    for (const t of r.transfers) {
      next.wallets.add(t.to)
      next.byMint[t.mint] = (next.byMint[t.mint] ?? 0) + t.amount
    }
    next.recent.unshift({
      signature: r.signature,
      at: r.at,
      mint: r.mint,
      amount: r.transfers.reduce((s, t) => s + t.amount, 0),
      recipients: r.transfers.length,
    })
  }
  // Newest first by the chain's own clock: the order transactions come back in is not
  // guaranteed to be the order they landed in.
  next.recent = next.recent.sort((a, b) => b.at - a.at).slice(0, RECENT)
  return next
}

/** Reads what the pot has paid since `state` last looked, and returns the new state. */
export async function updatePayouts(connection, PublicKey, rpcUrl, pot, state) {
  const key = heliusKey(rpcUrl)
  if (!key) throw new Error('holder payouts need the Helius parsed-transaction api')
  const signatures = await signaturesSince(connection, PublicKey, pot, state?.newest)
  if (!signatures.length) return state ?? fold(null, [])
  let next = state
  for (let i = 0; i < signatures.length; i += BATCH) {
    const slice = signatures.slice(i, i + BATCH).map((s) => s.signature)
    const res = await fetch(`${HELIUS_TX}?api-key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactions: slice }),
    })
    if (!res.ok) throw new Error(`parsed transactions returned ${res.status}`)
    const parsed = await res.json()
    next = fold(next, payoutsIn(Array.isArray(parsed) ? parsed : [], pot))
    next.newest = slice[slice.length - 1]
  }
  return next
}

/**
 * The page's figures. Payouts are valued at today's price, the way their total would
 * read in a wallet now, and labelled so; earned-but-waiting comes from the fee report.
 */
export function rewardsView(state, { prices, symbols, report }) {
  const value = (mint, amount) => amount * (prices.get(mint) ?? 0)
  const byToken = Object.entries(state?.byMint ?? {})
    .map(([mint, amount]) => ({ mint, symbol: symbols.get(mint) ?? `${mint.slice(0, 4)}…`, amount, usd: value(mint, amount) }))
    .sort((a, b) => b.usd - a.usd)
  const coins = (report?.coins ?? [])
    .filter((c) => c.holders > 0)
    .map((c) => ({ symbol: c.symbol, baseMint: c.baseMint, quoteSymbol: c.quoteSymbol, holdersUsd: c.holdersUsd }))
    .sort((a, b) => b.holdersUsd - a.holdersUsd)
  return {
    updatedAt: new Date().toISOString(),
    distributedUsd: byToken.reduce((s, t) => s + t.usd, 0),
    payments: state?.payments ?? 0,
    rounds: state?.rounds ?? 0,
    wallets: state?.wallets instanceof Set ? state.wallets.size : (state?.wallets?.length ?? 0),
    earnedUsd: report?.totals?.holdersUsd ?? 0,
    distributingCoins: coins.length,
    byToken,
    coins: coins.slice(0, 30),
    recent: [...(state?.recent ?? [])].sort((a, b) => b.at - a.at).map((r) => ({ ...r, symbol: symbols.get(r.mint) ?? `${r.mint.slice(0, 4)}…`, usd: value(r.mint, r.amount) })),
  }
}

/** The running state as JSON: the wallet set as a list. */
export const serialise = (state) => JSON.stringify({ ...state, wallets: [...(state?.wallets ?? [])] })
