// LFOwn — the launch flow. No framework: four sections and a state object.

import { available, connect, reconnect, forget, showIcon } from './wallet.js'
import { esc, safeUrl } from './escape.js'
import { explain } from './errors.js'
import { TIERS, LEGACY_FEE_BPS, feeBreakdown } from '../lib/config.mjs'

const state = {
  asset: null,
  token: {},
  curve: { tier: null, threshold: 0, devBuy: 0, devBuyQuote: 0 },
  // The ground mint seed, once the search has found one. See startVanity.
  vanity: null,
  seed: null,
  configs: {},
  // How the dev buy gets paid for: the ownership coin itself, or SOL/USDC routed
  // into it through Jupiter first. `priced` is the live quote for the shortfall.
  funding: { via: null, priced: null, have: 0 },
}

const $ = (sel) => document.querySelector(sel)
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US')
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d })
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`

// The theme is handled by the header's own script: there are two toggles now, one
// in the bar and one in the drawer, and binding a single id here would have left
// the drawer's dead.

// ── steps ────────────────────────────────────────────────────────────────────
let reached = 1
function go(n) {
  if (n > reached) return
  document.querySelectorAll('.step').forEach((s) => s.classList.toggle('on', +s.dataset.step === n))
  document.querySelectorAll('#stepper button').forEach((b) => {
    const i = +b.dataset.go
    b.disabled = i > reached
    if (i === n) b.setAttribute('aria-current', 'step')
    else b.removeAttribute('aria-current')
  })
  if (n === 3) paintCurve()
  if (n === 4) { paintReview(); paintWallet() }
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
const unlock = (n) => { reached = Math.max(reached, n); go(n) }

document.querySelectorAll('#stepper button').forEach((b) => b.addEventListener('click', () => go(+b.dataset.go)))
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => go(+b.dataset.back)))
$('#to3').addEventListener('click', () => { unlock(3); startVanity() })
$('#to4').addEventListener('click', () => unlock(4))

// ── 01 · the backing assets ──────────────────────────────────────────────────
async function loadAssets() {
  const box = $('#assets')
  let coins
  try {
    ({ coins } = await fetch('/api/quote-assets').then((r) => r.json()))
  } catch {
    box.innerHTML = '<p class="skel">Could not reach the registry. Reload to try again.</p>'
    return
  }

  box.innerHTML = ''
  for (const c of coins) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'qcard'
    card.setAttribute('aria-pressed', 'false')
    card.dataset.search = `${c.symbol} ${c.name ?? ''}`.toLowerCase()
    card.innerHTML = `
      <div class="top">
        ${c.icon ? `<img src="${safeUrl(c.icon)}" alt="" loading="lazy">` : ''}
        <div><div class="sym">${esc(c.symbol)}</div><div class="name">${esc(c.name ?? '')}</div></div>
      </div>
      <dl>
        <div class="treasury"><dt>Treasury</dt><dd>${usd(c.treasury)}</dd></div>
        <div><dt>Liquidity</dt><dd>${usd(c.liquidity)}</dd></div>
        <div><dt>Holders</dt><dd>${c.holders.toLocaleString('en-US')}</dd></div>
        <div><dt>Price</dt><dd>$${c.usdPrice < 1 ? c.usdPrice.toFixed(4) : c.usdPrice.toFixed(2)}</dd></div>
      </dl>`
    card.addEventListener('click', () => select(c, card))
    box.appendChild(card)
  }
}

// Picking a backing coin is the whole of step one, so the click is the answer —
// there is nothing left to confirm with a Continue button.
function select(coin, card) {
  state.asset = coin
  document.querySelectorAll('.qcard').forEach((c) => c.setAttribute('aria-pressed', 'false'))
  card.setAttribute('aria-pressed', 'true')
  unlock(2)
}

const search = $('#asset-search')
search.addEventListener('input', () => {
  const needle = search.value.trim().toLowerCase()
  let shown = 0
  document.querySelectorAll('.qcard').forEach((card) => {
    const hit = !needle || card.dataset.search.includes(needle)
    card.hidden = !hit
    if (hit) shown++
  })
  $('#no-match').hidden = shown > 0
})

// ── 02 · token details ───────────────────────────────────────────────────────
const fields = { name: '#f-name', symbol: '#f-symbol', desc: '#f-desc', x: '#f-x', site: '#f-site' }
for (const [key, sel] of Object.entries(fields)) {
  $(sel).addEventListener('input', (e) => {
    state.token[key] = e.target.value.trim()
    $('#to3').disabled = !(state.token.name && state.token.symbol)
  })
}

const drop = $('#drop'), fileInput = $('#f-file'), preview = $('#preview')
const imageStatus = $('#image-status'), clearBtn = $('#clear-image')

$('#pick').addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => fileInput.files[0] && upload(fileInput.files[0]))
;['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over') }))
;['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, () => drop.classList.remove('over')))
drop.addEventListener('drop', (ev) => { ev.preventDefault(); const f = ev.dataTransfer.files[0]; if (f) upload(f) })

clearBtn.addEventListener('click', () => {
  // The uploaded object stays in R2 on purpose: keys are unguessable, and exposing
  // a delete endpoint would let anyone break the image of a token already launched.
  state.token.image = undefined
  fileInput.value = ''
  preview.hidden = true
  preview.removeAttribute('src')
  clearBtn.hidden = true
  imageStatus.textContent = ''
})

async function upload(file) {
  if (file.size > 2 * 1024 * 1024) return (imageStatus.textContent = 'That file is over 2 MB.')
  preview.src = URL.createObjectURL(file)
  preview.hidden = false
  clearBtn.hidden = false
  imageStatus.textContent = 'Uploading…'
  try {
    const res = await fetch('/api/image', { method: 'POST', headers: { 'content-type': file.type }, body: file })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? 'upload failed')
    state.token.image = body.url
    imageStatus.textContent = 'Uploaded.'
  } catch (e) {
    imageStatus.textContent = e.message
  }
}

// ── the address ──────────────────────────────────────────────────────────────
/**
 * Every coin launched here gets a mint address ending in `own`, found by generating
 * keys until one does — roughly 195,000 tries for three base58 characters.
 *
 * Started when the creator opens the curve step, which buys the search the half
 * minute they spend choosing a tier: by the time they sign it is long done. It runs
 * on this machine and the winning key never leaves it.
 */
function startVanity() {
  if (state.vanity) return
  const say = (text) => { const el = $('#vanity'); if (el) el.textContent = text }
  import('./vanity.js').then(({ grind, SUFFIX }) => {
    const run = grind(SUFFIX, { onProgress: (n) => say(`Looking for an address ending in ${SUFFIX} — ${n.toLocaleString('en-US')} tried…`) })
    state.vanity = run
    run.promise
      .then((seed) => { state.seed = seed; say('') })
      .catch((e) => {
        // A launch is worth more than a pretty address.
        console.error('vanity search failed:', e.message)
        state.vanity = null
        say('')
      })
  }).catch((e) => console.error('vanity module unavailable:', e.message))
}

// ── 03 · the curve ───────────────────────────────────────────────────────────
async function paintCurve() {
  const a = state.asset
  const box = $('#tiers')
  box.innerHTML = '<span class="skel">Loading tiers…</span>'

  let configs = {}
  try {
    ({ configs } = await fetch(`/api/config/${a.mint}`).then((r) => r.json()))
  } catch { /* every tier will simply read as closed */ }

  state.configs = configs
  box.innerHTML = ''

  // Only tiers LFOwn has actually opened. A row of "not open yet" cards is noise:
  // a creator cannot act on it and it makes the catalogue look half-built.
  const open = TIERS.filter((t) => configs[t.id])
  for (const tier of open) {
    const cfg = configs[tier.id]
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tier'
    btn.setAttribute('aria-pressed', 'false')
    btn.innerHTML = `
      <span class="t-name">${tier.label}</span>
      <span class="t-usd">${cfg.threshold.toLocaleString('en-US')} ${esc(a.symbol)}</span>
      <span class="t-sub">≈ ${usd(cfg.threshold * a.usdPrice)} at today's price</span>`
    btn.addEventListener('click', () => {
      state.curve.tier = tier.id
      state.curve.threshold = cfg.threshold
      document.querySelectorAll('.tier').forEach((t) => t.setAttribute('aria-pressed', 'false'))
      btn.setAttribute('aria-pressed', 'true')
      $('#to4').disabled = false
      priceDevBuy(a)
    })
    box.appendChild(btn)
  }

  // Starter first: it is the tier most launches want, and preselecting it makes the
  // common path two clicks rather than three.
  box.querySelector('.tier')?.click()

  if (!open.length) {
    $('#to4').disabled = true
    $('#tier-hint').textContent =
      `${a.symbol} is listed but no tier is open for it yet. LFOwn has to open one before anyone can launch against it.`
  }

  let timer
  $('#f-devbuy').addEventListener('input', () => {
    state.curve.devBuy = Number($('#f-devbuy').value || 0)
    clearTimeout(timer)
    timer = setTimeout(() => priceDevBuy(a), 300)
  })
}

