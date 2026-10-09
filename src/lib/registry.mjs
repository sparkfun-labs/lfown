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

import { JUP, USDC, EXIT_SIZES, MIN_TREASURY_USD, COIN_DECIMALS, EXTRA_QUOTES, tokenUnit } from './config.mjs'

// The market API rejects requests without a browser-shaped User-Agent.
const UA = 'Mozilla/5.0 (compatible; LFOwn/1.0; +https://letsfuckingown.fun)'
const MARKET_API = 'https://market-api.metadao.fi/api/tickers'
const RESOLVED_API = 'https://api.01resolved.com/v1/global-dashboard'

/** A project's full financials on 01Resolved, for a link beside the numbers taken from it. */
export const financialsUrl = (slug) => `https://www.01resolved.com/${encodeURIComponent(slug)}/financials`

/**
 * 01Resolved's plan: ten rows a request, three pages deep, and a cap on the pace. Asking
 * for more is a 400 or a 403, too fast a 429 — and any of them sends the catalogue back
 * to MetaDAO's treasuries. So pages of ten, one request at a time, a pause between them,
 * and one more try after a 429.
 */
const RESOLVED_PAGE = 10
const RESOLVED_MAX_PAGES = 3
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

async function resolvedPage(path, key, page) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${RESOLVED_API}/${path}?limit=${RESOLVED_PAGE}&page=${page}`, {
      headers: { 'x-api-key': key, accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 429 && attempt === 0) { await pause(3_000); continue }
    if (!res.ok) throw new Error(`01resolved ${res.status} on ${path}`)
    return res.json()
  }
}

/**
 * 01Resolved's figures, read at most every RESOLVED_REFRESH_MS through `cache` (async
 * get/set; KV in the Worker). The plan allows 500 requests a month, and a read is six:
 * every ten minutes spent the month in a day (28 Sep 2026). When a read fails the last
 * good copy is kept, however old: last month's treasury beats MetaDAO's zero.
 */
const RESOLVED_REFRESH_MS = 12 * 60 * 60 * 1000

async function resolvedData(key, cache) {
  const stored = cache ? await cache.get().catch(() => null) : null
  if (stored && Date.now() - stored.at < RESOLVED_REFRESH_MS) return stored
  try {
    const projects = await resolvedPages('projects-launch', key)
    await pause(1_200)
    const launches = await resolvedPages('completed-launches/info', key)
    const fresh = { at: Date.now(), projects, launches }
    await cache?.set(fresh).catch(() => {})
    return fresh
  } catch (e) {
    if (stored) {
      console.error(`01resolved unavailable (${e.message}); using its figures from ${new Date(stored.at).toISOString()}`)
      return stored
    }
    throw e
  }
}

async function resolvedPages(path, key) {
  const rows = []
  for (let page = 1; page <= RESOLVED_MAX_PAGES; page++) {
    if (page > 1) await pause(1_200)
    const body = await resolvedPage(path, key, page)
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
        // Percent, not a fraction: 15.6 means up 15.6%. Drives the pump posts.
        priceChange24h: num(project.tokenPriceChangePercentage24h),
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
  const unit = tokenUnit(mint)
  const amount = Math.floor((usd / usdPrice) * unit)
  try {
    const q = await jup(JUP.quote, { inputMint: mint, outputMint: USDC, amount, slippageBps: 50 })
    const received = Number(q.outAmount) / 1e6 // USDC
    return {
      usd,
      received,
      lossPct: (received / (amount / unit) / usdPrice - 1) * 100,
      venues: [...new Set((q.routePlan ?? []).map((r) => r.swapInfo.label))],
    }
  } catch {
    return { usd, received: null, lossPct: null, venues: [] } // no route at this size
  }
}

/**
 * A hand-listed backing coin, in the catalogue's shape.
 *
 * Its `treasury` is what backs it, so the numbers that sort and compare coins keep
 * working; `backing` says what that is, and the screens name it instead of calling it
 * a treasury. Priced by the market once Jupiter has one, by its reference price until
 * then — and `priceSource` says which, so nobody reads a raise price as a quote.
 */
export function extraCoin(q, found) {
  const market = found?.usdPrice > 0 ? found.usdPrice : 0
  return {
    mint: q.mint,
    symbol: q.symbol,
    name: q.name,
    decimals: q.decimals,
    usdPrice: market || q.referencePrice || 0,
    priceSource: market ? 'market' : 'reference',
    liquidity: found?.liquidity ?? 0,
    treasury: q.backing?.usd ?? 0,
    treasuryVault: null,
    volume24h: 0,
    pool: null,
    since: null,
    icon: q.icon ?? found?.icon ?? null,
    holders: found?.holders ?? 0,
    mcap: found?.mcap ?? 0,
    exits: [],
    featured: Boolean(q.featured),
    backing: q.backing ?? null,
    financials: null,
    theme: q.theme ?? 'ownership',
    opens: q.opens ?? null,
    native: Boolean(q.native),
    token2022: Boolean(q.token2022),
    holderShare: q.holderShare !== false,
  }
}

/**
 * The catalogue. A DAO whose treasury is gone has nothing backing a pair, so it is
 * not offered as a backing asset — that is the one exclusion, and it is about
 * backing, not size. Exit costs are priced separately, on demand.
 */
/**
 * `keep`: mints LFOwn has already paired memes with. They stay listed below the treasury
 * floor, since MetaDAO's treasury figure can be wrong and dropping a coin drops its memes.
 */
export async function buildRegistry(_endpoint, { withExits = false, resolvedKey, resolvedCache, keep = new Set() } = {}) {
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
    // The treasury floor is applied at the end, once 01Resolved has had its say: MetaDAO's
    // own figure can be wrong (SOLO, 29 Sep 2026: $0.05 for a coin with $1.8M of liquidity),
    // and a coin dropped here takes every meme launched against it off the site.
    .filter((d) => d.usdPrice > 0)

  // Icons and holder counts only exist on Jupiter's side.
  const extra = new Map()
  const mints = [...daos.map((d) => d.mint), ...EXTRA_QUOTES.map((q) => q.mint)]
  for (let i = 0; i < mints.length; i += 20) {
    try {
      const found = await jup(JUP.tokens, { query: mints.slice(i, i + 20).join(',') })
      for (const t of found) {
        extra.set(t.id, {
          icon: t.icon, holders: t.holderCount ?? 0, mcap: t.mcap ?? 0,
          decimals: t.decimals, usdPrice: Number(t.usdPrice) || 0, liquidity: Number(t.liquidity) || 0,
        })
      }
    } catch { /* the catalogue is still usable without decoration */ }
  }

  const coins = []
  for (const d of daos) {
    const { decimals, usdPrice: _, liquidity: __, ...decoration } = extra.get(d.mint) ?? { icon: null, holders: 0, mcap: 0 }
    // Every amount of a backing coin is scaled by 6 decimals unless it is listed by hand.
    // An ownership coin minted any other way would be mispriced a thousandfold on every
    // trade, so it is left out rather than offered.
    if (decimals !== undefined && decimals !== COIN_DECIMALS) {
      console.error(`registry: ${d.symbol} has ${decimals} decimals, not ${COIN_DECIMALS}; not offered`)
      continue
    }
    coins.push({
      ...d,
      decimals: COIN_DECIMALS,
      ...decoration,
      exits: withExits ? await Promise.all(EXIT_SIZES.map((s) => exitCost(d.mint, d.usdPrice, s))) : [],
      theme: 'ownership',
    })
  }

  for (const q of EXTRA_QUOTES) coins.push(extraCoin(q, extra.get(q.mint)))

  let listed = coins
  if (resolvedKey) {
    try {
      const { projects, launches } = await resolvedData(resolvedKey, resolvedCache)
      listed = withFinancials(coins, projects, launches)
    } catch (e) {
      console.error(`01resolved unavailable, keeping MetaDAO's treasuries: ${e.message}`)
    }
  }

  // The treasury floor is about ownership coins, whose treasury is what backs them; a
  // Solana major is backed by its market instead.
  listed = listed.filter((d) => (d.theme && d.theme !== 'ownership') || d.treasury >= MIN_TREASURY_USD || keep.has(d.mint))
  // Featured coins lead; the rest by what backs them.
  listed.sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || b.treasury - a.treasury)
  return { updatedAt: new Date().toISOString(), count: listed.length, coins: listed }
}
