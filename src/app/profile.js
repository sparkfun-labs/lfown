// LFOwn — everything one wallet has launched, and what it is owed.
//
// The coins page can only ever claim the coin you are looking at. A creator with
// six launches had six pages to visit and six buttons to remember; this is the same
// claim, gathered.

import { available, connect, reconnect, forget, showIcon } from './wallet.js'
import { esc, safeUrl } from './escape.js'
import { explain, declined } from './errors.js'

const $ = (s) => document.querySelector(s)
const view = $('#view')
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d })
const usd = (n) => {
  const v = Number(n) || 0
  if (v && Math.abs(v) < 0.005) return '<$0.01'
  return Math.abs(v) < 1 ? '$' + v.toFixed(2) : '$' + fmt(v, 0)
}
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`

// ── wallet ───────────────────────────────────────────────────────────────────
let session = null
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
  render()
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
    try { await navigator.clipboard.writeText(session.address); e.target.textContent = 'Copied' }
    catch { e.target.textContent = 'Copy failed' }
    setTimeout(() => { e.target.textContent = 'Copy address' }, 1200)
    return
  }
  try { await session.disconnect?.() } catch {}
  forget()
  session = null
  menu.hidden = true
  paintConnect()
  render()
})
document.addEventListener('click', (e) => { if (!e.target.closest('.wallet-slot')) menu.hidden = true })
window.addEventListener('wallet-standard:register-wallet', () => setTimeout(() => {
  paintConnect()
  // Extensions announce themselves a beat after load, so this page can well have
  // drawn "No wallet found" already. Repainting is free while nobody is connected.
  if (!session) render()
}, 0))

// ── data ─────────────────────────────────────────────────────────────────────
/** The image lives in the metadata JSON the launch published, not on chain. */
async function artwork(coin) {
  if (coin.image !== undefined) return coin.image
  coin.image = null
  try {
    if (coin.uri) coin.image = (await fetch(coin.uri).then((r) => r.json())).image || null
  } catch { /* a dead uri is not worth a broken page */ }
  return coin.image
}

/**
 * What this wallet has launched, with the earnings the public report already knows
 * and the balances only the chain does.
 *
 * The report covers lifetime earnings; it says nothing about what is still sitting
 * unclaimed, which is the number this page exists for. That part is read live.
 */
async function gather(address) {
  const [list, report] = await Promise.all([
    fetch('/api/launches').then((r) => r.json()).catch(() => ({ launches: [] })),
    fetch('/api/fees').then((r) => r.json()).catch(() => null),
  ])
  const mine = (list.launches ?? []).filter((l) => l.creator === address)
  if (!mine.length) return { mine: [], rows: [], report }

  const earned = new Map((report?.coins ?? []).map((c) => [c.baseMint, c]))
  const { loadPool, connection } = await import('./trade.js')
  const { lpPositions } = await import('../lib/lp-fees.mjs')

  // One call for every locked position this wallet holds, rather than one per coin:
  // a creator with six graduated launches would otherwise make six identical scans.
  const positions = await lpPositions(connection, address).catch((e) => {
    console.error('lp positions unavailable:', e.message)
    return []
  })

  const rows = []
  for (const coin of mine) {
    let state = null
    try { state = await loadPool(coin.pool) } catch (e) { console.error(`pool ${coin.pool}:`, e.message) }
    const lp = positions.find((p) => p.tokenA === coin.baseMint || p.tokenB === coin.baseMint) ?? null
    const price = earned.get(coin.baseMint)?.quoteUsdPrice ?? coin.quoteUsdPrice ?? 0

    // On the curve every fee is quote-side. In a graduated pool the position earns
    // in both, and only the quote side has a price we can state in dollars here.
    const quoteIsB = lp ? lp.tokenB === coin.quoteMint : true
    const curvePending = state ? Number(state.pool.creatorQuoteFee.toString()) / 1e6 : 0
    const lpQuote = lp ? (quoteIsB ? lp.feeB : lp.feeA) : 0
    const lpBase = lp ? (quoteIsB ? lp.feeA : lp.feeB) : 0

    rows.push({
      coin, state, lp, price,
      // A pool we could not read is not a pool with nothing in it. Told apart here
      // so the page never answers "nothing to claim" on the strength of a failure.
      unreadable: !state,
      lifetimeUsd: (earned.get(coin.baseMint)?.creator ?? 0) * price,
      pendingQuote: curvePending + lpQuote,
      pendingBase: lpBase,
      pendingUsd: (curvePending + lpQuote) * price,
    })
  }
  rows.sort((a, b) => b.lifetimeUsd - a.lifetimeUsd)
  return { mine, rows, report }
}

// ── render ───────────────────────────────────────────────────────────────────
function shell(inner) {
  view.innerHTML = `<h1>Profile</h1>
    <p class="lede">Every coin this wallet launched, what it has earned, and one button for all of it.</p>
    ${inner}
    <p class="warn-text" id="connect-status"></p>`
}

async function render() {
  if (!session) {
    // The header's button is a long way from the sentence that asks for it, and on a
    // narrow screen it is behind the burger entirely. Ask where the eye already is.
    const found = available().length
    shell(`<button class="btn" type="button" id="connect-here" ${found ? '' : 'disabled'}>${
      found ? 'Connect wallet' : 'No wallet found'}</button>`)
    $('#connect-here').addEventListener('click', async () => {
      const btn = $('#connect-here')
      btn.disabled = true
      btn.textContent = 'Connecting…'
      try {
        await ensureWallet()
      } catch (e) {
        btn.disabled = false
        btn.textContent = 'Connect wallet'
        $('#connect-status').textContent = explain(e, 'connect')
      }
    })
    return
  }
  shell(`<p class="who">${esc(session.address)}</p><p class="skel">Reading your launches…</p>`)

  let data
  try { data = await gather(session.address) } catch (e) {
    shell(`<p class="skel warn-text">${esc(explain(e, 'profile'))}</p>`)
    return
  }

  if (!data.rows.length) {
    shell(`<p class="who">${esc(session.address)}</p>
      <p class="skel">This wallet has not launched anything yet. <a href="/launch">Launch a coin</a>.</p>`)
    return
  }

  const lifetime = data.rows.reduce((t, r) => t + r.lifetimeUsd, 0)
  const due = data.rows.reduce((t, r) => t + r.pendingUsd, 0)
  const claimable = data.rows.filter((r) => r.state && (r.pendingQuote > 0 || r.pendingBase > 0))
  const blind = data.rows.filter((r) => r.unreadable)

  shell(`
    <p class="who">${esc(session.address)}</p>
    <div class="totals">
      <div class="tot"><span class="lab">Coins launched</span><span class="big">${data.rows.length}</span></div>
      <div class="tot"><span class="lab">Fees generated</span><span class="big">${usd(lifetime)}</span></div>
      <div class="tot due"><span class="lab">Unclaimed</span><span class="big">${usd(due)}</span></div>
    </div>

    <div class="claim-bar">
      <div class="txt">${claimable.length
        ? `<b>${usd(due)}</b> waiting on <b>${claimable.length}</b> of your ${data.rows.length} coin${data.rows.length > 1 ? 's' : ''}.
           ${claimable.length > 1 ? 'Packed into as few signatures as the size limit allows.' : 'One signature.'}`
        : 'Nothing to claim right now. Fees land here as your coins trade.'}${
        blind.length ? `<br><span class="warn-text">${blind.length} pool${blind.length > 1 ? 's' : ''} could not be read,
          so this total may be short. Reload in a moment.</span>` : ''}</div>
      <button class="btn" id="claim-all" ${claimable.length ? '' : 'disabled'}>Claim everything</button>
    </div>
    <p id="claim-status"></p>

    <div class="sec-head">
      <h2>Your coins <span class="count">${data.rows.length}</span></h2>
    </div>
    <div class="mine">${data.rows.map(row).join('')}</div>

    <p class="foot-note">Fees generated is your half of every trade your coins have taken, claimed and
      unclaimed, on the curve and in the graduated pool. The LFOwn DAO's half is published beside it on
      the <a href="/leaderboard">leaderboard</a>.</p>`)

  for (const r of data.rows) {
    artwork(r.coin).then((src) => {
      const img = document.querySelector(`img[data-mint="${CSS.escape(r.coin.baseMint)}"]`)
      if (src && img) img.src = safeUrl(src)
    })
  }

  $('#claim-all')?.addEventListener('click', () => claimAll(claimable))
}

function row(r) {
  const c = r.coin
  return `<a class="row" href="/coins/${esc(c.baseMint)}">
    <img alt="" data-mint="${esc(c.baseMint)}">
    <div>
      <div class="nm">${esc(c.symbol ?? '—')}</div>
      <div class="pair">${c.isMigrated ? 'graduated' : 'on the curve'} · paired with ${esc(c.quoteSymbol)}</div>
    </div>
    <div class="fig"><span class="lab">Generated</span><b>${usd(r.lifetimeUsd)}</b></div>
    <div class="fig due"><span class="lab">Unclaimed</span><b>${
      r.unreadable ? '?' : r.pendingUsd || r.pendingBase ? usd(r.pendingUsd) : '—'}</b></div>
  </a>`
}

/**
 * Claims everything, in as few signatures as the transaction size limit allows.
 *
 * The coins are packed by measured size rather than one to a transaction — five on
 * the curve go out as two signatures instead of five. A batch is all-or-nothing, so
 * its coins are named together whichever way it goes.
 */
async function claimAll(rows) {
  const btn = $('#claim-all')
  const status = $('#claim-status')
  btn.disabled = true
  status.textContent = 'Working out how few signatures this needs…'

  const { packClaims, connection } = await import('./trade.js')
  let batches
  try {
    batches = await packClaims(rows, { creator: session.address })
  } catch (e) {
    console.error('packing claims failed:', e)
    status.innerHTML = `<span class="warn-text">${esc(explain(e, 'claim'))}</span>`
    btn.disabled = false
    return
  }
  if (!batches.length) {
    status.textContent = 'Nothing to claim right now.'
    return
  }

  const named = (batch) => batch.coins.map((c) => c.coin.symbol ?? short(c.coin.baseMint)).join(', ')
  let claimed = 0
  const failed = []

  for (const [i, batch] of batches.entries()) {
    const names = named(batch)
    try {
      status.innerHTML = `Signature ${i + 1} of ${batches.length} — <b>${esc(names)}</b>…`
      // A fresh blockhash per batch: approving several in a row takes as long as it
      // takes, and the one they were weighed against would be long expired.
      const { blockhash } = await connection.getLatestBlockhash('confirmed')
      batch.transaction.recentBlockhash = blockhash
      await session.signAndSend(batch.transaction, connection)
      claimed += batch.coins.length
    } catch (e) {
      console.error(`claim batch ${names} failed:`, e)
      failed.push(`${names}: ${explain(e, 'claim')}`)
      // Saying no once means no. Anything else — a dropped connection, a stale
      // blockhash — is worth carrying on through, which is the point of the button.
      if (declined(e)) {
        const left = batches.slice(i + 1).reduce((n, b) => n + b.coins.length, 0)
        if (left) failed.push(`Stopped after that. ${left} coin(s) left untouched.`)
        break
      }
    }
  }

  status.innerHTML = [
    claimed ? `Claimed ${claimed} coin${claimed > 1 ? 's' : ''} in ${batches.length} signature${batches.length > 1 ? 's' : ''}.` : 'Nothing was claimed.',
    failed.length ? `<span class="warn-text">${failed.map(esc).join('<br>')}</span>` : '',
  ].filter(Boolean).join('<br>')
  // Balances have moved; read them again rather than leaving stale figures up.
  if (claimed) setTimeout(render, 2500)
  else btn.disabled = false
}

// ── boot ─────────────────────────────────────────────────────────────────────
paintConnect()
render()

/** Wallets register a beat after the page loads. A refresh should not cost a reconnection. */
async function restoreSession() {
  for (let wait = 0; wait < 8 && !available().length; wait++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  const resumed = await reconnect().catch(() => null)
  if (!resumed) return
  session = resumed
  paintConnect()
  render()
}
restoreSession()
