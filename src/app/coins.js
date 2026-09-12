// LFOwn — the coins that have launched, and trading them on the curve.

import { available, connect, reconnect, forget, showIcon } from './wallet.js'
import { esc, safeUrl } from './escape.js'
import { explain } from './errors.js'
import { TREASURY } from './treasury.js'

const $ = (s) => document.querySelector(s)
const view = $('#view')
const fmt = (n, d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d })
/**
 * Dollars, to the cent under a dollar and whole above it.
 *
 * Four decimals on a fee of $0.8439 was reporting a precision nobody needs and
 * nobody reads. The one exception is real money that rounds to nothing: showing
 * $0.00 for an amount that exists would be a different kind of wrong.
 */
const usd = (n) => {
  const v = Number(n) || 0
  if (v && Math.abs(v) < 0.005) return '<$0.01'
  return Math.abs(v) < 1 ? '$' + v.toFixed(2) : '$' + fmt(v, 0)
}

/**
 * Figures that have to add up, formatted alike.
 *
 * Rounding each to its own precision put $0.84 and $0.85 underneath a total of $2:
 * the parts were shown to the cent and their sum to the dollar. The precision is
 * taken from the parts, so a column reconciles at whatever scale it is read.
 */
function usdGroup(parts) {
  const cents = parts.some((v) => Math.abs(Number(v) || 0) < 1)
  const round = (v) => (cents ? Math.round((Number(v) || 0) * 100) / 100 : Math.round(Number(v) || 0))
  return { round, show: (v) => (cents ? '$' + round(v).toFixed(2) : '$' + fmt(round(v), 0)) }
}
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`

// The theme is handled by the header's own script: there are two toggles now, one
// in the bar and one in the drawer, and binding a single id here would have left
// the drawer's dead.

// ── wallet ───────────────────────────────────────────────────────────────────
let session = null

/**
 * Whatever on the page depends on who is connected: the fee panel, and the balance
 * under the pay-with row. Registered by the view and called when the session really
 * changes — approving in a wallet takes as long as it takes, so nothing here may
 * guess at a delay. Each view clears the list before it registers its own.
 */
const sessionHooks = new Map()
const clearSessionHooks = () => sessionHooks.clear()
// Keyed: the fee panel repaints after every trade, and a list would grow a fresh
// copy of its own hook each time until one click ran it a dozen times.
const onSession = (key, fn) => sessionHooks.set(key, fn)
const sessionChanged = () => {
  for (const fn of sessionHooks.values()) {
    try { fn() } catch (e) { console.error('session hook failed:', e.message) }
  }
}

const connectBtn = $('#connect')
const menu = $('#wallet-menu')

function chooseWallet(found) {
  if (found.length === 1) return Promise.resolve(found[0])
  const dialog = $('#wallet-picker')
  const list = $('#wallet-list')
  list.innerHTML = ''
  return new Promise((resolve, reject) => {
    for (const w of found) {
      const li = document.createElement('li')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.innerHTML = `<span class="blank"></span><span>${esc(w.name)}</span>`
      showIcon(btn.firstElementChild, w.icon)
      btn.addEventListener('click', () => { dialog.close(); resolve(w) })
      li.appendChild(btn)
      list.appendChild(li)
    }
    $('#picker-close').onclick = () => dialog.close()
    dialog.addEventListener('close', () => reject(new Error('Wallet choice cancelled.')), { once: true })
    dialog.showModal()
  })
}

async function ensureWallet() {
  if (session) return session
  const found = available()
  if (!found.length) throw new Error('No Solana wallet found in this browser.')
  session = await connect(await chooseWallet(found))
  paintConnect()
  sessionChanged()
  return session
}

function paintConnect() {
  if (session) {
    connectBtn.textContent = short(session.address)
    connectBtn.title = `${session.name} — ${session.address}`
    connectBtn.disabled = false
    return
  }
  menu.hidden = true
  const found = available()
  connectBtn.textContent = found.length ? 'Connect wallet' : 'No wallet found'
  connectBtn.disabled = !found.length
}

connectBtn.addEventListener('click', async () => {
  if (session) { menu.hidden = !menu.hidden; return }
  connectBtn.textContent = 'Connecting…'
  try { await ensureWallet() } catch (e) { connectBtn.textContent = e.message }
  paintConnect()
})
menu.addEventListener('click', async (e) => {
  const act = e.target.dataset?.act
  if (!act || !session) return
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(session.address); e.target.textContent = 'Copied' } catch { e.target.textContent = 'Copy failed' }
    setTimeout(() => { e.target.textContent = 'Copy address' }, 1200)
    return
  }
  try { await session.disconnect?.() } catch {}
  forget()
  session = null
  menu.hidden = true
  paintConnect()
  sessionChanged()
})
document.addEventListener('click', (e) => { if (!e.target.closest('.wallet-slot')) menu.hidden = true })
window.addEventListener('wallet-standard:register-wallet', () => setTimeout(paintConnect, 0))

// ── data ─────────────────────────────────────────────────────────────────────
let cache = null
async function launches() {
  if (!cache) cache = (await fetch('/api/launches').then((r) => r.json())).launches ?? []
  return cache
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

// ── list ─────────────────────────────────────────────────────────────────────
/** One card. Artwork and fee figures arrive later and fill themselves in. */
function coinCard(c) {
  const raised = Number(c.quoteReserve) / 1e6
  const pct = c.isMigrated
    ? 100
    : c.threshold ? Math.min(100, (raised / c.threshold) * 100) : 0

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
    <div class="meta earned" data-mint="${esc(c.baseMint)}"></div>`

  artwork(c).then((src) => { if (src) a.querySelector('img').src = safeUrl(src) })
  const earned = feesByMint.get(c.baseMint)
  if (earned) {
    a.querySelector('.earned').innerHTML =
      `<span>${usd(earned.totalUsd)} in fees</span><span>${usd(earned.lfownUsd)} to the DAO</span>`
  }
  return a
}

