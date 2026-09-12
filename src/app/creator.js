// LFOwn — one creator's public record.
//
// The same ledger the leaderboard ranks and the profile page claims from, narrowed
// to one wallet and stripped of anything private. No wallet connection, no RPC: the
// two cached endpoints already hold everything, which is why this page is a few
// kilobytes and opens instantly.

import { esc, safeUrl } from './escape.js'

const view = document.querySelector('#view')
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d })
const usd = (n) => {
  const v = Number(n) || 0
  if (v && Math.abs(v) < 0.005) return '<$0.01'
  return Math.abs(v) < 1 ? '$' + v.toFixed(2) : '$' + fmt(v, 0)
}
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`

/**
 * Figures that have to add up, formatted alike — generated is kept plus the DAO's
 * share, and rounding each to its own precision prints parts that contradict a total.
 */
function usdGroup(parts) {
  const cents = parts.some((v) => Math.abs(Number(v) || 0) < 1)
  const round = (v) => (cents ? Math.round((Number(v) || 0) * 100) / 100 : Math.round(Number(v) || 0))
  return { round, show: (v) => (cents ? '$' + round(v).toFixed(2) : '$' + fmt(round(v), 0)) }
}

/** The image lives in the metadata JSON the launch published, not on chain. */
async function artwork(coin) {
  if (coin.image !== undefined) return coin.image
  coin.image = null
  try {
    if (coin.uri) coin.image = (await fetch(coin.uri).then((r) => r.json())).image || null
  } catch { /* a dead uri is not worth a broken page */ }
  return coin.image
}

function card(c, earned) {
  const raised = Number(c.quoteReserve) / 1e6
  const pct = c.isMigrated ? 100 : c.threshold ? Math.min(100, (raised / c.threshold) * 100) : 0
  const a = document.createElement('a')
  a.className = 'coin'
  a.href = `/coins/${esc(c.baseMint)}`
  a.innerHTML = `
    <div class="top">
      <img alt="">
      <div>
        <div class="nm">${esc(c.symbol ?? '—')}</div>
        <div class="pair">${esc(c.name ?? '')} · paired with ${esc(c.quoteSymbol)}</div>
      </div>
    </div>
    <div class="progress"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="meta">
      <span>${fmt(raised)} ${esc(c.quoteSymbol)} raised</span>
      <span>${c.isMigrated ? 'graduated' : `${pct.toFixed(0)}% of target`}</span>
    </div>
    ${earned ? `<div class="meta earned"><span>${usd(earned.totalUsd)} in fees</span><span>${usd(earned.lfownUsd)} to the DAO</span></div>` : ''}`
  artwork(c).then((src) => { if (src) a.querySelector('img').src = safeUrl(src) })
  return a
}

function shell(inner) {
  view.innerHTML = `<a class="back" href="/leaderboard">← Leaderboard</a>${inner}`
}

async function render() {
  const wallet = decodeURIComponent(location.pathname.replace(/^\/creator\/?/, '')).trim()
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    shell(`<h1>Creator</h1><p class="skel">That is not a wallet address. <a href="/leaderboard">See the leaderboard</a>.</p>`)
    return
  }

  shell(`<h1>${esc(short(wallet))}</h1><p class="skel">Reading the ledger…</p>`)

  const [list, report] = await Promise.all([
    fetch('/api/launches').then((r) => r.json()).catch(() => ({ launches: [] })),
    fetch('/api/fees').then((r) => r.json()).catch(() => null),
  ])
  const mine = (list.launches ?? []).filter((l) => l.creator === wallet)
  const earned = new Map((report?.coins ?? []).map((c) => [c.baseMint, c]))

  if (!mine.length) {
    shell(`<h1>${esc(short(wallet))}</h1>
      <p class="who">${esc(wallet)} · <a href="https://solscan.io/account/${esc(wallet)}" target="_blank" rel="noopener">Solscan ↗</a></p>
      <p class="skel">This wallet has not launched anything here.</p>`)
    return
  }

  // Their half of what their coins took, and the DAO's — the same two numbers the
  // leaderboard ranks on, so a creator's page and their rank cannot disagree.
  let kept = 0
  let dao = 0
  for (const c of mine) {
    const row = earned.get(c.baseMint)
    kept += (row?.creator ?? 0) * (row?.quoteUsdPrice ?? 0)
    dao += row?.lfownUsd ?? 0
  }
  const money = usdGroup([kept, dao])
  const graduated = mine.filter((c) => c.isMigrated)
  mine.sort((a, b) => (earned.get(b.baseMint)?.totalUsd ?? 0) - (earned.get(a.baseMint)?.totalUsd ?? 0))

  shell(`
    <h1>${esc(short(wallet))}</h1>
    <p class="who">${esc(wallet)} · <a href="https://solscan.io/account/${esc(wallet)}" target="_blank" rel="noopener">Solscan ↗</a></p>
    <p class="lede">Everything this wallet has launched on LFOwn, and what those coins have taken in trading fees.</p>

    <div class="totals">
      <div class="tot"><span class="lab">Coins launched</span><span class="big">${mine.length}</span></div>
      <div class="tot"><span class="lab">Graduated</span><span class="big">${graduated.length}</span></div>
      <div class="tot"><span class="lab">Fees generated</span><span class="big">${money.show(money.round(kept) + money.round(dao))}</span></div>
      <div class="tot"><span class="lab">To this creator</span><span class="big">${money.show(kept)}</span></div>
    </div>

    <div class="sec-head"><h2>Their coins <span class="count">${mine.length}</span></h2></div>
    <div class="grid" id="grid"></div>

    <p class="foot-note">Fees generated is what each coin has taken, claimed and unclaimed, on the curve and in
      the graduated pool — split evenly between the creator and the
      <a href="/leaderboard">LFOwn DAO</a>. Nothing here is private: it is all on chain.</p>`)

  const grid = document.querySelector('#grid')
  for (const c of mine) grid.appendChild(card(c, earned.get(c.baseMint)))
}

render()
window.addEventListener('popstate', render)
