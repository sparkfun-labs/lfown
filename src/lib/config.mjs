// LFOwn — shared constants.
// No secrets here: the RPC url arrives from the environment (.dev.vars locally,
// `wrangler secret put HELIUS_RPC` in production) and never reaches the client.

/** MetaDAO futarchy AMM. Every ownership coin has a spot pool owned by this program. */
export const FUTARCHY_AMM = 'FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq'

/** Pool layout, established by locating known pubkeys inside a live pool account. */
export const POOL = {
  size: 1205,
  baseOffset: 157,        // base mint
  quoteOffset: 189,       // quote mint
  quoteVaultOffset: 253,  // token account holding the pool's USDC
  sliceLength: 128,       // covers all three from baseOffset
}

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export const JUP = {
  tokens: 'https://lite-api.jup.ag/tokens/v2/search',
  price: 'https://lite-api.jup.ag/price/v3',
  quote: 'https://lite-api.jup.ag/swap/v1/quote',
}

/** Exit sizes we price on every quote asset, in USD. Shown to the user, never used to gate. */
export const EXIT_SIZES = [1_000, 5_000, 25_000]

/**
 * A DAO whose treasury is spent has nothing backing a pair. The floor is low on
 * purpose — it excludes the drained ones (LOYAL sits at $1) without turning into
 * a judgement on how big a treasury has to be.
 */
export const MIN_TREASURY_USD = 10

/**
 * A launch graduates when the curve has taken in this much of the backing coin,
 * and that threshold lives in the shared DBC config — so it is a tier chosen when
 * LFOwn opens a coin, not a number a creator types. The raise is also the entire
 * liquidity of the pool the launch graduates into, which is why the smallest tier
 * is still meaningful money. StonkFun solves the same problem by deriving the
 * raise from a pricing endpoint rather than letting anyone pass a raw amount.
 */
export const TIERS = [
  { id: 'starter',  usd: 5_000,  label: 'Starter'  },
  { id: 'standard', usd: 15_000, label: 'Standard' },
  { id: 'serious',  usd: 50_000, label: 'Serious'  },
]

/**
 * 2.5% on every trade, split down the middle: half to the coin's creator, half to
 * the LFOwn DAO treasury.
 *
 * Both the rate and the recipient live inside each DBC config, which is immutable.
 * Changing either means creating new configs — see `scripts/create-config.mjs`.
 * Configs opened before this rate existed still charge what they were opened with,
 * which is why the launch screen reads the fee back from KV rather than from here.
 */
export const FEES = {
  /**
   * The config's fee claimer — the only account the program lets authorise a claim,
   * and it must sign. The DAO treasury is a futarchy PDA, off the ed25519 curve, so
   * no key for it exists and it can never sign one: putting it here would mean a
   * governance proposal per claim. A collector signs instead.
   *
   * That key is worth more than one sweep's fees. It is written into every config,
   * which cannot be changed afterwards, and after a graduation it holds LFOwn's
   * locked position in the coin's pool — a transferable NFT. Losing it means losing
   * the partner's share of every curve opened so far and the graduated income of
   * every coin already graduated. It can never reach the treasury, which only ever
   * receives. See the README on where to keep it.
   */
  recipient: '38A38w6Y4ZTnBY2vB9DcaPfzpWPRfs9tJYqami9tohwx',

  /**
   * Where the money ends up. Receiving needs no signature, so this is the DAO
   * treasury itself — claims land there directly, never in the collector.
   */
  treasury: 'A1XGC7uJtLcBb7oa7Q6DJtkBFriPrBGLDtSMiD2gNUHm',

  totalBps: 250,
  creatorSharePct: 50,
}

/** What a config opened before the fee was recorded in KV actually charges. */
export const LEGACY_FEE_BPS = 100

/**
 * Meteora keeps this share of every trading fee before the rest is split between
 * the creator and the partner. It is a constant in their program, not something a
 * config can set, so a "50/50 split" is 50/50 of what is left — not of the fee.
 */
export const PROTOCOL_CUT_PCT = 20

/** The three ways a trading fee of `bps` actually lands, in basis points. */
export function feeBreakdown(bps, creatorSharePct = FEES.creatorSharePct) {
  const protocol = (bps * PROTOCOL_CUT_PCT) / 100
  const shared = bps - protocol
  return {
    protocol,
    creator: (shared * creatorSharePct) / 100,
    partner: (shared * (100 - creatorSharePct)) / 100,
  }
}