/** A titled block of cards, or nothing at all when there are none to show. */
/**
 * How each sort key reads a coin. `fees` comes from the report, which lands after
 * the cards do — the list re-sorts itself when it arrives.
 */
const SORTS = {
  new: { label: 'Newest', of: (c) => c.activationPoint ?? 0 },
  fees: { label: 'Fees', of: (c) => feesByMint.get(c.baseMint)?.totalUsd ?? 0 },
  raised: { label: 'Raised', of: (c) => (Number(c.quoteReserve) / 1e6) * (c.quoteUsdPrice ?? 0) },
  progress: {
    label: 'Progress',
    of: (c) => (c.isMigrated ? 1 : c.threshold ? Math.min(1, Number(c.quoteReserve) / 1e6 / c.threshold) : 0),
  },
}

// One set of controls for the whole page, so the state lives here rather than in
// either section. Kept outside the render: the fee report repaints the list, and
// sorting it should not come undone underneath the person who did it.
const listState = { pair: '', key: 'new', desc: true }

/**
 * A dropdown in the site's own clothes.
 *
 * A native `<select>` draws its open list with the operating system — rounded,
 * blue, ticked — and no stylesheet can reach inside it. The closed control looked
 * right and the open one looked like it belonged to another site, so the list is
 * built here instead: same border, same hard shadow, same red hover as the wallet
 * menu it sits under.
 */
function dropdown({ value, options, label, onPick }) {
  const el = document.createElement('div')
  el.className = 'drop'
  const chosen = options.find((o) => o.value === value) ?? options[0]
  el.innerHTML = `
    <button class="drop-btn" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}">
      <span>${esc(chosen.label)}</span><i>▾</i>
    </button>
    <ul class="drop-list" role="listbox" hidden>
      ${options.map((o) => `<li><button type="button" role="option" data-value="${esc(o.value)}"
        aria-selected="${String(o.value === value)}">${esc(o.label)}</button></li>`).join('')}
    </ul>`

  const btn = el.querySelector('.drop-btn')
  const list = el.querySelector('.drop-list')
  const open = (on) => { list.hidden = !on; btn.setAttribute('aria-expanded', String(on)) }

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    // Only one open at a time, or two lists overlap and neither can be read.
    document.querySelectorAll('.drop-list').forEach((other) => { if (other !== list) other.hidden = true })
    open(list.hidden)
  })
  list.addEventListener('click', (e) => {
    const pick = e.target.closest('button[data-value]')
    if (!pick) return
    open(false)
    onPick(pick.dataset.value)
  })
  return el
}
document.addEventListener('click', () => document.querySelectorAll('.drop-list').forEach((l) => { l.hidden = true }))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.drop-list').forEach((l) => { l.hidden = true })
})

/** The one control bar: what to show, in what order. */
function controls(coins, onChange) {
  const pairs = [...new Set(coins.map((c) => c.quoteSymbol))].sort()
  const bar = document.createElement('div')
  bar.className = 'list-controls'

  bar.appendChild(dropdown({
    value: listState.pair, label: 'Filter by the coin it is paired with',
    options: [{ value: '', label: 'All pairs' }, ...pairs.map((p) => ({ value: p, label: p }))],
    onPick: (v) => { listState.pair = v; onChange() },
  }))

  const sorter = document.createElement('div')
  sorter.className = 'sorter'
  sorter.appendChild(dropdown({
    value: listState.key, label: 'Sort by',
    options: Object.entries(SORTS).map(([value, s]) => ({ value, label: s.label })),
    onPick: (v) => { listState.key = v; onChange() },
  }))
  const dir = document.createElement('button')
  dir.type = 'button'
  dir.className = 'sort-dir'
  dir.setAttribute('aria-label', 'Reverse the order')
  dir.textContent = listState.desc ? '▼' : '▲'
  dir.addEventListener('click', () => { listState.desc = !listState.desc; onChange() })
  sorter.appendChild(dir)
  bar.appendChild(sorter)
  return bar
}

/** A titled block of cards, ordered and filtered by the shared controls. */
function section(parent, title, coins) {
  const of = SORTS[listState.key].of
  const shown = coins
    .filter((c) => !listState.pair || c.quoteSymbol === listState.pair)
    .sort((a, b) => (listState.desc ? of(b) - of(a) : of(a) - of(b)))
  if (!shown.length) return

  const wrap = document.createElement('section')
  wrap.className = 'coin-section'
  wrap.innerHTML = `
    <div class="section-head">
      <h2>${esc(title)} <span class="count">${shown.length}</span></h2>
    </div>
    <div class="grid"></div>`
  const grid = wrap.querySelector('.grid')
  for (const c of shown) grid.appendChild(coinCard(c))
  parent.appendChild(wrap)
}

async function renderList() {
  clearSessionHooks()
  view.innerHTML = `<h1>Ownership memes</h1>
    <p class="lede">Every coin launched here, each paired with an ownership coin that has a treasury behind it.</p>
    <div class="totals" id="totals"></div>
    <div id="sections"><p class="skel">Loading…</p></div>`

  paintTotals()

  const coins = await launches()
  const box = $('#sections')
  if (!coins.length) {
    box.innerHTML = '<p class="skel">Nothing launched yet. <a href="/launch">Be the first</a>.</p>'
    return
  }

  // Two different things wearing the same card. One is still being bought on its
  // curve and its bar means something; the other filled its bar days ago and now
  // trades somewhere else entirely. Mixed together, a full bar read as a live coin.
  // Two different things wearing the same card, so they keep their own headings —
  // but one set of controls above both, because filtering to a pair and then having
  // to do it twice is not a filter, it is two.
  paintSections = () => {
    box.innerHTML = ''
    box.appendChild(controls(coins, () => paintSections()))
    section(box, 'Graduated', coins.filter((c) => c.isMigrated))
    section(box, 'On the curve', coins.filter((c) => !c.isMigrated))
    if (!box.querySelector('.coin')) {
      box.insertAdjacentHTML('beforeend', `<p class="skel">Nothing paired with ${esc(listState.pair)}.</p>`)
    }
  }
  paintSections()
}