/**
 * A percentage of supply means nothing until you know what it costs. The curve is
 * not open yet, so the price comes from simulating the curve this config opens with.
 */
async function priceDevBuy(asset) {
  const hint = $('#devbuy-cost')
  const percent = state.curve.devBuy
  if (!percent || !state.configs?.[state.curve.tier]) {
    state.curve.devBuyQuote = 0
    state.funding.priced = null
    hint.textContent = 'Bought atomically with the launch, so nobody can front-run you.'
    return
  }

  hint.textContent = 'Pricing…'
  try {
    const { devBuyCost } = await import('./launchpad.js')
    const cost = await devBuyCost({ config: state.configs[state.curve.tier].config, percent })
    state.curve.devBuyQuote = cost.quoteIn
    state.funding.priced = null // the shortfall moved; whatever was quoted for it is stale
    hint.innerHTML = `<b>${fmt(cost.baseOut)} ${esc(state.token.symbol || 'tokens')}</b> — costs about
      <b>${fmt(cost.quoteIn, 4)} ${esc(asset.symbol)}</b> (${usd(cost.quoteIn * asset.usdPrice)}),
      bought atomically with the launch so nobody can front-run you.`
  } catch (e) {
    state.curve.devBuyQuote = 0
    state.funding.priced = null
    hint.innerHTML = `<span class="warn-text">Could not price that dev buy: ${esc(explain(e, 'dev buy quote'))}</span>`
  }
}

