// LFOWN — operating figures for 01Resolved's growth feed.
//
//   GET /api/growth/lfown.json   schema v1.1, one value per metric per completed UTC day
//
// See https://01resolved.com/docs/guides/operating-performance. Four metrics from their
// catalog, all read from the trades on every pool LFOWN opened, the curve's and the
// graduated pool's alike (the chart history, src/lib/chart.mjs):
//
//   transactions          trades that day
//   protocol_volume_usd   what those trades moved, on the pair's side, in dollars
//   daily_active_users    wallets that traded that day
//   new_users             wallets trading for the first time that day
//
// A day is computed once, after it ends, and kept: a figure 01Resolved has read never
// changes under it. Dollars are the pair's price when the day is computed — the next
// morning for every day from the first run on; the history before it was valued at the
// prices of that first run, which methodology 1.0 says.

export const PROJECT_ID = 'lfown'
export const METHODOLOGY = '1.0'

/** A unix time's UTC day, YYYY-MM-DD. */
export const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10)
/** The day after `day`. */
export const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/**
 * Adds the days after `record.through` and up to `lastDay` (both YYYY-MM-DD) to the
 * record, from `trades` — every trade, `{ t, quote, quoteMint, trader }`, in any order.
 * `prices` maps a pair's mint to its dollar price. A record that is new starts at the
 * first trade's day. Days with no trade between two that have one are real zeros and
 * are kept as such. Returns the record, which is also changed in place.
 */
export function extend(record, trades, prices, lastDay) {
  const sorted = [...trades].filter((x) => x.t).sort((a, b) => a.t - b.t)
  if (!sorted.length) return record
  const seen = new Set(record.seen ?? [])
  const from = record.through ? nextDay(record.through) : dayOf(sorted[0].t)
  if (from > lastDay) return record

  const days = record.days ?? {}
  for (let d = from; d <= lastDay; d = nextDay(d)) days[d] = { transactions: 0, volumeUsd: 0, activeUsers: 0, newUsers: 0 }
  const active = new Map()
  for (const trade of sorted) {
    const day = dayOf(trade.t)
    if (day < from) { if (trade.trader) seen.add(trade.trader); continue }
    if (day > lastDay) break
    const figures = days[day]
    figures.transactions++
    figures.volumeUsd += (trade.quote ?? 0) * (prices.get(trade.quoteMint) ?? 0)
    if (!trade.trader) continue
    if (!active.has(day)) active.set(day, new Set())
    active.get(day).add(trade.trader)
    if (!seen.has(trade.trader)) { seen.add(trade.trader); figures.newUsers++ }
  }
  for (const [day, wallets] of active) days[day].activeUsers = wallets.size
  for (const day of Object.keys(days)) days[day].volumeUsd = Math.round(days[day].volumeUsd * 100) / 100

  record.days = days
  record.seen = [...seen]
  record.through = lastDay
  record.firstDay ??= from
  return record
}

/**
 * The record as 01Resolved's schema v1.1 wants it, or null while it has no day: the
 * schema requires at least one metric with at least one observation, so an empty feed
 * would be rejected rather than read as "nothing yet".
 */
export function feed(record, now = new Date()) {
  const days = Object.keys(record.days ?? {}).sort()
  if (!days.length) return null
  const series = (pick) => days.map((date) => ({ date, value: pick(record.days[date]), methodology_version: METHODOLOGY }))
  return {
    schema_version: '1.1',
    project_id: PROJECT_ID,
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    metrics: [
      { metric_id: 'transactions', observations: series((d) => d.transactions) },
      { metric_id: 'protocol_volume_usd', observations: series((d) => d.volumeUsd) },
      { metric_id: 'daily_active_users', observations: series((d) => d.activeUsers) },
      { metric_id: 'new_users', observations: series((d) => d.newUsers) },
    ],
  }
}