/**
 * What every coin has generated, and how it split. Shown to everyone: these numbers
 * are on chain, and a launchpad that publishes creators' fees while hiding its own
 * would be picking which truths to tell.
 */
async function paintTotals() {
  const box = $('#totals')
  let report
  try {
    report = await fetch('/api/fees').then((r) => r.json())
  } catch { return }
  if (!report?.totals?.generatedUsd) return

  const { generatedUsd, lfownUsd, creatorUsd } = report.totals
  const money = usdGroup([creatorUsd, lfownUsd])
  feesByMint = new Map(report.coins.map((c) => [c.baseMint, c]))
  box.innerHTML = `
    <div class="tot"><span class="lab">Fees generated</span><span class="big">${money.show(money.round(creatorUsd) + money.round(lfownUsd))}</span></div>
    <div class="tot"><span class="lab">To creators</span><span class="big">${money.show(creatorUsd)}</span></div>
    <a class="tot link" href="${TREASURY}" target="_blank" rel="noopener"><span class="lab">To the LFOwn DAO ↗</span><span class="big">${money.show(lfownUsd)}</span></a>`

  // The report lands after the cards are drawn, so fill in the lines it feeds.
  for (const [mint, earned] of feesByMint) {
    const slot = document.querySelector(`.earned[data-mint="${CSS.escape(mint)}"]`)
    if (slot) slot.innerHTML = `<span>${usd(earned.totalUsd)} in fees</span><span>${usd(earned.lfownUsd)} to the DAO</span>`
  }
  // And a list ordered by a figure that did not exist yet was ordered on zeroes.
  if (listState.key === 'fees') paintSections?.()
}

let feesByMint = new Map()
// Set by renderList, so the fee report can reorder what it just filled in.
let paintSections = null