/**
 * Price impact worth mentioning. Ownership coins are thin, and a dev buy large
 * enough to move one costs real money before the launch has even opened — but
 * quoting a fraction of a percent on every trade is noise.
 */
const impact = (p) => (p.impactPct >= 0.5 ? `, ${p.impactPct.toFixed(2)}% price impact` : '')

// ── paying for the dev buy ───────────────────────────────────────────────────
/**
 * A dev buy is denominated in the ownership coin, and most people arrive holding
 * SOL or USDC instead. Rather than turn them away, price the shortfall through
 * Jupiter and swap it in its own transaction just before the launch.
 *
 * Only the shortfall: someone who already holds part of what they need should not
 * be made to buy the whole amount again.
 */
let fundingRun = 0
async function paintFunding() {
  const box = $('#funding')
  const a = state.asset
  const need = state.curve.devBuyQuote ?? 0
  const f = state.funding

  // No dev buy, no ownership coin has to change hands — the launch itself is paid
  // for in SOL rent, which every wallet already has. Nothing to choose.
  if (!a || need <= 0) { box.hidden = true; f.priced = null; return }
  box.hidden = false

  const { PAY_WITH, payWith, balanceOf, inputFor, GAS_RESERVE } = await import('./funding.js')
  if (!f.via) f.via = a.mint

  // Balances and quotes come back out of order, and the person may have clicked
  // another currency in the meantime. Only the newest run is allowed to write.
  const run = ++fundingRun
  const options = [{ mint: a.mint, symbol: a.symbol }, ...PAY_WITH]

  box.innerHTML = `<span class="lab">Paying the ${fmt(need, 4)} ${esc(a.symbol)} dev buy</span>
    <div class="pay">${options.map((o) =>
      `<button type="button" data-mint="${esc(o.mint)}" aria-pressed="${String(o.mint === f.via)}">${esc(o.symbol)}</button>`).join('')}</div>
    <p class="detail" id="funding-detail">Checking your wallet…</p>`

  box.querySelectorAll('.pay button').forEach((b) => b.addEventListener('click', () => {
    f.via = b.dataset.mint
    paintFunding()
  }))

  const detail = (html) => { if (run === fundingRun) $('#funding-detail').innerHTML = html }

  if (!session) {
    detail(`Pay in <b>${esc(a.symbol)}</b> if you hold it, or in <b>SOL</b> or <b>USDC</b> — Jupiter
      swaps it into ${esc(a.symbol)} first. Connect your wallet to see what you have.`)
    return
  }

  try {
    const { connection } = await import('./launchpad.js')
    const have = await balanceOf(connection, session.address, a.mint)
    if (run !== fundingRun) return
    f.have = have
    const short = Math.max(0, need - have)

    if (f.via === a.mint) {
      f.priced = null
      detail(short
        ? `You hold <b>${fmt(have, 4)} ${esc(a.symbol)}</b> — <b>${fmt(short, 4)}</b> short.
           Pay with SOL or USDC and Jupiter covers the difference.`
        : `You hold <b>${fmt(have, 4)} ${esc(a.symbol)}</b>. Enough — nothing to swap.`)
      return
    }

    const pay = payWith(f.via)
    if (!short) {
      f.priced = null
      detail(`You already hold <b>${fmt(have, 4)} ${esc(a.symbol)}</b>, enough for this dev buy.
        No ${esc(pay.symbol)} will be spent.`)
      return
    }

    detail(`Pricing ${fmt(short, 4)} ${esc(a.symbol)} in ${esc(pay.symbol)}…`)
    const [priced, funds] = await Promise.all([
      inputFor({ pay, coinMint: a.mint, want: short }),
      balanceOf(connection, session.address, pay.mint, { native: pay.native }),
    ])
    if (run !== fundingRun) return
    f.priced = priced

    const reserve = pay.native ? GAS_RESERVE.launch : 0
    const dp = pay.native ? 5 : 2
    const enough = funds - reserve >= priced.in
    detail(`<b>${fmt(priced.in, dp)} ${esc(pay.symbol)}</b> buys about
      <b>${fmt(priced.out, 4)} ${esc(a.symbol)}</b> via ${esc(priced.route || 'Jupiter')}${impact(priced)}.<br>` + (enough
      ? `You hold ${fmt(funds, dp)} ${esc(pay.symbol)}${reserve ? `, of which ${reserve} stays back for rent and fees` : ''}.
         Two signatures: the swap, then the launch.`
      : `<span class="warn-text">You hold ${fmt(funds, dp)} ${esc(pay.symbol)}${reserve
          ? `, and ${reserve} of that stays back for rent and fees` : ''} — not enough.</span>`))
  } catch (e) {
    if (run !== fundingRun) return
    f.priced = null
    detail(`<span class="warn-text">${esc(explain(e, 'funding quote'))}</span>`)
  }
}

