// LFOwn — the registry of MetaDAO ownership coins usable as a backing asset.
//
// MetaDAO publishes its own market API, which is authoritative: it lists the live
// DAOs and, crucially, each one's real treasury. Earlier versions of this file
// derived the list from the futarchy AMM's accounts and reported the pool's USDC
// as the treasury — those are two different numbers, and the pool one was wrong.
// Jupiter fills in what the market API does not carry: icons and holder counts.
//
// 01Resolved fills in the financials when a key is configured. MetaDAO's
// `treasury_usdc_aum` is the USDC in the treasury vault; 01Resolved counts every wallet a
// DAO controls and its LP positions, and adds NAV per token and runway. Where it knows a
// coin, its treasury is the one shown. MetaDAO still decides which coins are listed at
// all, so a 01Resolved outage changes some numbers and nothing else.

import { JUP, USDC, EXIT_SIZES, MIN_TREASURY_USD } from './config.mjs'

// The market API rejects requests without a browser-shaped User-Agent.
const UA = 'Mozilla/5.0 (compatible; LFOwn/1.0; +https://letsfuckingown.fun)'
const MARKET_API = 'https://market-api.metadao.fi/api/tickers'
const RESOLVED_API = 'https://api.01resolved.com/v1/global-dashboard'

/** A project's full financials on 01Resolved, for a link beside the numbers taken from it. */
export const financialsUrl = (slug) => `https://www.01resolved.com/${encodeURIComponent(slug)}/financials`

async function resolvedPages(path, key) {
  const rows = []
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${RESOLVED_API}/${path}?limit=100&page=${page}`, {
      headers: { 'x-api-key': key, accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`01resolved ${res.status} on ${path}`)
    const body = await res.json()
    rows.push(...(body.data ?? []))
    if (!(body.meta?.totalPages > page)) break
  }
  return rows
}

/**
 * Joins 01Resolved's per-project figures onto the catalogue.
 *
 * By mint, never by symbol: `completed-launches/info` is the one place that names both a
 * project's slug and its token's mint, and a symbol is only a label anyone can reuse.
 * Numbers arrive as strings and sometimes as nonsense — a runway of 8000 months, NAV of
 * zero — so they are parsed here and judged where they are shown.
 */
export function withFinancials(coins, projects, launches) {
  const slugByMint = new Map(launches.filter((l) => l.baseMint && l.organizationSlug).map((l) => [l.baseMint, l.organizationSlug]))
  const bySlug = new Map(projects.map((p) => [p.organizationSlug, p]))
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return coins.map((coin) => {
    const slug = slugByMint.get(coin.mint)
    const project = slug ? bySlug.get(slug) : null
    if (!project) return { ...coin, financials: null }
    const treasury = num(project.treasuryValue)
    return {
      ...coin,
      treasuryVault: coin.treasuryVault,
      treasuryMetadao: coin.treasury,
      treasury: treasury > 0 ? treasury : coin.treasury,
      financials: {
        source: '01Resolved',
        slug,
        url: financialsUrl(slug),
        treasury,
        navPerToken: num(project.netAssetValue),
        runwayMonths: num(project.monthsOfRunway),
        mNAV: num(project.mNAV),
        marketCap: num(project.marketCap),
        fdv: num(project.fdv),
        spendingLimit: num(project.spendingLimit),
      },
    }
  })
}

async function jup(url, params) {
  const res = await fetch(`${url}?${new URLSearchParams(params)}`)
  if (!res.ok) throw new Error(`jupiter ${res.status} on ${url}`)
  return res.json()
}

/** What a holder actually receives selling `usd` worth of `mint` into USDC, right now. */
export async function exitCost(mint, usdPrice, usd) {
  const amount = Math.floor((usd / usdPrice) * 1e6)
  try {
    const q = await jup(JUP.quote, { inputMint: mint, outputMint: USDC, amount, slippageBps: 50 })
    const received = Number(q.outAmount) / 1e6
    return {
      usd,
      received,
      lossPct: (received / (amount / 1e6) / usdPrice - 1) * 100,
      venues: [...new Set((q.routePlan ?? []).map((r) => r.swapInfo.label))],
    }
  } catch {
    return { usd, received: null, lossPct: null, venues: [] } // no route at this size
  }
}

/**
 * The catalogue. A DAO whose treasury is gone has nothing backing a pair, so it is
 * not offered as a backing asset — that is the one exclusion, and it is about
 * backing, not size. Exit costs are priced separately, on demand.
 */
export async function buildRegistry(_endpoint, { withExits = false, resolvedKey } = {}) {
  const res = await fetch(MARKET_API, { headers: { 'user-agent': UA, accept: 'application/json' } })
  if (!res.ok) throw new Error(`metadao market api ${res.status}`)
  const tickers = await res.json()

  const daos = tickers
    .filter((t) => t.target_currency === USDC)
    .map((t) => ({
      mint: t.base_currency,
      symbol: t.base_symbol,
      name: t.base_name,
      usdPrice: Number(t.last_price) || 0,
      liquidity: Number(t.liquidity_in_usd) || 0,
      treasury: Number(t.treasury_usdc_aum) || 0,
      treasuryVault: t.treasury_vault_address ?? null,
      volume24h: Number(t.target_volume) || 0,
      pool: t.pool_id,
      since: t.startDate ?? null,
    }))
    .filter((d) => d.treasury >= MIN_TREASURY_USD && d.usdPrice > 0)

  // Icons and holder counts only exist on Jupiter's side.
  const extra = new Map()
  const mints = daos.map((d) => d.mint)
  for (let i = 0; i < mints.length; i += 20) {
    try {
      const found = await jup(JUP.tokens, { query: mints.slice(i, i + 20).join(',') })
      for (const t of found) extra.set(t.id, { icon: t.icon, holders: t.holderCount ?? 0, mcap: t.mcap ?? 0 })
    } catch { /* the catalogue is still usable without decoration */ }
  }

  const coins = []
  for (const d of daos) {
    coins.push({
      ...d,
      ...(extra.get(d.mint) ?? { icon: null, holders: 0, mcap: 0 }),
      exits: withExits ? await Promise.all(EXIT_SIZES.map((s) => exitCost(d.mint, d.usdPrice, s))) : [],
    })
  }

  let listed = coins
  if (resolvedKey) {
    try {
      const [projects, launches] = await Promise.all([
        resolvedPages('projects-launch', resolvedKey),
        resolvedPages('completed-launches/info', resolvedKey),
      ])
      listed = withFinancials(coins, projects, launches)
    } catch (e) {
      console.error(`01resolved unavailable, keeping MetaDAO's treasuries: ${e.message}`)
    }
  }

  listed.sort((a, b) => b.treasury - a.treasury)
  return { updatedAt: new Date().toISOString(), count: listed.length, coins: listed }
}