// ── detail ───────────────────────────────────────────────────────────────────
async function renderCoin(mint) {
  clearSessionHooks()
  view.innerHTML = '<p class="skel">Loading coin…</p>'

  // Everything that does not depend on anything else is started at once, and only
  // what the first paint genuinely needs is waited on. The page used to wait for the
  // fee report — seven seconds whenever its cache had just turned over — before
  // drawing a single pixel of a coin it already had in hand.
  const code = import('./trade.js')
  // Paying in SOL or USDC is a Jupiter swap into the ownership coin, landed before
  // the curve trade. funding.js explains why the two cannot share a transaction.
  const money = import('./funding.js')
  const report = feesByMint.size
    ? Promise.resolve(null)
    : fetch('/api/fees').then((r) => r.json()).catch((e) => {
        console.error('fee report unavailable:', e.message)
        return null
      })

  // Straight from chain, not from the cached list: a coin launched moments ago is
  // not in the catalogue yet, and its own page has no business refusing to open.
  let coin = (await launches()).find((c) => c.baseMint === mint)
  if (!coin) {
    const res = await fetch(`/api/launch/${mint}`)
    if (!res.ok) {
      view.innerHTML = '<p class="skel">No pool for this mint. <a href="/coins">Back to the list</a>.</p>'
      return
    }
    coin = await res.json()
  }

  const { loadPool, quote, buildSwap, creatorFees, buildClaimAll,
          graduatedFees, connection } = await code
  let state
  try { state = await loadPool(coin.pool) } catch (e) {
    view.innerHTML = `<p class="skel">Could not read the pool: ${esc(explain(e, 'loading pool'))}</p>`
    return
  }

  const { PAY_WITH, payWith, quoteSwap, buildSwapTx, balanceOf,
          GAS_RESERVE, COIN_DECIMALS } = await money
  view.innerHTML = `
    <a class="back" href="/coins">← All coins</a>
    <div class="detail">
      <section class="panel">
        <div class="coin-head">
          <img alt="" hidden>
          <div>
            <h2>${esc(coin.symbol ?? '—')}</h2>
            <div class="pair" style="font-family:var(--mono);font-size:.58rem;letter-spacing:.14em;text-transform:uppercase;color:var(--red);margin-top:6px">
              ${esc(coin.name ?? '')} · paired with ${esc(coin.quoteSymbol)}
            </div>
          </div>
        </div>
        <div class="progress"><i id="bar-fill" style="width:${(state.progress * 100).toFixed(1)}%"></i></div>
        <dl class="stats">
          <div><dt>Raised</dt><dd id="stat-raised">${fmt(state.raised)} / ${fmt(state.threshold)} ${esc(coin.quoteSymbol)}</dd></div>
          <div><dt>Progress</dt><dd id="stat-progress">${(state.progress * 100).toFixed(1)}%</dd></div>
          <div><dt>Price</dt><dd id="stat-price">${state.price.toPrecision(4)} ${esc(coin.quoteSymbol)}</dd></div>
          <div><dt>Status</dt><dd>${state.isMigrated ? 'graduated to DAMM v2' : 'on the curve'}</dd></div>
        </dl>
        <p class="addr">mint ${esc(coin.baseMint)}<br>pool ${esc(coin.pool)}</p>
        <div id="creator-fees"></div>
      </section>

      <section class="panel accent trade">
        <div class="tabs">
          <button type="button" data-side="buy" aria-pressed="true">Buy</button>
          <button type="button" data-side="sell" aria-pressed="false">Sell</button>
        </div>
        <span class="lab pay-lab" id="pay-lab" hidden>Receive in</span>
        <div class="pay" id="pay-with" hidden></div>
        <div class="amount-head">
          <label class="lab" id="amount-label" for="amount">Amount in ${esc(coin.quoteSymbol)}</label>
          <span class="held" id="pay-line" hidden></span>
        </div>
        <div class="amount-field">
          <input id="amount" type="number" min="0" step="any" placeholder="0.0">
          <button class="max" type="button" id="amount-max" hidden>Max</button>
        </div>
        <div class="quote" id="quote-out">Enter an amount.</div>
        <button class="btn" id="do-trade" disabled>Buy ${esc(coin.symbol)}</button>
        <p class="hint" id="trade-status" style="margin-top:12px;font-size:.85rem;color:var(--ink-soft)"></p>
        <a class="btn ghost jup" id="jup-link" href="https://jup.ag/swap?sell=${esc(coin.quoteMint)}&buy=${esc(coin.baseMint)}" target="_blank" rel="noopener">Buy on Jupiter ↗</a>
      </section>
    </div>

    <section class="panel chart" id="chart"></section>`

  // The picture lives behind another request. The panel is drawn with the slot
  // empty and the image dropped in when it lands, rather than holding the page back.
  artwork(coin).then((src) => {
    const slot = view.querySelector('.coin-head img')
    if (src && slot) { slot.src = safeUrl(src); slot.hidden = false }
  })

  paintChart(coin, state)

  // The fee report is the slowest thing on this page by a wide margin, so the panel
  // is drawn from what the pool already knows and redrawn once the report lands.
  paintFees(coin, state, { creatorFees, buildClaimAll, graduatedFees, connection })
  report.then((rep) => {
    if (!rep?.coins) return
    feesByMint = new Map(rep.coins.map((c) => [c.baseMint, c]))
    paintFees(coin, state, { creatorFees, buildClaimAll, graduatedFees, connection })
  })

  /**
   * After a trade the numbers are stale, but re-rendering the view makes the page
   * jump under the cursor. Patch the four values that moved and leave the DOM alone.
   */
  async function refreshStats() {
    try {
      const next = await loadPool(coin.pool)
      Object.assign(state, next)
      $('#bar-fill').style.width = `${(next.progress * 100).toFixed(1)}%`
      $('#stat-raised').textContent = `${fmt(next.raised)} / ${fmt(next.threshold)} ${coin.quoteSymbol}`
      $('#stat-progress').textContent = `${(next.progress * 100).toFixed(1)}%`
      $('#stat-price').textContent = `${next.price.toPrecision(4)} ${coin.quoteSymbol}`
      paintFees(coin, next, { creatorFees, buildClaimAll, graduatedFees, connection })
      paintChart(coin, next, { refetch: true })
    } catch { /* the numbers stay as they were, which is better than a broken page */ }
  }

  window.__refreshCoinStats = refreshStats

  /**
   * A curve that has just filled is stuck: the migration is permissionless, so it
   * waits for whoever cranks it first. Telling the keeper now turns a bar sitting
   * at 100% for up to ten minutes into a few seconds.
   *
   * The buyer is not made to wait on it and never sees it fail — the sweep is still
   * there, and a coin that did not graduate this second is not their problem.
   */
  async function nudgeGraduation() {
    if (state.isMigrated || state.progress < 1) return
    status.textContent = 'Curve filled — graduating to Meteora…'
    try {
      const res = await fetch('/api/graduate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mint: coin.baseMint }),
      })
      const body = await res.json()
      if (body.ok) {
        status.innerHTML = `Graduated — <a href="https://solscan.io/tx/${esc(body.signature)}" target="_blank" rel="noopener">${esc(body.signature.slice(0, 8))}…</a>`
      } else {
        console.error('graduation declined:', body.reason ?? body.error)
        status.textContent = ''
      }
    } catch (e) {
      console.error('graduation request failed:', e.message)
      status.textContent = ''
    }
    await refreshStats()
  }

  if (state.isMigrated) {
    $('#quote-out').innerHTML = 'This coin has graduated — trade it on its Meteora pool.'
    $('#do-trade').disabled = true
    return
  }

  let side = 'buy'
  // What the buyer is spending. The ownership coin by default; SOL or USDC gets
  // routed into it first. Selling always returns the ownership coin, so the choice
  // only exists on the buy side.
  let payVia = coin.quoteMint
  const amount = $('#amount')
  const out = $('#quote-out')
  const action = $('#do-trade')
  const status = $('#trade-status')
  const payBox = $('#pay-with')
  const payLab = $('#pay-lab')
  const payLine = $('#pay-line')
  const maxBtn = $('#amount-max')
  let latest = null
  // The Jupiter route, when the trade is against SOL or USDC rather than the
  // ownership coin. Null means the curve is being traded directly.
  let jupPlan = null

  const spending = () => (side === 'sell'
    ? coin.symbol
    : payVia === coin.quoteMint ? coin.quoteSymbol : payWith(payVia).symbol)

  /** The pair, in the order Jupiter takes it: what leaves the wallet, then what enters. */
  const jupSwap = (from, to) =>
    `https://jup.ag/swap?sell=${encodeURIComponent(from)}&buy=${encodeURIComponent(to)}`

  function syncLabels() {
    $('#amount-label').textContent = `Amount in ${spending()}`
    action.textContent = `${side === 'buy' ? 'Buy' : 'Sell'} ${coin.symbol}`
    // The Jupiter link follows the tab. Fixed on "buy", it sat under the Sell panel
    // offering the opposite trade to the one being made — and, followed, it would
    // have bought more of the coin somebody was trying to get out of.
    const jup = $('#jup-link')
    jup.textContent = `${side === 'buy' ? 'Buy' : 'Sell'} on Jupiter ↗`
    jup.href = side === 'buy'
      ? jupSwap(coin.quoteMint, coin.baseMint)
      : jupSwap(coin.baseMint, coin.quoteMint)
  }

  /** The asset being spent: whatever was picked to buy with, or the coin being sold. */
  const spendingMint = () => (side === 'sell' ? coin.baseMint : payVia)
  /** Set only when spending one of SOL or USDC — the quote coin and the base are ours. */
  const spendingVia = () => (side === 'buy' ? payWith(payVia) : null)

  let payRun = 0
  function paintPay() {
    // The same three buttons on both sides, meaning opposite things: what is spent
    // on a buy, what is received on a sell. Only the sale needs saying out loud —
    // on the buy side the amount box underneath already reads "Amount in CARS".
    payLab.hidden = side !== 'sell'
    payBox.hidden = false
    const options = [{ mint: coin.quoteMint, symbol: coin.quoteSymbol }, ...PAY_WITH]
    payBox.innerHTML = options.map((o) =>
      `<button type="button" data-mint="${esc(o.mint)}" aria-pressed="${String(o.mint === payVia)}">${esc(o.symbol)}</button>`).join('')
    payBox.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      payVia = b.dataset.mint
      jupPlan = null
      paintPay()
      syncLabels()
      amount.dispatchEvent(new Event('input'))
    }))
    paintHeld()
  }

  /**
   * How many decimals a figure of this size deserves. Half a million memecoins do not
   * need six, and Max used to drop the whole tail into the field: `518907.524609`,
   * which the browser then drew with the locale's decimal comma, directly under a
   * balance whose comma was a thousands separator. Two commas, opposite meanings.
   */
  const places = (n) => (n >= 1000 ? 0 : n >= 1 ? 4 : 6)
  /** Always down. A balance rounded up claims tokens the wallet does not hold. */
  const trunc = (n, d) => Math.floor(n * 10 ** d) / 10 ** d

  // What they hold of whatever is being spent, so a trade is not proposed against an
  // empty wallet — and so Max has a number to fill in. Shown while selling too: that
  // is where "all of it" is the amount most people actually want.
  let heldNow = 0
  function paintHeld() {
    const run = ++payRun
    payLine.hidden = true
    maxBtn.hidden = true
    if (!session) return
    const pay = spendingVia()
    balanceOf(connection, session.address, spendingMint(), { native: Boolean(pay?.native) })
      .then((held) => {
        if (run !== payRun) return
        heldNow = held
        payLine.hidden = false
        payLine.textContent = `${fmt(trunc(held, places(held)), places(held))} ${spending()}`
        maxBtn.hidden = !held
      })
      .catch((e) => console.error('balance unavailable:', e.message))
  }

  // Native SOL has to keep enough back to pay for the transaction it is funding;
  // floored at the token's own precision, because a float that rounds up spends
  // one unit more than the wallet holds and the whole thing simply fails.
  maxBtn.addEventListener('click', () => {
    const pay = spendingVia()
    const decimals = pay?.decimals ?? COIN_DECIMALS
    const spendable = Math.max(0, trunc(heldNow - (pay?.native ? GAS_RESERVE.trade : 0), decimals))
    // Trimmed to the same precision the balance is shown at, so the field holds a
    // number somebody can read back rather than a six-decimal tail.
    const value = trunc(spendable, places(spendable))
    amount.value = value ? String(value) : ''
    amount.dispatchEvent(new Event('input'))
  })

  paintPay()
  onSession('pay', paintPay)

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    side = b.dataset.side
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
    jupPlan = null
    paintPay()
    syncLabels()
    amount.dispatchEvent(new Event('input'))
  }))

  let timer
  amount.addEventListener('input', () => {
    clearTimeout(timer)
    const value = Number(amount.value)
    if (!value || value <= 0) { out.textContent = 'Enter an amount.'; action.disabled = true; return }
    out.textContent = 'Pricing…'
    action.disabled = true
    timer = setTimeout(async () => {
      try {
        jupPlan = null
        latest = null
        const via = payWith(payVia)
        let receiving, symbol

        if (via) {
          // One route, one transaction. Jupiter goes through this very curve, so the
          // pool still charges its fees — and a single end-to-end quote applies the
          // slippage allowance once rather than stacking it across two hops.
          jupPlan = await quoteSwap(side === 'buy'
            ? { inMint: via.mint, inDecimals: via.decimals, outMint: coin.baseMint, outDecimals: COIN_DECIMALS, uiAmount: value }
            : { inMint: coin.baseMint, inDecimals: COIN_DECIMALS, outMint: via.mint, outDecimals: via.decimals, uiAmount: value })
          receiving = jupPlan.out
          symbol = side === 'buy' ? coin.symbol : via.symbol
          if (!receiving) {
            out.innerHTML = `<span class="warn-text">No route for that amount right now.</span>`
            return
          }
        } else {
          latest = await quote(state, { amountIn: value, sellingBase: side === 'sell' })
          receiving = latest.out
          symbol = side === 'buy' ? coin.symbol : coin.quoteSymbol
          if (!receiving) {
            // Selling into an empty curve: honest zero rather than a confusing one.
            out.innerHTML = side === 'sell'
              ? `<span class="warn-text">Nothing to sell against yet — the curve holds no ${esc(coin.quoteSymbol)}.</span>`
              : '<span class="warn-text">That amount is too small to buy anything.</span>'
            return
          }
        }

        // Price impact is not shown when there is nothing to say, and is not hidden
        // when there is: a route can cost several percent on a thin coin, and that is
        // real money leaving the wallet quietly.
        const impact = jupPlan?.impactPct ?? 0
        out.innerHTML = `
          <div class="line"><span>To receive</span><b>${fmt(receiving, places(receiving))} ${esc(symbol)}</b></div>
          <div class="line"><span>Max slippage</span><b>1%</b></div>` +
          (impact >= 1 ? `<div class="line"><span>Price impact</span><b class="warn-text">${impact.toFixed(2)}%</b></div>` : '')
        action.disabled = false
      } catch (e) {
        out.innerHTML = `<span class="warn-text">${esc(explain(e, 'quote'))}</span>`
      }
    }, 350)
  })

  action.addEventListener('click', async () => {
    action.disabled = true
    try {
      status.textContent = 'Connecting wallet…'
      const wallet = await ensureWallet()

      // One signature either way. Against SOL or USDC that is Jupiter's own route,
      // which passes through this curve; against the ownership coin it is the curve
      // on its own. Nothing here is a two-transaction sequence any more, so there is
      // no half-finished state to explain or recover from.
      status.textContent = 'Building the swap…'
      const tx = jupPlan
        ? await buildSwapTx(jupPlan.quote, wallet.address)
        : await buildSwap(state, {
            owner: wallet.address,
            amountIn: Number(amount.value),
            minimumOut: latest?.minimumOut ?? 0,
            sellingBase: side === 'sell',
          })
      status.textContent = 'Waiting for your signature…'
      const signature = await wallet.signAndSend(tx, connection)
      status.innerHTML = `Done — <a href="https://solscan.io/tx/${signature}" target="_blank" rel="noopener">${signature.slice(0, 8)}…${signature.slice(-8)}</a>`
      amount.value = ''
      out.textContent = 'Enter an amount.'
      setTimeout(async () => {
        // The balance on the label row is now wrong by exactly what was just traded.
        paintHeld()
        await refreshStats()
        await nudgeGraduation()
      }, 2000)
    } catch (e) {
      status.innerHTML = `<span class="warn-text">${esc(explain(e, 'trade'))}</span>`
      action.disabled = false
    }
  })
}