// ── 04 · review ──────────────────────────────────────────────────────────────
function paintReview() {
  const { asset: a, token: t, curve: c } = state
  const line = (k, v) => `<div class="line"><span>${k}</span><span>${v}</span></div>`

  // The fee is read from the config that will actually charge it, not from what the
  // code currently intends: configs are immutable and older ones charge less.
  const cfg = state.configs?.[c.tier] ?? {}
  const feeBps = cfg.feeBps ?? LEGACY_FEE_BPS
  const creatorShare = cfg.creatorSharePct ?? 50

  $('#review').innerHTML =
    `<div class="head">${esc(t.symbol || '—')} paired with ${esc(a.symbol)}</div>` +
    line('Token', `${esc(t.name || '—')} · ${esc(t.symbol || '—')}`) +
    line('Paired with', esc(a.symbol)) +
    line(`Treasury of ${esc(a.symbol)}`, usd(a.treasury)) +
    line('Graduation target', `${c.threshold.toLocaleString('en-US')} ${esc(a.symbol)} ≈ ${usd(c.threshold * a.usdPrice)} today`) +
    line('Dev buy', c.devBuy ? `${c.devBuy}% of supply — ${fmt(c.devBuyQuote, 4)} ${esc(a.symbol)}` : 'none') +
    line('Trading fee', (() => {
      // Meteora's cut comes off the top, so the split is of what remains.
      const cut = feeBreakdown(feeBps, creatorShare)
      const pc = (b) => `${(b / 100).toFixed(2).replace(/\.?0+$/, '')}%`
      return `${feeBps / 100}% per trade — ${pc(cut.creator)} to you, ${pc(cut.partner)} to the LFOwn DAO, ${pc(cut.protocol)} to Meteora`
    })())
}

