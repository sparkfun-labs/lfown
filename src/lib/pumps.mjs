// LFOwn — telling people when an ownership coin is having a day.
//
// Someone holding AVICI while it is up a third is the person most likely to launch a
// meme against it: they feel rich, they believe in the coin, and pairing a meme with
// it is a way to ride the moment. So when a coin in the catalogue moves hard, the
// catalogue cron says so on the channels, with a link that opens the launch page on
// that coin already picked.
//
// This file only decides *which* coins qualify. Posting, and remembering what was
// posted, lives beside the other announcements in worker.mjs.

export const PUMP = {
  /** A move worth a post, in percent over 24 hours. Below this it is a normal day. */
  minPct: 20,
  /**
   * Thin coins move 50% on a few hundred dollars of volume. A post about that sends
   * people to launch against a coin nobody can buy or sell, so it is not worth making.
   */
  minLiquidityUsd: 10_000,
  /** Once a coin has been posted, it is quiet for a day however far it keeps going. */
  cooldownSeconds: 24 * 60 * 60,
  /** Per channel, per UTC day. A link on X costs money, and a feed of pumps is noise. */
  dailyCap: 3,
}

/**
 * The coins moving enough to post about, biggest move first.
 *
 * The 24-hour change comes from 01Resolved, carried on each coin as
 * `financials.priceChange24h`; a coin it does not track, or a figure it did not send,
 * never qualifies — guessing a move from two prices is how a post announces a pump
 * that did not happen.
 */
export function pumpCandidates(coins, { minPct = PUMP.minPct, minLiquidityUsd = PUMP.minLiquidityUsd } = {}) {
  return (coins ?? [])
    .map((coin) => ({ coin, change: Number(coin?.financials?.priceChange24h) }))
    .filter(({ coin, change }) => Number.isFinite(change) && change >= minPct && Number(coin.liquidity) >= minLiquidityUsd)
    .sort((a, b) => b.change - a.change)
}

/** The launch page, opened on this coin. */
export const launchUrl = (coin, origin) => `${origin}/launch?quote=${encodeURIComponent(coin.symbol)}`