/**
 * The price of a coin over its own life, drawn from its trades.
 *
 * Every reading is a real swap: what it paid, in the ownership coin it is paired
 * with. What is drawn is not one point per swap, though. Trades arrive in bursts —
 * hundreds inside a minute at a launch — and plotting each one against the clock
 * turns a busy minute into a vertical wall. The span is divided into even slices
 * and each slice is drawn at its closing price, which is how price charts have
 * always been read.
 *
 * The line through those closings is a monotone cubic. It curves, but it is not
 * free to invent: between two closings it can never leave the range they bound, so
 * no smoothing ever shows a price nobody paid.
 */
const RANGES = [
  { id: '1h', label: '1H', seconds: 3600 },
  { id: '24h', label: '24H', seconds: 86400 },
  { id: 'all', label: 'All', seconds: null },
]

let chartRange = 'all'
let chartCache = { mint: null, points: [] }

function geometry() {
  // Everything inside an SVG scales with its viewBox, labels included, so a chart
  // authored at 800 units wide and shown in a 335-pixel column renders its 9-unit
  // axis text at under 4 pixels. Narrow screens get their own geometry.
  const narrow = matchMedia('(max-width: 640px)').matches
  return narrow
    ? { W: 360, H: 210, PAD: { top: 12, right: 62, bottom: 18, left: 4 }, slices: 50, tick: 8 }
    : { W: 800, H: 220, PAD: { top: 14, right: 92, bottom: 20, left: 6 }, slices: 90, tick: 9 }
}