// ── wallet ───────────────────────────────────────────────────────────────────
let session = null
const connectBtn = $('#connect')
const menu = $('#wallet-menu')

/** One wallet: use it. Several: let the person say which one. */
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
  return session
}

function paintConnect() {
  if (session) {
    connectBtn.textContent = short(session.address)
    connectBtn.title = `${session.name} — ${session.address}`
    connectBtn.disabled = false
    $('#wallet-addr').textContent = session.address
    return
  }
  menu.hidden = true
  const found = available()
  connectBtn.textContent = found.length ? 'Connect wallet' : 'No wallet found'
  connectBtn.disabled = !found.length
}

function paintWallet() {
  paintConnect()
  paintFunding()
  if (session) {
    signBtn.textContent = `Launch ${state.token.symbol ?? ''} as ${short(session.address)}`.trim()
    signBtn.disabled = false
    return
  }
  // Naming a wallet here promised a launch and delivered a connection prompt.
  signBtn.textContent = available().length ? 'Connect wallet' : 'No wallet detected'
  signBtn.disabled = !available().length
}

// Extensions can register after the page has loaded — repaint when they do, so the
// button is never left dead next to a wallet that is actually there.
window.addEventListener('wallet-standard:register-wallet', () => setTimeout(() => { paintConnect(); paintWallet() }, 0))
document.addEventListener('click', (e) => { if (!e.target.closest('.wallet-slot')) menu.hidden = true })

connectBtn.addEventListener('click', async () => {
  // Connected, the button is no longer a connect button: it is the account.
  if (session) { menu.hidden = !menu.hidden; return }
  connectBtn.textContent = 'Connecting…'
  try { await ensureWallet() } catch (e) { connectBtn.textContent = e.message }
  paintConnect()
  paintWallet()
})

menu.addEventListener('click', async (e) => {
  const act = e.target.dataset?.act
  if (!act || !session) return
  if (act === 'copy') {
    try {
      await navigator.clipboard.writeText(session.address)
      e.target.textContent = 'Copied'
      setTimeout(() => { e.target.textContent = 'Copy address' }, 1200)
    } catch { e.target.textContent = 'Copy failed' }
    return
  }
  try { await session.disconnect?.() } catch { /* drop it locally either way */ }
  forget()
  session = null
  menu.hidden = true
  paintConnect()
  paintWallet()
})

// ── signing ──────────────────────────────────────────────────────────────────
const signBtn = $('#sign')
const status = $('#sign-status')
const say = (msg, kind = '') => { status.innerHTML = msg; status.className = 'hint ' + kind }

