// LFOwn — the launch flow. No framework: three sections and a state object.

import { available, connect, reconnect, forget, showIcon } from './wallet.js'
import { esc, safeUrl } from './escape.js'
import { explain } from './errors.js'
import { TIERS, FEES, tokenUnit } from '../lib/config.mjs'

const state = {
  asset: null,
  token: {},
  // The LFOwn DAO takes half of every fee; of the other half, holders take three
  // quarters and the creator one — 37.5 and 12.5 of the 50. It used to be a slider, and
  // a choice nobody arriving from a tweet has an opinion on is a reason to leave.
  // Without a pot address there is nowhere to collect their part, so the creator keeps it all.
  curve: { tier: null, threshold: 0, devBuy: 0, devBuyQuote: 0, holders: FEES.holderPot ? 37.5 : 0 },
  // The ground mint seed, once the search has found one. See startVanity.
  vanity: null,
  seed: null,
  configs: {},
  // How the dev buy gets paid for: the ownership coin itself, or SOL/USDC routed
  // into it through Jupiter first. `priced` is the live quote for the shortfall.
  funding: { via: null, priced: null, have: 0 },
  // A random backing was drawn and its name is being kept off the screen. It has to
  // come back into the open before the first signature: the swap and the launch both
  // name the mint, and the wallet will show it whatever this flag says.
  blind: false,
}

const $ = (sel) => document.querySelector(sel)
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US')
const price = (n) => '$' + (n < 1 ? n.toFixed(4) : n.toFixed(2))

/**
 * What stands behind a backing coin, as a short label and a figure. An ownership coin
 * has a treasury; a coin listed by hand says what it has instead — a dinosaur, so far.
 */
const backing = (a) => a.backing
  ? { label: 'Backed by', value: a.backing.label.replace(/^A /, ''), usd: a.backing.usd }
  : { label: 'Treasury', value: usd(a.treasury), usd: a.treasury }