/**
 * A price as a person reads it. `9.42e-5` is a correct way to write this number and
 * a useless way to look at it, and these coins are all priced down there.
 */
function priceLabel(v, digits = 4) {
  if (!v || !isFinite(v)) return '0'
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 })
  const places = Math.min(18, Math.max(2, digits - Math.floor(Math.log10(v)) - 1))
  const out = v.toFixed(places)
  return out.includes('.') ? out.replace(/0+$/, '').replace(/\.$/, '') : out
}

/**
 * Even slices of the span, each held at the price it closed on.
 *
 * A slice nobody traded in carries the one before it forward. Skipping it instead
 * would leave the curve to run a smooth diagonal across an hour where nothing
 * happened, drawing a gradual drift that never took place — the price of a pool
 * only moves when someone trades. Carried forward, quiet stretches read as the flat
 * lines they were, and the curve bends only where money actually changed hands.
 */
function slice(points, count) {
  if (points.length < 2) return points.map((p) => ({ t: p.t, price: p.price }))
  const t0 = points[0].t
  const span = Math.max(1, points[points.length - 1].t - t0)
  const width = span / count

  const closes = new Array(count).fill(null)
  for (const p of points) {
    closes[Math.min(count - 1, Math.floor((p.t - t0) / width))] = p.price // last write is the close
  }

  const out = []
  let carry = points[0].price
  for (let i = 0; i < count; i++) {
    if (closes[i] !== null) carry = closes[i]
    out.push({ t: t0 + (i + 0.5) * width, price: carry })
  }
  return out
}

/**
 * Monotone cubic through the points (Fritsch–Carlson tangents).
 *
 * Plain splines overshoot: give one a rise followed by a plateau and it draws a
 * bump above every price in the data. Clamping the tangents where the slope turns
 * is what keeps the curve inside what actually happened.
 */
