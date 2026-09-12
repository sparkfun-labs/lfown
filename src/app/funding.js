// LFOwn — paying with SOL or USDC.
//
// Everything here is priced in an ownership coin, and that is the point: a launch is
// backed by a treasury rather than by SOL. But requiring someone to already hold
// AVICI before they can touch the site turns the premise into a wall. Jupiter routes
// the SOL or USDC they do hold into the ownership coin first.
//
// In its own transaction, not composed into the launch. Both reasons were measured
// rather than assumed:
//
//   size        a Jupiter SOL→AVICI route is 817 bytes over 7 instructions and two
//               lookup tables; createPoolWithFirstBuy is 905 bytes and its accounts
//               are in no table that could compress them. The cap is 1232.
//   correctness a composed swap's real output is not known until it executes, so the
//               buy behind it would have to be sized on the swap's *minimum* output
//               and strand the difference.
//
// The in-between state is not a stranded wrapper: it is the ownership coin itself,
// held by the person who bought it. Every screen here reads the balance first and
// tops up only the shortfall, so a launch that fails after the swap costs a retry
// and nothing else.

import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'

export const NATIVE_SOL = 'So11111111111111111111111111111111111111112'

// Every ownership coin is 6 decimals, the same assumption the configs are built on.
export const COIN_DECIMALS = 6

/**
 * SOL pays rent and signature fees as well as the swap, and opening a pool is the
 * expensive one — mint, metadata, pool and two vaults all have to be made
 * rent-exempt. Quoting someone their whole balance and leaving them unable to sign
 * the transaction it was for is worse than quoting them less.
 */
export const GAS_RESERVE = { launch: 0.05, trade: 0.01 }

/**
 * What opening a pool costs in SOL, whatever the dev buy.
 *
 * Rent for the mint, its metadata account, the pool and its two vaults. Measured at
 * 0.02506–0.02513 across every launch this site has made; the margin covers the
 * signature and a busier fee market. Rent comes back if those accounts are ever
 * closed, but it has to be there on the day.
 */
export const LAUNCH_SOL = 0.03

export const PAY_WITH = [
  { mint: NATIVE_SOL, symbol: 'SOL', decimals: 9, native: true, probe: 1 },
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, native: false, probe: 200 },
]
export const payWith = (mint) => PAY_WITH.find((p) => p.mint === mint) ?? null

// Called straight from the browser rather than proxied: Jupiter allows any origin,
// its rate limit is per IP so every visitor carries their own, and a proxy here
// would be an open relay for anyone who found it.
const JUP = 'https://lite-api.jup.ag/swap/v1'

async function jup(path, init) {
  let res
  try {
    res = await fetch(`${JUP}${path}`, init)
  } catch {
    throw new Error('Could not reach Jupiter. Check your connection and try again.')
  }
  const body = await res.json().catch(() => null)
  if (res.ok) return body
  if (body?.errorCode === 'NO_ROUTES_FOUND') throw new Error('Jupiter has no route for that pair right now.')
  throw new Error(body?.error ?? `Jupiter returned ${res.status}.`)
}

/** Round away from zero at the token's precision, so a quote is never short by dust. */
const ceilTo = (n, decimals) => Math.ceil(n * 10 ** decimals) / 10 ** decimals

/** What someone holds. A missing token account is a zero balance, not a failure. */
export async function balanceOf(connection, owner, mint, { native = false } = {}) {
  const pubkey = new PublicKey(owner)
  if (native) return (await connection.getBalance(pubkey)) / 1e9
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), pubkey, true)
  try {
    const { value } = await connection.getTokenAccountBalance(ata)
    return Number(value.uiAmount ?? 0)
  } catch {
    return 0
  }
}

/**
 * A Jupiter quote in either direction. Amounts in and out are UI amounts.
 *
 * Jupiter routes through the bonding curve itself, so a route between SOL or USDC
 * and one of these coins is a single transaction that still pays the pool's fees.
 */
export async function quoteSwap({ inMint, inDecimals = COIN_DECIMALS, outMint, outDecimals = COIN_DECIMALS, uiAmount, slippageBps = 100 }) {
  const amount = Math.floor(uiAmount * 10 ** inDecimals)
  if (!(amount > 0)) throw new Error('Enter an amount.')
  const q = await jup(`/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}`)
  return {
    quote: q,
    in: amount / 10 ** inDecimals,
    out: Number(q.outAmount) / 10 ** outDecimals,
    minimumOut: Number(q.otherAmountThreshold) / 10 ** outDecimals,
    impactPct: Number(q.priceImpactPct ?? 0) * 100,
    route: (q.routePlan ?? []).map((p) => p.swapInfo?.label).filter(Boolean).join(' → '),
  }
}