/** A price nobody has traded at yet is the raise's, and says so. */
const priceOf = (a) => price(a.usdPrice) + (a.priceSource === 'reference' ? ' raise' : '')
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d })
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`
/**
 * The backing coin's name, or a placeholder while a random draw is being kept back.
 * Every line that would print the symbol goes through here, so hiding it is one flag
 * rather than a rule each of them has to remember.
 */
const sym = () => (state.blind ? '???' : (state.asset?.symbol ?? '—'))

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
  $('#flow').dataset.step = String(n)
  if (n === 3) { paintReview(); paintWallet(); loadTiers() }
  paintPaired(n)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
const unlock = (n) => { reached = Math.max(reached, n); go(n) }

/**
 * The backing coin, named above steps two and three. A random draw stays hidden here
 * too: the name comes out at signing, not on a banner.
 */
function paintPaired(n = +document.querySelector('.step.on')?.dataset.step) {
  const box = $('#paired')
  const a = state.asset
  box.hidden = !a || n < 2
  if (box.hidden) return
  box.innerHTML = state.blind
    ? `<span class="dice">?</span>
       <span class="what">Paired with <b>a random ownership coin</b><br><small>Revealed before you sign.</small></span>`
    : `${a.icon ? `<img src="${safeUrl(a.icon)}" alt="">` : ''}
       <span class="what">Paired with <b>${esc(a.symbol)}</b>${a.name ? ` <small>${esc(a.name)}</small>` : ''}<br>
       <small>${backing(a).label} ${esc(backing(a).value)} · ${priceOf(a)}</small></span>`
  const change = document.createElement('button')
  change.type = 'button'
  change.className = 'change'
  change.textContent = 'Change'
  change.addEventListener('click', () => go(1))
  box.appendChild(change)
}

document.querySelectorAll('#stepper button').forEach((b) => b.addEventListener('click', () => go(+b.dataset.go)))
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => go(+b.dataset.back)))
$('#to3').addEventListener('click', () => { unlock(3); startVanity() })

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

  // First tile, before any coin: a draw made here, in this browser, with the
  // platform's own CSPRNG. Nothing about it is decided on our side.
  const wild = document.createElement('button')
  wild.type = 'button'
  wild.className = 'qcard wild'
  wild.setAttribute('aria-pressed', 'false')
  wild.dataset.search = 'random surprise mystery lucky dip'
  wild.innerHTML = `
    <div class="top">
      <div class="dice">?</div>
      <div><div class="sym">Random</div><div class="name">Let the draw decide</div></div>
    </div>
    <p class="wild-note" id="wild-note">One of the ${coins.length} coins beside this one. Which one
      stays off this screen until you sign.</p>`
  wild.addEventListener('click', () => drawRandom(wild, coins))
  box.appendChild(wild)

  for (const c of coins) {
    const f = c.financials
    const card = document.createElement('button')
    card.type = 'button'
    card.className = c.backing ? `qcard featured ${c.backing.kind}` : 'qcard'
    card.setAttribute('aria-pressed', 'false')
    card.dataset.search = `${c.symbol} ${c.name ?? ''} ${c.backing ? `${c.backing.kind} ${c.backing.label} ${c.backing.project}` : ''}`.toLowerCase()
    card.dataset.mint = c.mint
    card.dataset.symbol = c.symbol.toLowerCase()
    card.innerHTML = c.backing ? `
      <div class="top">
        ${c.icon ? `<img src="${safeUrl(c.icon)}" alt="" loading="lazy">` : ''}
        <div><div class="sym">${esc(c.symbol)}</div><div class="name">${esc(c.name ?? '')}</div></div>
      </div>
      <p class="badge">New · launch against a ${esc(c.backing.kind)}</p>
      <dl>
        <div class="treasury"><dt title="${esc(c.backing.detail ?? '')}">Backed by</dt><dd>${esc(c.backing.label.replace(/^A /, ''))}</dd></div>
        <div><dt>Raised</dt><dd>${usd(c.backing.raised)}</dd></div>
        <div><dt>Holders</dt><dd>${c.holders.toLocaleString('en-US')}</dd></div>
        <div><dt title="${c.priceSource === 'reference' ? 'What its raise paid per token; it has no market yet' : 'Market price'}">Price</dt><dd>${priceOf(c)}</dd></div>
      </dl>` : `
      <div class="top">
        ${c.icon ? `<img src="${safeUrl(c.icon)}" alt="" loading="lazy">` : ''}
        <div><div class="sym">${esc(c.symbol)}</div><div class="name">${esc(c.name ?? '')}</div></div>
      </div>
      <dl>
        <div class="treasury"><dt title="${f ? 'Every DAO wallet and LP position, from 01Resolved' : 'The treasury vault, from MetaDAO'}">Treasury</dt><dd>${usd(c.treasury)}</dd></div>
        <div><dt>Liquidity</dt><dd>${usd(c.liquidity)}</dd></div>
        <div><dt>Holders</dt><dd>${c.holders.toLocaleString('en-US')}</dd></div>
        <div><dt>Price</dt><dd>${price(c.usdPrice)}</dd></div>
      </dl>`
    card.addEventListener('click', () => select(c, card))

    // A link cannot sit inside a button, so the card and its link share a slot in the grid.
    const slot = document.createElement('div')
    slot.className = 'qitem'
    slot.appendChild(card)
    if (c.backing?.url) {
      const link = document.createElement('a')
      link.className = 'fin'
      link.href = safeUrl(c.backing.url)
      link.target = '_blank'
      link.rel = 'noopener'
      link.title = `${c.symbol} on ${c.backing.project}`
      link.setAttribute('aria-label', link.title)
      link.innerHTML = `<span>View on ${esc(c.backing.project)}</span>`
      slot.appendChild(link)
    } else if (f?.url) {
      // A mark in the card's corner rather than a line of text under every card: laid over
      // the button, not inside it, since a link cannot be nested in one.
      const link = document.createElement('a')
      link.className = 'fin'
      link.href = safeUrl(f.url)
      link.target = '_blank'
      link.rel = 'noopener'
      link.title = `Full financials of ${c.symbol} on 01Resolved`
      link.setAttribute('aria-label', link.title)
      link.innerHTML = '<span>View on 01Resolved</span><img src="/assets/01resolved.png" alt="" width="20" height="20">'
      slot.appendChild(link)
    }
    box.appendChild(slot)
  }
}

/**
 * An unbiased index. `getRandomValues() % n` favours the low indices whenever n does
 * not divide 2^32; the coins near the top of the catalogue would come up slightly
 * more often, which is exactly the kind of thumb on the scale this tile must not have.
 */
function pickIndex(n) {
  const ceiling = Math.floor(0x1_0000_0000 / n) * n
  const buf = new Uint32Array(1)
  do { crypto.getRandomValues(buf) } while (buf[0] >= ceiling)
  return buf[0] % n
}

/**
 * Draws a backing coin and keeps its name back.
 *
 * Only coins with a tier already open are eligible: landing on one without would
 * dead-end step three, and explaining why would mean naming the coin.
 */
async function drawRandom(card, coins) {
  const note = $('#wild-note')
  note.textContent = 'Drawing…'
  const pool = coins.slice()
  while (pool.length) {
    const [coin] = pool.splice(pickIndex(pool.length), 1)
    const configs = await fetch(`/api/config/${coin.mint}`)
      .then((r) => r.json()).then((b) => b.configs).catch(() => null)
    if (configs && TIERS.some((t) => configs[t.id])) {
      state.blind = true
      note.innerHTML = 'Drawn. Its name stays hidden until the moment you sign.'
      select(coin, card)
      return
    }
  }
  note.innerHTML = '<span class="warn-text">No coin has a tier open right now. Pick one by hand.</span>'
}

// Picking a backing coin is the whole of step one, so the click is the answer —
// there is nothing left to confirm with a Continue button.
function select(coin, card) {
  // A named tile clears any draw still standing from an earlier click.
  if (!card.classList.contains('wild')) state.blind = false
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
    ;(card.closest('.qitem') ?? card).hidden = !hit
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
const dropEmpty = $('#drop-empty'), dropFrame = preview.parentElement

/** Puts an image in the frame, or empties it. */
function showImage(src) {
  preview.hidden = !src
  dropEmpty.hidden = Boolean(src)
  clearBtn.hidden = !src
  if (src) preview.src = src
  else preview.removeAttribute('src')
}

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
  showImage(null)
  imageStatus.textContent = ''
})

async function upload(file) {
  if (file.size > 2 * 1024 * 1024) return (imageStatus.textContent = 'That file is over 2 MB.')
  randomRun++ // a picture of their own beats one still being drawn
  dropFrame.classList.remove('drawing')
  showImage(URL.createObjectURL(file))
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

// ── random coin ──────────────────────────────────────────────────────────────
/**
 * For someone with no idea: a ticker that is also the name, a description about it and
 * a picture of it, invented together on our side (src/lib/random-token.mjs). The words
 * arrive first and fill the form; the picture follows a few seconds later. Pressing
 * again replaces all of it, and whatever arrives for an earlier press is dropped.
 */
let randomRun = 0
const randomBtn = $('#randomize')
randomBtn.addEventListener('click', async () => {
  const run = ++randomRun
  const label = $('#randomize-label')
  randomBtn.disabled = true
  randomBtn.classList.add('busy')
  label.textContent = 'Inventing a coin…'
  try {
    const res = await fetch('/api/random/idea', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const idea = await res.json()
    if (!res.ok) throw new Error(idea.error ?? 'no idea came back')
    if (run !== randomRun) return
    const values = { name: idea.name, symbol: idea.symbol, desc: idea.description }
    for (const [key, value] of Object.entries(values)) {
      const input = $(fields[key])
      input.value = value
      input.dispatchEvent(new Event('input'))
    }

    label.textContent = 'Drawing its picture…'
    state.token.image = undefined
    fileInput.value = ''
    dropFrame.classList.add('drawing')
    imageStatus.textContent = ''
    const pic = await fetch('/api/random/image', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: idea.id }),
    })
    const drawn = await pic.json()
    if (run !== randomRun) return
    if (!pic.ok) throw new Error(drawn.error ?? 'the picture did not come out')
    state.token.image = drawn.url
    showImage(drawn.url)
    imageStatus.textContent = 'Drawn for you. Keep it, upload your own, or roll again.'
  } catch (e) {
    if (run === randomRun) imageStatus.innerHTML = `<span class="warn-text">${esc(e.message)}</span>`
  } finally {
    if (run === randomRun) {
      dropFrame.classList.remove('drawing')
      randomBtn.disabled = false
      randomBtn.classList.remove('busy')
      label.textContent = state.token.name ? 'Roll again' : 'No idea? Random coin'
    }
  }
})

// ── the address ──────────────────────────────────────────────────────────────
/**
 * Every coin launched here gets a mint address ending in `own`, found by generating
 * keys until one does — roughly 195,000 tries for three base58 characters.
 *
 * Started as soon as the page opens. A few seconds of searching on arrival costs a
 * visitor who only browses very little, and waiting until the token step meant a
 * creator who filled it in quickly reached the sign button while it was still going. It runs
 * on this machine and the winning key never leaves it.
 */
function startVanity() {
  if (state.vanity) return
  // Quiet while it runs: it starts on arrival and is nearly always done before anyone
  // signs, so a live counter was only ever a line of noise pushing the button down.
  const say = (text) => { const el = $('#vanity'); if (el) el.textContent = text }
  import('./vanity.js').then(({ grind, SUFFIX }) => {
    const run = grind(SUFFIX)
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

// ── 03 · target and dev buy ──────────────────────────────────────────────────
/**
 * The raise target, now part of the review. Starter is picked for the creator — it
 * is what nearly every launch wants — and the others appear as a small switch only
 * when LFOwn has opened them for this coin.
 */
let tiersFor = null
async function loadTiers() {
  const a = state.asset
  if (!a) return
  if (tiersFor !== a.mint) {
    tiersFor = a.mint
    state.configs = null // loading
    state.curve.tier = null
    state.curve.threshold = 0
    paintReview()
    let configs = {}
    try {
      ;({ configs } = await fetch(`/api/config/${a.mint}`).then((r) => r.json()))
    } catch { /* every tier simply reads as closed */ }
    if (tiersFor !== a.mint) return // the backing changed while this was loading
    state.configs = configs ?? {}
  }
  if (!state.configs) return
  const open = TIERS.filter((t) => state.configs?.[t.id])
  if (!open.some((t) => t.id === state.curve.tier)) {
    // A draft an agent prepared names its tier; it wins while it is still open.
    const wanted = open.find((t) => t.id === state.draft?.tier) ?? open[0]
    pickTier(wanted?.id ?? null)
  } else {
    paintReview()
  }
}

function pickTier(id) {
  const cfg = id ? state.configs[id] : null
  state.curve.tier = cfg ? id : null
  state.curve.threshold = cfg?.threshold ?? 0
  paintReview()
  paintWallet()
  priceDevBuy(state.asset)
}

// `max` on a number input only stops the steppers — it does not stop typing, and a
// dev buy of 90% asked the curve for more tokens than it holds. Clamped here so
// nothing above the cap is ever priced or signed.
const DEV_BUY_MAX = 50
{
  let timer
  const input = $('#f-devbuy')
  const cap = $('#devbuy-cap')
  const chips = [...document.querySelectorAll('#devbuy-chips button')]
  const setPct = (pct, { fromInput = false } = {}) => {
    state.curve.devBuy = Math.min(DEV_BUY_MAX, Math.max(0, pct))
    for (const c of chips) c.setAttribute('aria-pressed', String(!fromInput && +c.dataset.pct === state.curve.devBuy))
    if (!fromInput) input.value = ''
    clearTimeout(timer)
    timer = setTimeout(() => { priceDevBuy(state.asset); paintFunding() }, fromInput ? 300 : 0)
  }
  for (const c of chips) c.addEventListener('click', () => { cap.hidden = true; setPct(+c.dataset.pct) })
  input.addEventListener('input', () => {
    const asked = Number(input.value || 0)
    // Said while they are still typing: a number silently rewritten afterwards reads as
    // the field having eaten the keystroke.
    cap.hidden = asked <= DEV_BUY_MAX
    if (!input.value) return setPct(0)
    setPct(asked, { fromInput: true })
  })
  input.addEventListener('blur', () => {
    if (Number(input.value || 0) > DEV_BUY_MAX) input.value = String(DEV_BUY_MAX)
    cap.hidden = true
  })
  state.setDevBuy = (pct) => {
    const chip = chips.find((c) => +c.dataset.pct === pct)
    if (chip) setPct(pct)
    else { input.value = String(pct); setPct(pct, { fromInput: true }) }
  }
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
    hint.textContent = 'Bought in the launch itself, so nobody can buy before you.'
    paintFunding()
    return
  }

  hint.textContent = 'Pricing…'
  try {
    const { devBuyCost } = await import('./launchpad.js')
    const cost = await devBuyCost({ config: state.configs[state.curve.tier].config, percent })
    state.curve.devBuyQuote = cost.quoteIn
    state.funding.priced = null // the shortfall moved; whatever was quoted for it is stale
    hint.innerHTML = `<b>${fmt(cost.baseOut, 0)} ${esc(state.token.symbol || 'tokens')}</b> for
      <b>${fmt(cost.quoteIn, 2)} ${esc(sym())}</b> (${usd(cost.quoteIn * asset.usdPrice)}), bought in the launch itself.`
    paintFunding()
  } catch (e) {
    state.curve.devBuyQuote = 0
    state.funding.priced = null
    hint.innerHTML = `<span class="warn-text">Could not price that initial buy: ${esc(explain(e, 'dev buy quote'))}</span>`
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
  // Nobody can choose to pay in a coin they have not been told the name of, so a
  // blind launch is funded in SOL or USDC and Jupiter does the rest at launch time.
  if (state.blind && (!f.via || f.via === a.mint)) f.via = PAY_WITH[0].mint
  if (!f.via) f.via = a.mint

  // Balances and quotes come back out of order, and the person may have clicked
  // another currency in the meantime. Only the newest run is allowed to write.
  const run = ++fundingRun
  const options = state.blind ? [...PAY_WITH] : [{ mint: a.mint, symbol: a.symbol }, ...PAY_WITH]

  box.innerHTML = `<span class="lab">Paying the ${fmt(need, 4)} ${esc(sym())} initial buy</span>
    <div class="pay">${options.map((o) =>
      `<button type="button" data-mint="${esc(o.mint)}" aria-pressed="${String(o.mint === f.via)}">${esc(o.symbol)}</button>`).join('')}</div>
    <p class="detail" id="funding-detail">Checking your wallet…</p>`

  box.querySelectorAll('.pay button').forEach((b) => b.addEventListener('click', () => {
    f.via = b.dataset.mint
    paintFunding()
  }))

  const detail = (html) => { if (run === fundingRun) $('#funding-detail').innerHTML = html }

  if (!session) {
    detail(state.blind
      ? `Pay in <b>SOL</b> or <b>USDC</b> — Jupiter swaps it into whatever was drawn, at the
         moment you launch. Connect your wallet to see what you have.`
      : `Pay in <b>${esc(a.symbol)}</b>, or in <b>SOL</b> or <b>USDC</b> swapped by Jupiter. Connect your wallet to see your balance.`)
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
        ? `You hold <b>${fmt(have, 4)} ${esc(sym())}</b> — <b>${fmt(short, 4)}</b> short.
           Pay with SOL or USDC and Jupiter covers the difference.`
        : `You hold <b>${fmt(have, 4)} ${esc(sym())}</b>. Enough — nothing to swap.`)
      return
    }

    const pay = payWith(f.via)
    if (!short) {
      f.priced = null
      detail(state.blind
        ? `You already hold enough of the coin that was drawn. No ${esc(pay.symbol)} will be spent.`
        : `You already hold <b>${fmt(have, 4)} ${esc(a.symbol)}</b>, enough for this initial buy.
           No ${esc(pay.symbol)} will be spent.`)
      return
    }

    detail(`Pricing ${fmt(short, 4)} ${esc(sym())} in ${esc(pay.symbol)}…`)
    const [priced, funds] = await Promise.all([
      inputFor({ pay, coinMint: a.mint, want: short }),
      balanceOf(connection, session.address, pay.mint, { native: pay.native }),
    ])
    if (run !== fundingRun) return
    f.priced = priced

    const reserve = pay.native ? GAS_RESERVE.launch : 0
    const dp = pay.native ? 5 : 2
    const enough = funds - reserve >= priced.in
    const bought = state.blind
      // The route is a list of the venues it passes through, and on a thin ownership
      // coin that list names it as surely as the symbol would.
      ? `<b>${fmt(priced.in, dp)} ${esc(pay.symbol)}</b> covers the initial buy${impact(priced)}, swapped at launch.`
      : `<b>${fmt(priced.in, dp)} ${esc(pay.symbol)}</b> buys about
         <b>${fmt(priced.out, 4)} ${esc(a.symbol)}</b> via ${esc(priced.route || 'Jupiter')}${impact(priced)}.`
    detail(`${bought}<br>` + (enough
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

// ── 03 · review ──────────────────────────────────────────────────────────────
function paintReview() {
  const { asset: a, token: t, curve: c } = state
  if (!a) return
  const line = (k, v, cls = '') => `<div class="line ${cls}"><span>${k}</span><span>${v}</span></div>`

  // The fee is read from the config that will actually charge it, not from what the
  // code currently intends: configs are immutable and older ones charge less.
  const cfg = state.configs?.[c.tier] ?? {}
  const creatorShare = cfg.creatorSharePct ?? 50
  const open = TIERS.filter((tier) => state.configs?.[tier.id])

  let target = '<span class="skel">Loading…</span>'
  if (open.length) {
    const figure = `${c.threshold.toLocaleString('en-US')} ${esc(sym())} ≈ ${usd(c.threshold * a.usdPrice)}`
    target = open.length > 1
      ? `${figure}<br><span class="tier-pick">${open.map((tier) =>
          `<button type="button" data-tier="${tier.id}" aria-pressed="${String(tier.id === c.tier)}">${tier.label}</button>`).join('')}</span>`
      : figure
  } else if (state.configs && tiersFor === a.mint) {
    target = `<span class="warn-text">${esc(sym())} is not open for launches yet</span>`
  }

  // What trading pays the person about to sign, as parts of the half that is not the
  // DAO's: 12.5 and 37.5 of 50 read as 25% and 75%.
  const half = creatorShare || 50
  const holdersPart = Math.round(((c.holders ?? 0) / half) * 100)
  const yours = 100 - holdersPart

  $('#review').innerHTML =
    `<div class="coin">${t.image ? `<img src="${safeUrl(t.image)}" alt="">` : '<span class="noimg"></span>'}
      <div><div class="sym">${esc(t.symbol || '—')}</div><div class="nm">${esc(t.name || '—')}</div></div></div>` +
    line('Paired with', state.blind ? 'Random — named the moment you sign' : esc(a.symbol)) +
    // The treasury is the one figure that would identify the coin outright, so a
    // blind launch simply does without it rather than printing a lookup key.
    (state.blind ? '' : line(a.backing ? 'Backed by' : 'Treasury', a.backing ? `${esc(a.backing.label)} (${usd(a.backing.usd)})` : usd(a.treasury))) +
    line('Graduation target', target ?? '—') +
    line('You earn', `<b>${yours}%</b> of every trading fee`, 'earn') +
    (c.holders ? line('Holders earn', `<b>${holdersPart}%</b>, paid out hourly`, 'earn') : '')

  $('#review').querySelectorAll('.tier-pick button').forEach((b) => b.addEventListener('click', () => pickTier(b.dataset.tier)))
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
    signBtn.textContent = `Launch $${state.token.symbol ?? ''}`.trim()
    signBtn.title = `Signed by ${session.address}`
    signBtn.disabled = !state.curve.tier
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
    const { configFor, buildLaunch, sendWithMint, sendAllWithMint, connection } = await import('./launchpad.js')

    say(`Checking that ${esc(sym())} is open for launches…`)
    const config = await configFor(a.mint, state.curve.tier)
    if (!config) {
      say(`${esc(sym())} has no launch config yet. LFOwn has to open one for this coin before anyone can launch against it.`, 'warn-text')
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

    // The draw comes into the open here, before anything is put in front of a wallet.
    // It has to: the swap that funds the dev buy names the mint, and so does the
    // launch, and Phantom will print it either way. Better it is read here first,
    // while cancelling still costs nothing, than discovered in a signature request.
    if (state.blind) {
      state.blind = false
      paintPaired()
      paintReview()
      paintFunding()
      say(`Your draw is <b>${esc(a.symbol)}</b>${a.name ? ` — ${esc(a.name)}` : ''}, ${a.backing ? `backed by ${esc(a.backing.label.toLowerCase())}` : `treasury ${usd(a.treasury)}`}.
        Nothing has been signed. Continue, or go back and pick another.`)
      // A beat to actually read it, rather than a wallet popping up over the reveal.
      await new Promise((r) => setTimeout(r, 2600))
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
        say(`You hold ${fmt(have, 4)} ${esc(sym())} and the initial buy needs ${fmt(devBuy, 4)}.
          Top up with SOL or USDC, or lower the initial buy.`, 'warn-text')
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
    const { transactions, transaction, mint, baseMint } = await buildLaunch({
      config,
      owner: wallet.address,
      token: { name: state.token.name, symbol: state.token.symbol, uri: uri ?? '' },
      devBuyQuote: Math.round(devBuy * tokenUnit(a.mint)),
      seed: state.seed,
      quoteMint: state.asset?.mint,
      holderPct: state.curve.holders,
    })

    say('Waiting for your signature…')
    let signature
    if (transactions.length > 1) {
      // Sharing fees needs the vault opened before the pool, so this is two
      // transactions. One approval covers both, and each is confirmed before the
      // next is sent because the next one depends on it.
      const signedAll = await wallet.signAllOnly?.(transactions)
      if (signedAll) {
        // Told as it goes: sending the vault and waiting for it looked, from the page,
        // exactly like waiting for the wallet.
        const signatures = await sendAllWithMint(signedAll, mint, { say })
        signature = signatures[signatures.length - 1]
      } else {
        // A wallet that cannot sign both at once is asked twice. Holders are part of
        // every launch now, so turning a wallet away here would turn its owner away.
        const { confirm } = await import('./funding.js')
        for (const [i, tx] of transactions.entries()) {
          const last = i === transactions.length - 1
          say(last ? 'Now the launch itself — waiting for your signature…' : 'First the fee vault — waiting for your signature (1 of 2)…')
          const bytes = await wallet.signOnly(tx)
          if (!bytes) throw new Error(`${wallet.name} cannot sign a transaction without sending it, which a launch needs. Try Phantom, Solflare or Backpack.`)
          signature = await sendWithMint(bytes, mint)
          if (!last) {
            say('Opening the fee vault — waiting for it to confirm before the launch goes out…')
            await confirm(connection, signature, { what: 'Opening the fee vault', timeoutMs: 45_000 })
          }
        }
      }
    } else {
      // Wallet first, mint second: a transaction handed to Phantom with a signature
      // slot it cannot account for is one it will not simulate, and it warns about it.
      const signedBytes = await wallet.signOnly(transaction)
      if (signedBytes) {
        signature = await sendWithMint(signedBytes, mint)
      } else {
        // A wallet that can only sign-and-send gets the old order rather than nothing.
        transaction.partialSign(mint)
        signature = await wallet.signAndSend(transaction, connection)
      }
    }
    // Confirmed before the link is offered. The coin page reads a coin the list
    // does not know from chain and remembers a miss for five minutes, so a click a
    // second too early used to show "no pool" until then.
    say(`Sent — waiting for the network to confirm (signature ${signature.slice(0, 12)}…)`)
    const { confirm } = await import('./funding.js')
    await confirm(connection, signature, { what: 'The launch' })
    signBtn.textContent = 'Launched'
    // Kept in the console: the page is about to be replaced, and this is the one
    // string worth having if anything needs looking up on an explorer afterwards.
    console.log(`launched ${baseMint} — signature ${signature}`)

    // Told now, once there is a pool for it to find. The keeper adds the coin to the
    // cached list, which is what lets the minute-by-minute watcher follow it — a dev
    // buy big enough to take the whole raise fills the curve on the way in, and the
    // watcher would otherwise not see it until the catalogue next rebuilds. It
    // answers "not full yet" harmlessly the rest of the time.
    //
    // `keepalive` because the redirect below would otherwise cancel it mid-flight.
    fetch('/api/graduate', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mint: baseMint }),
    }).catch((e) => console.error('graduation check after launch failed:', e.message))

    // Straight to the coin, with a beat to read that it worked. The link stays in
    // case anything blocks the redirect — and because a launch is worth a sentence
    // of its own rather than a page that vanishes under the cursor.
    say(`Launched — taking you to <a href="/coins/${baseMint}" style="color:var(--red)">your coin</a>…`, 'ok-text')
    setTimeout(() => { location.href = `/coins/${baseMint}` }, 1800)
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
// Once the page has painted, so the search never competes with loading the catalogue.
;(window.requestIdleCallback ?? ((fn) => setTimeout(fn, 800)))(() => startVanity())

loadAssets().then(applyDraft).then(applyQuote)

/**
 * `/launch?quote=AVICI` — the link in a pump post. Picks that coin and moves on to the
 * token step, so someone arriving from "AVICI +30% today" starts naming their meme
 * rather than hunting for AVICI in the grid. A draft, when there is one, wins.
 */
function applyQuote() {
  const wanted = new URLSearchParams(location.search).get('quote')
  if (!wanted || state.draft) return
  const symbol = wanted.replace(/^\$/, '').toLowerCase()
  const card = [...document.querySelectorAll('.qcard:not(.wild)')]
    .find((c) => c.dataset.mint === wanted || c.dataset.symbol === symbol)
  card?.click()
}

/**
 * A launch an agent prepared for someone to sign: `/launch?draft=<id>`.
 *
 * Everything is filled in and the page stops at the review, so the person still sees
 * every choice before signing — the agent proposed it, they decide it. The draft holds
 * nothing secret; its id is only hard to guess. Its holder share is not used: every
 * launch from this page shares a quarter of the fee with holders.
 */
async function applyDraft() {
  const id = new URLSearchParams(location.search).get('draft')
  if (!id) return
  const draft = await fetch(`/api/agent/draft/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const card = draft && [...document.querySelectorAll('.qcard:not(.wild)')]
    .find((c) => c.dataset.mint === draft.quoteMint)
  if (!draft || !card) {
    const note = $('#draft-note')
    if (note) {
      note.hidden = false
      note.textContent = draft
        ? `This draft pairs the coin with ${draft.quoteSymbol}, which is not open for launches any more. Pick another coin.`
        : 'That draft has expired or does not exist. Drafts are kept for seven days.'
    }
    return
  }

  state.draft = draft
  card.click()
  if (draft.devBuyPercent > 0) state.setDevBuy(Math.min(DEV_BUY_MAX, draft.devBuyPercent))
  const values = { name: draft.name, symbol: draft.symbol, desc: draft.description, x: draft.twitter, site: draft.website }
  for (const [key, sel] of Object.entries(fields)) {
    const input = $(sel)
    input.value = values[key] ?? ''
    input.dispatchEvent(new Event('input'))
  }
  if (draft.image) {
    state.token.image = draft.image
    showImage(draft.image)
    imageStatus.textContent = 'Image from the draft.'
  }
  const note = $('#draft-note')
  if (note) {
    note.hidden = false
    note.textContent = `Filled in from a draft an AI agent prepared for ${draft.name} ($${draft.symbol}). Check each step — nothing is signed until you sign it.`
  }
  unlock(3)
  startVanity()
}