function curve(pts) {
  const n = pts.length
  const at = (i) => `${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`
  if (n === 0) return ''
  if (n === 1) return `M${at(0)}`
  if (n === 2) return `M${at(0)} L${at(1)}`

  const dx = [], m = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x || 1e-6
    m[i] = (pts[i + 1].y - pts[i].y) / dx[i]
  }
  const t = [m[0]]
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) { t[i] = 0; continue } // a turning point stays a corner
    const w1 = 2 * dx[i] + dx[i - 1]
    const w2 = dx[i] + 2 * dx[i - 1]
    t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i])
  }
  t[n - 1] = m[n - 2]

  let d = `M${at(0)}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += ` C${(pts[i].x + h).toFixed(1)} ${(pts[i].y + t[i] * h).toFixed(1)},` +
         ` ${(pts[i + 1].x - h).toFixed(1)} ${(pts[i + 1].y - t[i + 1] * h).toFixed(1)},` +
         ` ${at(i + 1)}`
  }
  return d
}

async function paintChart(coin, state, { refetch = false } = {}) {
  const box = $('#chart')
  if (!box) return

  if (refetch || chartCache.mint !== coin.baseMint) {
    if (chartCache.mint !== coin.baseMint) {
      chartRange = 'all'
      box.innerHTML = '<div class="lab"><span>Price</span></div><p class="empty">Loading the chart…</p>'
    }
    let points = []
    try {
      const body = await fetch(`/api/chart/${encodeURIComponent(coin.baseMint)}`).then((r) => r.json())
      points = body.points ?? []
      if (body.error) console.error('chart unavailable:', body.error)
    } catch (e) {
      console.error('chart request failed:', e.message)
    }
    chartCache = { mint: coin.baseMint, points }
  }
  drawChart(box, coin)
}

function drawChart(box, coin) {
  const { W, H, PAD, slices, tick } = geometry()
  const all = chartCache.points
  const range = RANGES.find((r) => r.id === chartRange)
  const cutoff = range.seconds ? Date.now() / 1000 - range.seconds : 0
  const points = all.filter((p) => p.t >= cutoff)

  const usd = coin.quoteUsdPrice ?? 0
  const buttons = RANGES.map((r) =>
    `<button type="button" data-range="${r.id}" aria-pressed="${String(r.id === chartRange)}">${esc(r.label)}</button>`).join('')

  const paint = (body, summary = '') => {
    box.innerHTML = `<div class="lab">
        <span>Price in ${esc(coin.quoteSymbol)}</span>
        ${summary}
        <span class="ranges">${buttons}</span>
      </div>${body}`
    box.querySelectorAll('.ranges button').forEach((b) => b.addEventListener('click', () => {
      chartRange = b.dataset.range
      drawChart(box, coin)
    }))
  }

  if (!all.length) return paint('<p class="empty">No trades yet — the chart starts with the first one.</p>')
  if (!points.length) {
    return paint(`<p class="empty">Nothing traded in the last ${chartRange === '1h' ? 'hour' : '24 hours'}.</p>`)
  }

  const series = slice(points, slices)
  const prices = series.map((p) => p.price)
  let lo = Math.min(...prices), hi = Math.max(...prices)
  if (hi === lo) { hi = lo * 1.2 || 1; lo *= 0.8 }
  const pad = (hi - lo) * 0.08
  // Clamped at zero: padding the bottom of a range that starts near nothing walks
  // the axis into negative prices, which do not exist.
  lo = Math.max(0, lo - pad); hi += pad

  const t0 = series[0].t, t1 = series[series.length - 1].t
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const x = (t) => PAD.left + (t1 === t0 ? plotW / 2 : ((t - t0) / (t1 - t0)) * plotW)
  const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH

  const xy = series.map((p) => ({ x: x(p.t), y: y(p.price) }))
  const line = curve(xy)
  const floor = (PAD.top + plotH).toFixed(1)
  const area = xy.length > 1
    ? `${line} L${xy[xy.length - 1].x.toFixed(1)} ${floor} L${xy[0].x.toFixed(1)} ${floor} Z`
    : ''

  const rows = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = hi - f * (hi - lo)
    const yy = (PAD.top + f * plotH).toFixed(1)
    return `<line class="grid" x1="${PAD.left}" y1="${yy}" x2="${PAD.left + plotW}" y2="${yy}"></line>
            <text class="tick" x="${PAD.left + plotW + 6}" y="${yy}" font-size="${tick}" dominant-baseline="middle">${esc(priceLabel(v, 3))}</text>`
  }).join('')

  const when = (t) => new Date(t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const last = points[points.length - 1]
  const move = points.length > 1 ? (last.price / points[0].price - 1) * 100 : 0
  const trades = `${points.length} trade${points.length > 1 ? 's' : ''}`
  const summary = `<span class="now">
      <b id="c-price">${esc(priceLabel(last.price))} ${esc(coin.quoteSymbol)}</b>
      <span class="usd" id="c-usd">${usd ? `$${esc(priceLabel(last.price * usd))}` : ''}</span>
      <span class="move" id="c-move">${move >= 0 ? '+' : ''}${move.toFixed(1)}% · ${trades}</span>
    </span>`

  paint(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price of ${esc(coin.symbol ?? 'this coin')} in ${esc(coin.quoteSymbol)}, ${points.length} trades">
      ${rows}
      ${area ? `<path class="area" d="${area}"></path>` : ''}
      <path class="line" d="${line}" vector-effect="non-scaling-stroke"></path>
      <circle class="dot" cx="${xy[xy.length - 1].x.toFixed(1)}" cy="${xy[xy.length - 1].y.toFixed(1)}" r="3.5"></circle>
      <g class="cross" hidden>
        <line y1="${PAD.top}" y2="${(PAD.top + plotH).toFixed(1)}"></line>
        <circle r="4"></circle>
      </g>
      <rect class="hit" x="${PAD.left}" y="${PAD.top}" width="${plotW}" height="${plotH}" fill="transparent"></rect>
      <text class="tick" x="${PAD.left}" y="${H - 4}" font-size="${tick}">${esc(when(t0))}</text>
      <text class="tick" x="${PAD.left + plotW}" y="${H - 4}" font-size="${tick}" text-anchor="end">${esc(when(t1))}</text>
    </svg>`, summary)

  // Reading the chart by pointing at it. The header is the readout: the price, its
  // dollar value and the change all move to whatever moment is under the cursor,
  // and let go of it again when the pointer leaves.
  const svg = box.querySelector('svg')
  const cross = svg.querySelector('.cross')
  const crossLine = cross.querySelector('line')
  const crossDot = cross.querySelector('circle')
  const priceEl = box.querySelector('#c-price')
  const usdEl = box.querySelector('#c-usd')
  const moveEl = box.querySelector('#c-move')
  const base = points[0].price

  const readout = (price, at) => {
    const change = base ? (price / base - 1) * 100 : 0
    priceEl.textContent = `${priceLabel(price)} ${coin.quoteSymbol}`
    usdEl.textContent = usd ? `$${priceLabel(price * usd)}` : ''
    moveEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(1)}% · ${at ?? trades}`
  }

  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect()
    if (!rect.width) return
    const vx = ((e.clientX - rect.left) / rect.width) * W
    let index = 0
    for (let k = 1; k < xy.length; k++) {
      if (Math.abs(xy[k].x - vx) < Math.abs(xy[index].x - vx)) index = k
    }
    const point = series[index]
    crossLine.setAttribute('x1', xy[index].x.toFixed(1))
    crossLine.setAttribute('x2', xy[index].x.toFixed(1))
    crossDot.setAttribute('cx', xy[index].x.toFixed(1))
    crossDot.setAttribute('cy', xy[index].y.toFixed(1))
    cross.hidden = false
    readout(point.price, when(point.t))
  })

  svg.addEventListener('pointerleave', () => {
    cross.hidden = true
    readout(last.price)
  })
}

/**
 * One panel for everything a coin has earned.
 *
 * The curve's fees and the graduated position's come from different programs and
 * different instructions, but both belong to the creator and both settle in the
 * quote token, so they are shown as one balance and claimed in one transaction —
 * the two instructions together measure 892 bytes against a 1232-byte cap. Where
 * the balance came from is still named underneath, because someone reconciling
 * this against a block explorer has to be able to find both halves.
 *
 * Everyone sees the figures: they are on chain, and a launchpad that published
 * creators' fees only to the creators would be choosing which truths to tell. Only
 * the creator gets a button — the claim is signed by the position's owner and
 * nobody else can move it.
 */
function paintFees(coin, state, api) {
  const box = $('#creator-fees')
  const price = coin.quoteUsdPrice ?? 0
  const report = feesByMint.get(coin.baseMint)
  const curve = api.creatorFees(state)

  // Looked up by creator address, not by whoever happens to be connected. Reading
  // it through the visitor's own wallet hid the graduated half from everyone except
  // the creator, and showed nothing at all to someone browsing signed out.
  const position = state.isMigrated
    ? api.graduatedFees(state, coin.creator).catch((e) => {
        console.error('graduated fees unavailable:', e.message)
        return null
      })
    : Promise.resolve(null)

  const render = async () => {
    const lp = await position
    const mine = session?.address === coin.creator

    // DAMM v2 pays in both tokens and orders them by mint, so which side is the
    // quote has to be read off the pool rather than assumed.
    const quoteIsB = !lp || coin.quoteMint === lp.tokenB
    const lpQuote = lp ? (quoteIsB ? lp.feeB : lp.feeA) : 0
    const lpBase = lp ? (quoteIsB ? lp.feeA : lp.feeB) : 0
    const lpClaimed = lp ? (quoteIsB ? lp.claimedB : lp.claimedA) : 0

    const unclaimed = curve.pending + lpQuote
    const claimed = curve.claimed + lpClaimed

    if (!report && !curve.lifetime && !unclaimed && !claimed) { box.innerHTML = ''; return }

    const split = report
      ? (() => {
          // Summed from the two figures as displayed, at their precision: the report
          // has generated equal to creator plus DAO exactly, and three independent
          // roundings can still leave the column visibly out.
          const creatorUsd = report.creator * price
          const money = usdGroup([creatorUsd, report.lfownUsd])
          return `<dl class="fee-split">
           <div><dt>Generated</dt><dd>${money.show(money.round(creatorUsd) + money.round(report.lfownUsd))}</dd></div>
           <div><dt>To the creator</dt><dd>${money.show(creatorUsd)}</dd></div>
           <div><dt>To the LFOwn DAO</dt><dd>${money.show(report.lfownUsd)}</dd></div>
         </dl>`
        })()
      : ''

    const sources = [
      curve.pending ? `${fmt(curve.pending, 4)} on the curve` : '',
      lpQuote ? `${fmt(lpQuote, 4)} since graduation` : '',
    ].filter(Boolean)

    const lines = []
    if (sources.length > 1) lines.push(sources.join(' · '))
    if (lpBase) lines.push(`plus ${fmt(lpBase, 4)} ${esc(coin.symbol)} from the graduated pool`)
    lines.push(`${fmt(claimed, 4)} ${esc(coin.quoteSymbol)} already claimed`)

    box.innerHTML = `
      <div class="creator-box">
        <div class="lab">Fees</div>
        ${split}
        <div class="phase">
          <div class="lab">The creator's share</div>
          <div class="amount">${fmt(unclaimed, 4)} ${esc(coin.quoteSymbol)}
            <span class="sub">${usd(unclaimed * price)} unclaimed</span></div>
          <div class="claimed">${lines.join('<br>')}</div>
          ${mine
            ? `<button class="btn" id="claim-all" ${unclaimed || lpBase ? '' : 'disabled'}>Claim</button>`
            : `<p class="hint">Claimable only by <a href="/creator/${esc(coin.creator)}">${esc(short(coin.creator))}</a>, who launched it.</p>`}
        </div>
        <p class="hint" id="claim-status"></p>
      </div>`

    wire('#claim-all', () => api.buildClaimAll(state, { creator: session.address, lp }))
  }

  const wire = (sel, build) => {
    const btn = $(sel)
    if (!btn) return
    btn.addEventListener('click', async () => {
      btn.disabled = true
      const status = $('#claim-status')
      try {
        status.textContent = 'Building the claim…'
        const tx = await build()
        status.textContent = 'Waiting for your signature…'
        const signature = await session.signAndSend(tx, api.connection)
        status.innerHTML = `Claimed — <a href="https://solscan.io/tx/${esc(signature)}" target="_blank" rel="noopener">${esc(signature.slice(0, 8))}…</a>`
        setTimeout(() => window.__refreshCoinStats?.(), 2500)
      } catch (e) {
        status.innerHTML = `<span class="warn-text">${esc(explain(e, 'claim'))}</span>`
        btn.disabled = false
      }
    })
  }

  render()
  onSession('fees', render)
}


// ── routing ──────────────────────────────────────────────────────────────────
function route() {
  const mint = location.pathname.replace(/^\/coins\/?/, '')
  if (mint) renderCoin(mint)
  else renderList()
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/coins"]')
  if (!a || e.metaKey || e.ctrlKey) return
  e.preventDefault()
  history.pushState({}, '', a.getAttribute('href'))
  route()
})
window.addEventListener('popstate', route)

paintConnect()

/**
 * Wallets register a beat after the page loads, so give them one before asking.
 * A refresh should not cost a reconnection.
 */
async function restoreSession() {
  for (let wait = 0; wait < 8 && !available().length; wait++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  const resumed = await reconnect().catch(() => null)
  if (!resumed) return
  session = resumed
  paintConnect()
  sessionChanged()
}
restoreSession()

route()