/**
 * Prices `uiAmount` of SOL or USDC into the ownership coin, exact-in.
 *
 * Still its own leg, for the launch: a pool cannot be opened in the same transaction
 * as the swap that funds it — see the note at the top of this file. Trading needs no
 * such leg, and does not use this.
 */
export async function quoteInto({ pay, coinMint, uiAmount, slippageBps = 100 }) {
  const priced = await quoteSwap({
    inMint: pay.mint, inDecimals: pay.decimals, outMint: coinMint, uiAmount, slippageBps,
  })
  return { ...priced, pay }
}

/**
 * How much SOL or USDC buys at least `want` of the ownership coin.
 *
 * Jupiter has no exact-out route for these coins — the AMMs behind them do not
 * support it — so the input is found by pricing forwards and correcting. `headroom`
 * is deliberate overshoot: the swap and the buy behind it land in separate
 * transactions, and a route that fills a fraction under would leave the second one
 * short. Whatever is left over stays in the wallet as the ownership coin.
 */
export async function inputFor({ pay, coinMint, want, headroom = 0.03, slippageBps = 100 }) {
  const target = want * (1 + headroom)
  let priced = await quoteInto({ pay, coinMint, uiAmount: pay.probe, slippageBps })
  for (let pass = 0; pass < 3; pass++) {
    if (!priced.out) throw new Error(`No ${pay.symbol} route into that coin right now.`)
    const next = ceilTo((priced.in * target) / priced.out, pay.decimals)
    priced = await quoteInto({ pay, coinMint, uiAmount: next, slippageBps })
    // Each hop rounds down, so the last fraction of the aim is unreachable and
    // chasing it just burns passes. Within a tenth of a percent is arrival.
    if (priced.out >= target * 0.999) break
  }
  if (priced.out < want) {
    throw new Error(`${pay.symbol} liquidity cannot reach ${want.toFixed(4)} of that coin right now — the best route returns ${priced.out.toFixed(4)}.`)
  }
  return priced
}

/** The signed-by-nobody swap transaction Jupiter built for this exact quote. */
export async function buildSwapTx(quote, owner) {
  const body = await jup('/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: owner,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  })
  // Jupiter simulates against the real account, so this catches an empty wallet
  // before the person is asked to approve anything.
  if (body.simulationError) {
    const detail = body.simulationError.error ?? body.simulationError.errorCode ?? ''
    throw new Error(`The swap would fail: ${detail || 'check your balance'}.`)
  }
  return VersionedTransaction.deserialize(Uint8Array.from(atob(body.swapTransaction), (c) => c.charCodeAt(0)))
}

/**
 * Waits for a signature to land.
 *
 * Polls rather than subscribing: the RPC goes through our own Worker over HTTP and
 * there is no socket for web3's confirmTransaction to open, so it would hang.
 */
export async function confirm(connection, signature, { timeoutMs = 90_000, what = 'The swap' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature])
    const status = value?.[0]
    if (status?.err) throw new Error(`${what} failed on chain: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return
    await new Promise((r) => setTimeout(r, 1200))
  }
  throw new Error(`${what} has not confirmed yet. Check your wallet before trying again.`)
}

/**
 * Swaps, waits, and reports what actually arrived — read from the balance rather
 * than taken from the quote. A route fills where it fills, and the launch or buy
 * behind this has to be sized on what is really in the wallet.
 */
export async function topUp({ connection, wallet, coinMint, priced, say }) {
  const before = await balanceOf(connection, wallet.address, coinMint)
  say?.(`Building the ${priced.pay.symbol} swap…`)
  const tx = await buildSwapTx(priced.quote, wallet.address)
  say?.(`Waiting for your signature on the ${priced.pay.symbol} swap…`)
  const signature = await wallet.signAndSend(tx, connection)
  say?.(`Swapping ${priced.pay.symbol} — waiting for it to confirm…`)
  await confirm(connection, signature)
  const after = await balanceOf(connection, wallet.address, coinMint)
  // Floored at the token's own precision: the difference of two floats can land a
  // hair above what the account holds, and the buy behind this would then ask to
  // spend one unit that is not there.
  const received = Math.max(0, Math.floor((after - before) * 10 ** COIN_DECIMALS) / 10 ** COIN_DECIMALS)
  return { signature, received, balance: after }
}
