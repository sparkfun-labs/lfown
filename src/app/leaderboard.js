// LFOwn — who has generated the most in trading fees.
//
// Nothing here is read from chain. /api/fees already walks every pool and every
// graduated position for the coin pages, and each row now carries the wallet that
// opened it; the ranking is that same report grouped by creator. So the leaderboard
// cannot drift from the figures printed on a coin's own page — there is only ever
// one set of numbers, sliced two ways.

import { esc } from './escape.js'
import { TREASURY } from './treasury.js'

const view = document.querySelector('#view')
const fmt = (n, d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d })

/** Dollars, to the cent under a dollar and whole above it — as on /coins. */
const usd = (n) => {
  const v = Number(n) || 0
  if (v && Math.abs(v) < 0.005) return '<$0.01'
  return Math.abs(v) < 1 ? '$' + v.toFixed(2) : '$' + fmt(v, 0)
}

/**
 * Figures that have to add up, formatted alike: generated is kept + the DAO's share,
 * and rounding each to its own precision would print two cents' worth of parts under
 * a whole-dollar total.
 */
function usdGroup(parts) {
  const cents = parts.some((v) => Math.abs(Number(v) || 0) < 1)
  const round = (v) => (cents ? Math.round((Number(v) || 0) * 100) / 100 : Math.round(Number(v) || 0))
  return { round, show: (v) => (cents ? '$' + round(v).toFixed(2) : '$' + fmt(round(v), 0)) }
}