signBtn.addEventListener('click', async () => {
  const a = state.asset
  signBtn.disabled = true
  try {
    say('Connecting wallet…')
    const wallet = await ensureWallet()
    paintConnect()
    paintWallet()

    // The web3/DBC bundle is most of the payload and nobody browsing the catalogue
    // needs it, so it only loads once someone actually launches.
    const { configFor, buildLaunch, sendWithMint, connection } = await import('./launchpad.js')

    say(`Checking that ${esc(a.symbol)} is open for launches…`)
    const config = await configFor(a.mint, state.curve.tier)
    if (!config) {
      say(`${esc(a.symbol)} has no launch config yet. LFOwn has to open one for this coin before anyone can launch against it.`, 'warn-text')
      signBtn.disabled = false
      return
    }

    // Opening a pool pays rent for a mint, a metadata account, the pool and two
    // vaults. Checking it here turns "custom program error: 0x1" buried in a
    // simulation log into a number the person can act on.
    {
      const { balanceOf, NATIVE_SOL, LAUNCH_SOL } = await import('./funding.js')
      const sol = await balanceOf(connection, wallet.address, NATIVE_SOL, { native: true })
      if (sol < LAUNCH_SOL) {
        say(`Opening a pool costs about <b>${LAUNCH_SOL} SOL</b> in rent and fees, and this wallet holds
          <b>${fmt(sol, 4)}</b>. Send it a little SOL and try again.`, 'warn-text')
        signBtn.disabled = false
        return
      }
    }

    // The dev buy is denominated in the ownership coin. If it is being paid in SOL
    // or USDC, that swap is its own transaction and has to land first — see the note
    // at the top of funding.js for why it cannot be folded into the launch.
    let devBuy = state.curve.devBuyQuote ?? 0
    if (devBuy > 0) {
      const { balanceOf, inputFor, topUp, payWith } = await import('./funding.js')
      let have = await balanceOf(connection, wallet.address, a.mint)
      const pay = state.funding.via === a.mint ? null : payWith(state.funding.via)

      if (pay && have < devBuy) {
        // Repriced against the balance as it stands rather than reused from the
        // screen: the panel's quote may be minutes old and the shortfall may have moved.
        say(`Pricing the ${esc(pay.symbol)} swap…`)
        const priced = await inputFor({ pay, coinMint: a.mint, want: devBuy - have })
        const { received } = await topUp({ connection, wallet, coinMint: a.mint, priced, say })
        have += received
        paintFunding()
      }

      if (have < devBuy) {
        say(`You hold ${fmt(have, 4)} ${esc(a.symbol)} and the dev buy needs ${fmt(devBuy, 4)}.
          Top up with SOL or USDC, or lower the dev buy.`, 'warn-text')
        signBtn.disabled = false
        return
      }
    }

    say('Publishing token metadata…')
    const { uri } = await fetch('/api/metadata', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: state.token.name, symbol: state.token.symbol,
        description: state.token.desc, image: state.token.image,
        website: state.token.site, twitter: state.token.x,
      }),
    }).then((r) => r.json())

    if (state.vanity && !state.seed) {
      say(`Finishing the search for an address ending in own…`)
      // Bounded: a slow machine should still be able to launch, with a plain address.
      state.seed = await Promise.race([
        state.vanity.promise,
        new Promise((r) => setTimeout(() => r(null), 45_000)),
      ]).catch(() => null)
      if (!state.seed) {
        state.vanity.cancel()
        console.warn('vanity search gave up; launching with a random address')
      }
    }

    say('Building the launch transaction…')
    const { transaction, mint, baseMint } = await buildLaunch({
      config,
      owner: wallet.address,
      token: { name: state.token.name, symbol: state.token.symbol, uri: uri ?? '' },
      devBuyQuote: Math.round(devBuy * 1e6),
      seed: state.seed,
    })

    say('Waiting for your signature…')
    // Wallet first, mint second: a transaction handed to Phantom with a signature
    // slot it cannot account for is one it will not simulate, and it warns about it.
    const signedBytes = await wallet.signOnly(transaction)
    let signature
    if (signedBytes) {
      signature = await sendWithMint(signedBytes, mint)
    } else {
      // A wallet that can only sign-and-send gets the old order rather than nothing.
      transaction.partialSign(mint)
      signature = await wallet.signAndSend(transaction, connection)
    }
    // Confirmed before the link is offered. The coin page reads a coin the list
    // does not know from chain and remembers a miss for five minutes, so a click a
    // second too early used to show "no pool" until then.
    say(`Sent — waiting for the network to confirm (signature ${signature.slice(0, 12)}…)`)
    const { confirm } = await import('./funding.js')
    await confirm(connection, signature, { what: 'The launch' })
    say(`Launched — <a href="/coins/${baseMint}" style="color:var(--red)">open your coin</a> (signature ${signature.slice(0, 12)}…)`, 'ok-text')
    signBtn.textContent = 'Launched'

    // Told now, once there is a pool for it to find. The keeper adds the coin to the
    // cached list, which is what lets the minute-by-minute watcher follow it — a dev
    // buy big enough to take the whole raise fills the curve on the way in, and the
    // watcher would otherwise not see it until the catalogue next rebuilds. It
    // answers "not full yet" harmlessly the rest of the time.
    fetch('/api/graduate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mint: baseMint }),
    }).catch((e) => console.error('graduation check after launch failed:', e.message))
  } catch (e) {
    say(esc(explain(e, 'launch')), 'warn-text')
    signBtn.disabled = false
  }
})

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
  paintWallet()
}
restoreSession()

loadAssets()