const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`
// The wallet's own page here, not an explorer: a ranking whose rows lead off the
// site is a ranking nobody explores. Solscan is one click further, on that page.
const creatorPage = (a) => `/creator/${encodeURIComponent(a)}`

/** The report's coins, gathered under the wallets that launched them. */
function rank(report) {
  const wallets = new Map()
  for (const c of report?.coins ?? []) {
    const key = c.creatorWallet
    // A row from an older cached report has no wallet on it. Dropping it is better
    // than inventing an "unknown" seat at the top of the table.
    if (!key) continue
    const seat = wallets.get(key) ?? {
      wallet: key, generatedUsd: 0, keptUsd: 0, daoUsd: 0, graduated: 0, coins: [],
    }
    // `c.creator` is the creator's share in quote tokens, not an address —
    // `c.creatorWallet` is the address. One word, two meanings, three lines apart.
    seat.keptUsd += (Number(c.creator) || 0) * (Number(c.quoteUsdPrice) || 0)
    seat.daoUsd += Number(c.lfownUsd) || 0
    seat.generatedUsd += Number(c.totalUsd) || 0
    if (c.graduated) seat.graduated++
    seat.coins.push({
      symbol: c.symbol ?? '?', baseMint: c.baseMint,
      usd: Number(c.totalUsd) || 0, graduated: Boolean(c.graduated),
    })
    wallets.set(key, seat)
  }
  const seats = [...wallets.values()]
  for (const s of seats) s.coins.sort((a, b) => b.usd - a.usd)
  seats.sort((a, b) => b.generatedUsd - a.generatedUsd || b.coins.length - a.coins.length)
  return seats
}

const chips = (coins) => coins.map((c) =>
  `<a class="${c.graduated ? 'grad' : ''}" href="/coins/${esc(c.baseMint)}" title="${esc(c.symbol)} — ${esc(usd(c.usd))} in fees">${esc(c.symbol)}</a>`
).join('')

/** One of the top three, with its own numeral bled into the corner. */
function seat(s, place) {
  const money = usdGroup([s.keptUsd, s.daoUsd])
  return `<li class="seat">
    <div class="rk">${String(place).padStart(2, '0')}</div>
    <a class="who" href="${esc(creatorPage(s.wallet))}" title="${esc(s.wallet)}">
      <span class="addr">${esc(short(s.wallet))}</span>
    </a>
    <div>
      <span class="lab">Fees generated</span>
      <div class="gen">${money.show(money.round(s.keptUsd) + money.round(s.daoUsd))}</div>
    </div>
    <div class="chips">${chips(s.coins)}</div>
    <dl class="split">
      <div><dt class="lab">Kept</dt><dd>${money.show(s.keptUsd)}</dd></div>
      <div><dt class="lab">To the LFOwn DAO</dt><dd>${money.show(s.daoUsd)}</dd></div>
      <div><dt class="lab">Coins</dt><dd>${s.coins.length}${s.graduated ? ` · ${s.graduated} graduated` : ''}</dd></div>
    </dl>
  </li>`
}

/** Everyone below the podium, as a plain ranked table. */
function row(s, place) {
  const money = usdGroup([s.keptUsd, s.daoUsd])
  return `<tr>
    <td class="n">${String(place).padStart(2, '0')}</td>
    <td>
      <a class="who" href="${esc(creatorPage(s.wallet))}" title="${esc(s.wallet)}">${esc(short(s.wallet))}</a>
      <div class="chips">${chips(s.coins)}</div>
    </td>
    <td class="num">${s.coins.length}${s.graduated ? `<span class="sub">${s.graduated} graduated</span>` : ''}</td>
    <td class="num"><b>${money.show(money.round(s.keptUsd) + money.round(s.daoUsd))}</b></td>
    <td class="num">${money.show(s.keptUsd)}</td>
    <td class="num">${money.show(s.daoUsd)}</td>
  </tr>`
}

function paint(report) {
  const seats = rank(report)
  if (!seats.length) {
    view.innerHTML = `<h1>Leaderboard</h1>
      <p class="lede">The wallets whose coins have generated the most in trading fees.</p>
      <p class="skel">Nothing launched yet. <a href="/launch">Be the first</a>.</p>`
    return
  }

  const t = report.totals ?? {}
  const money = usdGroup([t.creatorUsd, t.lfownUsd])
  // A wallet that launched a coin nobody has traded belongs in the table, but not on
  // a podium — third place with nothing earned reads as a ranking of nobody.
  const earning = seats.filter((s) => s.generatedUsd > 0)
  const top = earning.slice(0, 3)
  const rest = seats.slice(top.length)

  view.innerHTML = `<h1>Leaderboard</h1>
    <p class="lede">Every coin charges a trading fee, split between whoever launched it and the
      LFOwn DAO. This is the same ledger as the coins page, gathered under the wallets that opened them.</p>

    <div class="totals">
      <div class="tot"><span class="lab">Wallets ranked</span><span class="big">${seats.length}</span></div>
      <div class="tot"><span class="lab">Fees generated</span><span class="big">${money.show(money.round(t.creatorUsd) + money.round(t.lfownUsd))}</span></div>
      <div class="tot"><span class="lab">To creators</span><span class="big">${money.show(t.creatorUsd)}</span></div>
      <a class="tot link" href="${TREASURY}" target="_blank" rel="noopener"><span class="lab">To the LFOwn DAO ↗</span><span class="big">${money.show(t.lfownUsd)}</span></a>
    </div>

    ${top.length ? `<ol class="podium">${top.map((s, i) => seat(s, i + 1)).join('')}</ol>` : ''}

    ${rest.length ? `
      <div class="rest-head">
        <h2>The field <span class="count">${rest.length}</span></h2>
        <p>Ranked by what their coins have generated in total.</p>
      </div>
      <div class="board-wrap">
        <table class="board">
          <thead><tr>
            <th>#</th><th>Wallet</th>
            <th class="num">Coins</th><th class="num">Generated</th>
            <th class="num">Kept</th><th class="num">To the DAO</th>
          </tr></thead>
          <tbody>${rest.map((s, i) => row(s, top.length + i + 1)).join('')}</tbody>
        </table>
      </div>` : ''}

    <p class="foot-note">Fees generated is what the creator and the DAO have earned together —
      claimed and unclaimed, on the curve and in the graduated pool. Meteora's own cut is taken
      off the top and reaches neither, so it is not counted here.
      ${report.updatedAt ? `Read ${esc(new Date(report.updatedAt).toLocaleString('en-US', { timeStyle: 'short', dateStyle: 'medium' }))}.` : ''}</p>`
}

async function load() {
  let report
  try {
    report = await fetch('/api/fees').then((r) => r.json())
  } catch (e) {
    console.error('fee report unavailable:', e.message)
    view.innerHTML = '<h1>Leaderboard</h1><p class="skel">The fee report is not answering. Try again in a moment.</p>'
    return
  }
  paint(report)
  // The very first read after a deploy has nothing cached and the report is built
  // behind the response, so an empty answer here is "not yet", not "nobody".
  if (report?.pending) setTimeout(load, 6000)
}

load()
