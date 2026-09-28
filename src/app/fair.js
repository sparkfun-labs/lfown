// LFOwn — fair launches: the raise, then the DAO it becomes.
//
//   /raise            what a fair launch is, open one, every raise so far
//   /raise/<mint>     one raise: back it, claim or get refunded; once it succeeds, its DAO:
//                     the pool, the treasury, and proposals decided by their markets
//
// Everything is built by src/lib/fair-launch.mjs, the same code the keeper runs. Every
// transaction is signed by the visitor's wallet and sent by this page to the fair-launch
// cluster through /api/fair/rpc — never through the wallet, whose own network is mainnet.
// Until the programs are audited that cluster is a test one, and every screen says so.

import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { available, connect, reconnect, forget, showIcon } from './wallet.js'
import { esc } from './escape.js'
import { declined, readable } from './errors.js'
import * as F from '../lib/fair-launch.mjs'
import { waitFor } from '../lib/confirm.mjs'
import raiseIdl from '../lib/idl/lfown_raise.json' with { type: 'json' }
import futarchyIdl from '../lib/idl/futarchy.json' with { type: 'json' }

const $ = (sel, root = document) => root.querySelector(sel)
const view = $('#view')
const short = (a) => `${String(a).slice(0, 4)}…${String(a).slice(-4)}`
const coins = (units, d = 2) => (Number(units) / 1e6).toLocaleString('en-US', { maximumFractionDigits: d })
const tokensM = (units) => `${(Number(units) / 1e12).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US')
const nowS = () => Math.floor(Date.now() / 1000)
function until(ts) {
  const s = ts - nowS()
  if (s <= 0) return 'ended'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  if (s < 172_800) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86_400)} days`
}
/** A countdown the page keeps ticking, second by second (see `tick`). */
const live = (ts) => `<span data-until="${Number(ts)}">${until(ts)}</span>`
const minutes = (m) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440} days` : m >= 120 && m % 60 === 0 ? `${m / 60} h` : `${m} min`)

let config = null
/** The Wallet Standard name of the fair-launch cluster. */
const fairChain = () => `solana:${config?.cluster === 'localnet' ? 'localnet' : config?.cluster ?? 'devnet'}`
let connection = null
let session = null

// ── errors ───────────────────────────────────────────────────────────────────
// A program's refusal arrives as "custom program error: 0x17a3". Its own words are in its
// IDL; a person reads those, not the hex.
const PROGRAM_ERRORS = new Map([...raiseIdl.errors ?? [], ...futarchyIdl.errors ?? []].map((e) => [e.code, e.msg]))
function fairError(e) {
  if (declined(e)) return 'You declined in your wallet.'
  const text = `${e?.message ?? e} ${(e?.logs ?? []).join(' ')}`
  // In a simulation's words ("custom program error: 0x177c"), or a landed transaction's
  // ({"Custom":6012}).
  const hex = text.match(/custom program error: 0x([0-9a-f]+)/i)
  const dec = text.match(/"Custom":(\d+)/)
  const code = hex ? parseInt(hex[1], 16) : dec ? Number(dec[1]) : null
  if (code != null && PROGRAM_ERRORS.has(code)) return PROGRAM_ERRORS.get(code).replace(/\.?$/, '.')
  const named = text.match(/Error Message: ([^.]+)\./)
  if (named) return `${named[1]}.`
  return readable(e)
}

// ── wallet ───────────────────────────────────────────────────────────────────
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
  session = await connect(await chooseWallet(found), { chain: fairChain() })
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
  const found = available().length
  connectBtn.textContent = found ? 'Connect wallet' : 'No wallet found'
  connectBtn.disabled = !found
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
    try { await navigator.clipboard.writeText(session.address); e.target.textContent = 'Copied' } catch {}
    setTimeout(() => { e.target.textContent = 'Copy address' }, 1200)
    return
  }
  try { await session.disconnect?.() } catch {}
  forget()
  session = null
  paintConnect()
  render()
})
document.addEventListener('click', (e) => { if (!e.target.closest('.wallet-slot')) menu.hidden = true })

// ── sending ──────────────────────────────────────────────────────────────────

/**
 * Signs `groups` of instructions with the wallet, in one approval, and sends them in
 * order to the fair-launch cluster, each confirmed before the next. `extra[i]` are
 * keypairs that must sign transaction i too (a new mint), added after the wallet's
 * signature, which is the order Phantom asks for.
 */
async function sendAll(groups, { extra = [], say = () => {} } = {}) {
  const wallet = await ensureWallet()
  const payer = new PublicKey(wallet.address)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const txs = groups.map((ixs) => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs)
    tx.feePayer = payer
    tx.recentBlockhash = blockhash
    return tx
  })
  say('Waiting for your signature…')
  let signed = await wallet.signAllOnly(txs)
  if (!signed) signed = await Promise.all(txs.map((t) => wallet.signOnly(t)))
  for (const [i, bytes] of signed.entries()) {
    const tx = Transaction.from(bytes)
    for (const kp of extra[i] ?? []) tx.partialSign(kp)
    say(txs.length > 1 ? `Sending ${i + 1} of ${txs.length}…` : 'Sending…')
    const signature = await connection.sendRawTransaction(tx.serialize())
    await waitFor(connection, signature, lastValidBlockHeight)
  }
}

/**
 * Wires a button to an action, with its status line. While any action runs the page does
 * not redraw itself: a redraw would drop the status line the result is written to.
 */
let busy = 0
function wire(button, status, action, done = 'Done.') {
  if (!button) return
  button.addEventListener('click', async () => {
    const say = (m, warn = false) => { if (status) { status.textContent = m; status.className = `status${warn ? ' warn' : ''}` } }
    button.disabled = true
    busy++
    try {
      await action(say)
      say(done)
      setTimeout(render, 1500)
    } catch (e) {
      console.error(e)
      say(fairError(e), true)
    } finally {
      busy--
      button.disabled = false
    }
  })
}

// ── reading ──────────────────────────────────────────────────────────────────

/** A token's name and symbol from its Metaplex metadata: two borsh strings after 65 bytes. */
// A token's name and symbol never change: read once per visit.
const nameCache = new Map()
async function names(mints) {
  const missing = [...new Set(mints.map(String))].filter((m) => !nameCache.has(m))
  if (missing.length) {
    const read = await readNames(missing)
    missing.forEach((m, i) => nameCache.set(m, read[i]))
  }
  return mints.map((m) => nameCache.get(String(m)))
}

async function readNames(mints) {
  const pdas = mints.map((m) => PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('metadata'), F.METADATA_PROGRAM.toBytes(), new PublicKey(m).toBytes()], F.METADATA_PROGRAM)[0])
  // An RPC reads 100 accounts per call at most.
  const infos = []
  for (let i = 0; i < pdas.length; i += 100) infos.push(...await connection.getMultipleAccountsInfo(pdas.slice(i, i + 100)))
  return infos.map((info) => {
    if (!info) return { name: '', symbol: '' }
    const data = new Uint8Array(info.data)
    let o = 65
    const str = () => {
      const len = new DataView(data.buffer, data.byteOffset + o, 4).getUint32(0, true)
      o += 4
      const s = new TextDecoder().decode(data.subarray(o, o + len)).replace(/\0+$/, '')
      o += len
      return s
    }
    return { name: str(), symbol: str() }
  })
}

const quoteOf = (mint) => config.quotes.find((q) => q.mint === String(mint)) ?? { symbol: 'coin', usdPrice: 0 }
const tokenBalance = async (mint, owner) => {
  try { return BigInt((await connection.getTokenAccountBalance(F.ata(mint, owner))).value.amount) } catch { return 0n }
}

// ── pages ────────────────────────────────────────────────────────────────────

function banner() {
  const coinsOnly = config.cluster !== 'localnet'
  const faucet = config.faucet && session
    ? `<button class="btn ghost" type="button" id="faucet">${coinsOnly ? 'Get test coins' : 'Get test SOL and coins'}</button>` : ''
  const sol = coinsOnly ? ' Test SOL: <a href="https://faucet.solana.com" target="_blank" rel="noopener">faucet.solana.com</a>.' : ''
  return `<div class="net"><b>Test network · ${esc(config.cluster)}</b>
    <span>Fair launches run on a test chain until their programs are audited. Nothing here is real money.${sol}</span>${faucet}</div>`
}
function wireBanner() {
  const button = $('#faucet')
  if (!button) return
  button.addEventListener('click', async () => {
    button.disabled = true
    button.textContent = 'Sending…'
    const res = await fetch('/api/fair/faucet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: session.address }) })
    button.textContent = res.ok ? 'Sent ✓' : 'Faucet failed'
    setTimeout(render, 800)
  })
}

/**
 * The deal. With a `raise`, that raise's own figures, read from the chain; without, the
 * terms a new raise would get. The DAO's rules are the configured ones either way: a raise
 * shown with them has been checked to commit to exactly those.
 */
function termsList(quote, raise = null, t = config.terms, g = config.governance) {
  if (raise) {
    t = { ...t, tokensForInvestors: raise.tokensForInvestors, tokensForPool: raise.tokensForPool, durationSeconds: raise.endsAt - raise.startsAt,
      // Rounded, not truncated: the pool's share is 80% of the goal rounded down to a base
      // unit, which a truncated percentage showed as 79.99%.
      poolShareBps: Number((raise.quoteToPool * 10_000n + raise.goal / 2n) / raise.goal) }
  }
  const goal = raise ? raise.goal : F.goalInCoin(quote.usdPrice || 1, t.goalUsd)
  const supply = t.tokensForInvestors + t.tokensForPool
  return `<ul class="terms">
    <li><span>Goal</span><span>${raise ? '' : `${usd(t.goalUsd)} ≈ `}${coins(goal)} ${esc(quote.symbol)}</span></li>
    <li><span>Price</span><span>one price for everyone: ${coins((goal * 1_000_000n) / t.tokensForInvestors, 6)} ${esc(quote.symbol)} per token</span></li>
    <li><span>Backers</span><span>${tokensM(t.tokensForInvestors)} tokens (${Math.round(Number((t.tokensForInvestors * 1000n) / supply)) / 10}%), excess refunded</span></li>
    <li><span>Pool</span><span>${tokensM(t.tokensForPool)} tokens + ${t.poolShareBps / 100}% of the raise, owned by the DAO</span></li>
    <li><span>Treasury</span><span>${(10_000 - t.poolShareBps) / 100}% of the raise</span></li>
    <li><span>Raise lasts</span><span>${minutes(t.durationSeconds / 60)}</span></li>
    <li><span>Proposals</span><span>${minutes(g.proposalLengthMinutes)}, pass by ${g.marketBiasBps / 100}%, stake ${tokensM(BigInt(g.proposalStake))} tokens (${g.failedStakeSlashBps / 100}% kept if turned down)</span></li>
    <li><span>Winners</span><span>run ${minutes(g.executionDelaySeconds / 60)} after the decision; move at most ${g.maxTransferBps / 100}% of the treasury or mint ${g.maxMintBps / 100}% of the supply</span></li>
    <li><span>Pool fees</span><span>1%, half to the DAO, half to LFOwn</span></li>
  </ul>`
}

async function renderIndex() {
  const raises = await F.listRaises(connection)
  const meta = await names(raises.map((r) => r.baseMint))
  const quotes = config.quotes
  view.innerHTML = `${banner()}
    <h1>Fair <em>launch</em></h1>
    <p class="lede">One price for everyone. A <b>${usd(config.terms.goalUsd)} raise</b> in an ownership coin: backers get
      ${tokensM(config.terms.tokensForInvestors)} tokens at the same price, whatever is over the goal comes back, and the rest opens a
      pool the token's own DAO owns. From its first minute the DAO is <b>governed by futarchy</b>: its treasury, its mint and its
      liquidity move only when a proposal wins its market.</p>
    <div class="cols">
      <div class="card hot">
        <h2>Open a raise</h2>
        <label><span class="lab">Paired with</span><select id="f-quote">${quotes.map((q) => `<option value="${esc(q.mint)}">${esc(q.symbol)} — ${esc(q.name ?? '')}</option>`).join('')}</select></label>
        <div class="row">
          <label><span class="lab">Name</span><input id="f-name" maxlength="32" placeholder="Fair Coin"></label>
          <label><span class="lab">Ticker</span><input id="f-symbol" maxlength="10" placeholder="FAIR"></label>
        </div>
        <button class="btn" type="button" id="open">Open the raise</button>
        <p class="status" id="open-status"></p>
        <p class="hint">Opens for ${minutes(config.terms.durationSeconds / 60)}. The rules of its DAO are written into the raise before anyone backs it; the raise opens exactly that DAO when it succeeds.</p>
      </div>
      <div class="card"><h2>The deal</h2>${termsList(quotes[0] ?? { symbol: 'coin', usdPrice: 1 })}</div>
    </div>
    <div class="sec-head"><h2>Raises</h2><span class="skel">${raises.length}</span></div>
    ${raises.length ? `<div class="grid">${raises.map((r, i) => raiseCard(r, meta[i])).join('')}</div>` : '<p class="empty">No raise yet. Open the first one.</p>'}`
  wireBanner()
  wire($('#open'), $('#open-status'), async (say) => {
    const name = $('#f-name').value.trim()
    const symbol = $('#f-symbol').value.trim().toUpperCase()
    if (!name || !symbol) throw new Error('Give the token a name and a ticker.')
    const quote = quotes.find((q) => q.mint === $('#f-quote').value)
    const wallet = await ensureWallet()
    const mint = Keypair.generate()
    say('Building the raise…')
    const built = await F.buildOpenRaise(connection, {
      creator: wallet.address, mint, quoteMint: quote.mint, usdPrice: quote.usdPrice,
      name, symbol, uri: '', terms: config.terms, governance: config.governance,
    })
    await sendAll(built.transactions.map((t) => t.instructions), { extra: [[mint], [mint]], say })
    history.pushState(null, '', `/raise/${mint.publicKey.toBase58()}`)
  }, 'Raise open.')
}

function raiseCard(r, meta) {
  const q = quoteOf(r.quoteMint)
  const pct = r.goal ? Math.min(100, Number((r.totalCommitted * 1000n) / r.goal) / 10) : 0
  const state = r.state === 'live' ? (r.endsAt > nowS() ? `ends in ${live(r.endsAt)}` : 'ended, settling') : esc(r.state)
  return `<a class="raise" href="/raise/${esc(r.baseMint)}">
    <div><div class="nm">${esc(meta.symbol || short(r.baseMint))}</div><div class="pair">${esc(meta.name)} · paired with ${esc(q.symbol)}</div></div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    <div class="meta"><span>${coins(r.totalCommitted, 0)} / ${coins(r.goal, 0)} ${esc(q.symbol)}</span><span>${state}</span></div>
  </a>`
}

async function renderRaise(mint) {
  const raise = await F.readRaise(connection, mint)
  if (!raise) {
    view.innerHTML = `${banner()}${crumbs(['Raises', '/raise'], [short(mint)])}<h1>No raise here</h1><p class="lede">Nothing was raised for ${esc(short(mint))} on ${esc(config.cluster)}.</p>`
    wireBanner()
    return
  }
  const q = quoteOf(raise.quoteMint)
  const [meta] = await names([raise.baseMint])
  const dao = raise.state === 'succeeded' ? await F.readDao(connection, raise.baseMint, raise.quoteMint) : null
  const [mine, held] = session
    ? await Promise.all([F.readCommitment(connection, raise, session.address), tokenBalance(raise.quoteMint, session.address)])
    : [null, 0n]
  const pct = Number((raise.totalCommitted * 1000n) / raise.goal) / 10
  const ended = raise.endsAt <= nowS()
  const state = raise.state === 'live' ? (ended ? 'ended' : 'live') : raise.state
  const price = (raise.goal * 1_000_000n) / raise.tokensForInvestors
  const standard = await F.isStandardRaise(connection, config, raise)
  const symbol = meta.symbol || short(raise.baseMint)
  document.title = `${symbol} raise — LFOwn`

  view.innerHTML = `${banner()}
    ${crumbs(['Raises', '/raise'], [symbol])}
    <div class="head-row">
      <h1>${esc(symbol)} <span class="badge ${state === 'live' ? 'live' : ''}">${esc(state)}</span></h1>
      ${dao ? `<a class="jump hot" href="/dao/${esc(raise.baseMint)}">Go to the DAO →</a>` : ''}
    </div>
    <p class="lede">${esc(meta.name)} · a fair launch paired with ${esc(q.symbol)} · mint <span class="skel">${esc(short(raise.baseMint))}</span></p>
    <div class="totals">
      <div class="tot"><span class="lab">Committed</span><span class="big">${coins(raise.totalCommitted, 0)} ${esc(q.symbol)}</span><span class="sub">of ${coins(raise.goal, 0)} · ${pct}%</span></div>
      <div class="tot"><span class="lab">Price per token</span><span class="big">${coins(price, 6)}</span><span class="sub">${esc(q.symbol)}, the same for everyone</span></div>
      <div class="tot"><span class="lab">${state === 'live' ? 'Ends in' : 'Ended'}</span><span class="big">${state === 'live' ? live(raise.endsAt) : new Date(raise.endsAt * 1000).toLocaleString()}</span></div>
      <div class="tot"><span class="lab">To backers</span><span class="big">${tokensM(raise.tokensForInvestors)}</span><span class="sub">tokens, pro rata</span></div>
    </div>
    <div class="progress" style="margin:-18px 0 28px"><i style="width:${Math.min(100, pct)}%"></i></div>
    <div class="cols">
      <div class="card hot" id="position">${standard ? positionCard(raise, mine, q, ended, held) : `<h2>Not on LFOwn's terms</h2>
        <p>This raise was opened directly on the program, with another supply, coin or DAO than LFOwn's. Nothing here checks what it
        commits to, so this page does not take commitments for it.</p>${raise.state !== 'live' || ended ? positionCard(raise, mine, q, ended) : ''}`}</div>
      <div class="card"><h2>The deal</h2>${termsList(q, raise)}</div>
    </div>
    ${dao ? `<a class="dao-banner" href="/dao/${esc(raise.baseMint)}"><span class="lab">This raise became a DAO</span>
      <b>${esc(symbol)} DAO — its pool, its treasury, and its decisions, traded in markets</b><span class="jump hot">Go to the DAO →</span></a>` : ''}`
  wireBanner()
  wirePosition(raise, q)
}

function positionCard(raise, mine, q, ended, held = 0n) {
  if (!session) return `<h2>Back this raise</h2><p>Connect a wallet to commit ${esc(q.symbol)}, or to claim what you are owed.</p>
    <button class="btn" type="button" id="p-connect">Connect wallet</button>`
  const committed = mine?.amount ?? 0n
  if (raise.state === 'live' && !ended) {
    const projected = F.allocation({ ...raise, totalCommitted: raise.totalCommitted > raise.goal ? raise.totalCommitted : raise.goal }, committed)
    return `<h2>Back this raise</h2>
      <p>You have committed <b>${coins(committed)} ${esc(q.symbol)}</b>${!committed ? '' : raise.totalCommitted >= raise.goal
        ? ` — about ${tokensM(projected.tokens)} tokens if it closes now`
        : ` — about ${tokensM(projected.tokens)} tokens if it reaches its goal; below it, everything comes back`}.
        Anything over the goal is refunded pro rata when it closes.</p>
      <label><span class="lab">Commit (${esc(q.symbol)})</span><input id="p-amount" inputmode="decimal" placeholder="100"></label>
      <p class="hint">In your wallet: <b>${coins(held)} ${esc(q.symbol)}</b>${held ? ` · <button class="link" type="button" id="p-max" data-max="${Number(held) / 1e6}">max</button>` : ''}</p>
      <button class="btn" type="button" id="p-commit">Commit</button><p class="status" id="p-status"></p>`
  }
  if (raise.state === 'live') {
    const deadline = raise.endsAt + raise.claimDelaySeconds
    if (raise.totalCommitted >= raise.goal && nowS() < deadline) {
      return `<h2>The raise met its goal</h2><p>Opening its DAO settles it: the pool and the treasury are paid, the pool opens at the
        raise's price, and claims open, all in one transaction. LFOwn's keeper does it within a minute; anyone can, until
        ${live(deadline)} from now — past that, everyone is refunded instead.</p>
        <button class="btn" type="button" id="p-bootstrap">Open the DAO now</button><p class="status" id="p-status"></p>`
    }
    return `<h2>The raise has ended</h2><p>It ${raise.totalCommitted >= raise.goal ? 'got no DAO in time' : 'missed its goal'}: settling it
      opens refunds. LFOwn's keeper does it within a minute; anyone can.</p>
      <button class="btn" type="button" id="p-settle">Settle now</button><p class="status" id="p-status"></p>`
  }
  if (raise.state === 'failed') {
    if (!committed) return '<h2>The raise missed its goal</h2><p>Every backer takes their whole commitment back. You had none here.</p>'
    return mine.settled ? `<h2>Refunded</h2><p>Your ${coins(committed)} ${esc(q.symbol)} came back.</p>`
      : `<h2>The raise missed its goal</h2><p>Your ${coins(committed)} ${esc(q.symbol)} come back in full.</p>
        <button class="btn" type="button" id="p-refund">Take it back</button><p class="status" id="p-status"></p>`
  }
  if (!committed) return '<h2>The raise succeeded</h2><p>You did not back it. Its token trades in its DAO\'s pool.</p>'
  const a = F.allocation(raise, committed)
  if (mine.settled) return `<h2>Claimed</h2><p>You received ${tokensM(a.tokens)} tokens${a.refund ? ` and ${coins(a.refund)} ${esc(q.symbol)} back` : ''}.</p>`
  // A raise succeeds only by opening its DAO and pool, which opens claims at once.
  return `<h2>Your allocation</h2>
    <p><b>${tokensM(a.tokens)} tokens</b>${a.refund ? ` and <b>${coins(a.refund)} ${esc(q.symbol)}</b> back, the part over the goal` : ''}.</p>
    <button class="btn" type="button" id="p-claim">Claim</button>
    <p class="status" id="p-status"></p>`
}

function wirePosition(raise, q) {
  $('#p-connect')?.addEventListener('click', () => ensureWallet().catch(() => {}))
  const status = $('#p-status')
  $('#p-max')?.addEventListener('click', (e) => { $('#p-amount').value = e.target.dataset.max })
  wire($('#p-commit'), status, async (say) => {
    const amount = Math.round(Number($('#p-amount').value) * 1e6)
    if (!(amount > 0)) throw new Error(`Enter an amount of ${q.symbol}.`)
    const held = await tokenBalance(raise.quoteMint, session.address)
    if (BigInt(amount) > held) throw new Error(`You have ${coins(held)} ${q.symbol} in your wallet.`)
    await sendAll([[await F.commitIx(connection, raise, session.address, BigInt(amount))]], { say })
  }, 'Committed.')
  wire($('#p-settle'), status, async (say) => sendAll([[await F.settleIx(connection, raise, session.address)]], { say }), 'Settled.')
  wire($('#p-bootstrap'), status, async (say) => sendAll([[await F.bootstrapIx(connection, raise, session.address, { terms: config.terms, governance: config.governance })]], { say }), 'The DAO is open.')
  wire($('#p-claim'), status, async (say) => sendAll([[await F.claimIx(connection, raise, session.address)]], { say }), 'Claimed.')
  wire($('#p-refund'), status, async (say) => sendAll([[await F.refundIx(connection, raise, session.address)]], { say }), 'Refunded.')
}

// ── DAOs ─────────────────────────────────────────────────────────────────────
//
//   /dao                 every DAO a raise became
//   /dao/<mint>          one DAO: its pool, treasury, rules, proposals, and proposing
//   /dao/<mint>/<id>     one decision, laid out the way MetaDAO lays its out: the two
//                        markets' prices over time, their TWAPs, and a trade panel

/** What the page remembers across its redraws: the tab, the side, the amount typed. */
const ui = { tab: 'summary', outcome: 1, action: 'buy', amount: '' }
const LABELS = ['Fail', 'Pass']
/** A coin amount in dollars, at the coin's configured price. */
const dollars = (coinPerToken, q) => {
  const v = coinPerToken * (q.usdPrice || 0)
  if (!v) return '—'
  return '$' + (v >= 1 ? v.toFixed(2) : v.toPrecision(3))
}
const crumbs = (...parts) => `<nav class="crumbs">${parts.map(([label, href]) => (href
  ? `<a href="${href}">${esc(label)}</a>` : `<span>${esc(label)}</span>`)).join('<i>/</i>')}</nav>`

async function daoFor(mint) {
  const raise = await F.readRaise(connection, mint)
  if (!raise) return {}
  const [dao, [meta]] = await Promise.all([
    raise.state === 'succeeded' ? F.readDao(connection, raise.baseMint, raise.quoteMint) : null,
    names([raise.baseMint]),
  ])
  return { raise, dao, meta, q: quoteOf(raise.quoteMint) }
}

async function poolPrice(d) {
  const pool = await F.programs(connection).cpAmm.account.pool.fetch(d.pool)
  const sqrt = Number(BigInt(pool.sqrtPrice.toString())) / 2 ** 64
  return sqrt * sqrt // coin per token
}

async function renderDaos() {
  const raises = (await F.listRaises(connection)).filter((r) => r.state === 'succeeded')
  const found = await Promise.all(raises.map(async (r) => ({ r, d: await F.readDao(connection, r.baseMint, r.quoteMint).catch(() => null) })))
  const daos = found.filter((x) => x.d)
  const meta = await names(daos.map((x) => x.r.baseMint))
  const cards = await Promise.all(daos.map(async ({ r, d }, i) => {
    const q = quoteOf(r.quoteMint)
    const [price, treasury] = await Promise.all([poolPrice(d), tokenBalance(d.quoteMint, d.treasury)])
    return `<a class="raise" href="/dao/${esc(r.baseMint)}">
      <div><div class="nm">${esc(meta[i].symbol || short(r.baseMint))}</div><div class="pair">${esc(meta[i].name)} · governed by futarchy</div></div>
      <div class="meta"><span>Price ${dollars(price, q)}</span><span>Treasury ${coins(treasury, 0)} ${esc(q.symbol)}</span></div>
      <div class="meta"><span>${d.proposalCount} proposal${d.proposalCount === 1 ? '' : 's'}</span><span>${d.activeProposal ? '<b class="dot"></b>one trading' : 'none trading'}</span></div>
    </a>`
  }))
  view.innerHTML = `${banner()}
    <h1>The <em>DAOs</em></h1>
    <p class="lede">Every raise that met its goal became a DAO: it owns its token's pool, its treasury and its mint, and moves them only
      when a proposal wins its market.</p>
    ${cards.length ? `<div class="grid">${cards.join('')}</div>` : '<p class="empty">No DAO yet: a raise becomes one when it meets its goal.</p>'}`
  wireBanner()
}

async function renderDaoPage(mint) {
  const { raise, dao: d, meta, q } = await daoFor(mint)
  if (!d) {
    view.innerHTML = `${banner()}${crumbs(['DAOs', '/dao'], [short(mint)])}<h1>No DAO here</h1>
      <p class="lede">${raise ? `This raise has not become a DAO${raise.state === 'failed' ? ': it missed its goal' : ' yet'}.` : `Nothing was raised for ${esc(short(mint))}.`}</p>
      ${raise ? `<a class="jump" href="/raise/${esc(mint)}">← The raise</a>` : ''}`
    wireBanner()
    return
  }
  const [price, treasury, mineTokens, proposals] = await Promise.all([
    poolPrice(d),
    tokenBalance(d.quoteMint, d.treasury),
    session ? tokenBalance(d.baseMint, session.address) : 0n,
    F.readProposals(connection, d, d.proposalCount),
  ])
  const g = d.governance
  const stake = BigInt(g.proposalStake.toString())
  const busyDao = Boolean(d.activeProposal) || d.pendingReturn
  const symbol = meta.symbol || short(mint)
  document.title = `${symbol} DAO — LFOwn`
  view.innerHTML = `${banner()}
    ${crumbs(['DAOs', '/dao'], [symbol])}
    <div class="head-row">
      <h1>${esc(symbol)} <span class="badge">DAO</span></h1>
      <a class="jump" href="/raise/${esc(mint)}">← The raise</a>
    </div>
    <p class="lede">${esc(meta.name)} · governed by futarchy · treasury, mint and pool move only when a proposal wins its market</p>
    <div class="totals">
      <div class="tot"><span class="lab">Pool price</span><span class="big">${dollars(price, q)}</span><span class="sub">${price.toPrecision(3)} ${esc(q.symbol)} per ${esc(symbol)}</span></div>
      <div class="tot"><span class="lab">Treasury</span><span class="big">${coins(treasury, 0)} ${esc(q.symbol)}</span><span class="sub">${dollars(Number(treasury) / 1e6, q)}</span></div>
      <div class="tot"><span class="lab">Proposals</span><span class="big">${d.proposalCount}</span><span class="sub">${d.activeProposal ? 'one is trading now' : 'none trading'}</span></div>
      ${session ? `<div class="tot"><span class="lab">You hold</span><span class="big">${tokensM(mineTokens)}</span><span class="sub">${esc(symbol)}</span></div>` : ''}
    </div>
    <div class="cols">
      <div>
        <div class="sec-head"><h2>Decisions</h2></div>
        ${proposals.length ? proposals.map((x) => decisionRow(x, mint, q, symbol)).join('') : '<p class="empty">No proposal yet. Ask the market the first question.</p>'}
      </div>
      <div class="side">
        <div class="card hot">
          <h2>Propose</h2>
          <p>Anyone holding ${tokensM(stake)} ${esc(symbol)} can ask the market. The stake comes back once it decides, less
            ${g.failedStakeSlashBps / 100}% if it is turned down.</p>
          <label><span class="lab">Question (${QUESTION_BYTES} characters)</span><input id="n-title" maxlength="${QUESTION_BYTES}" placeholder="Pay the designer 50 ${esc(q.symbol)}"></label>
          <div class="row">
            <label><span class="lab">If it passes</span><select id="n-kind"><option value="transfer">Pay from the treasury</option><option value="mint">Mint new ${esc(symbol)}</option></select></label>
            <label><span class="lab">Amount</span><input id="n-amount" inputmode="decimal" placeholder="50"></label>
          </div>
          <label><span class="lab">To</span><input id="n-to" placeholder="${session ? esc(session.address) : 'a wallet address'}"></label>
          <button class="btn" type="button" id="n-go" ${session && (mineTokens < stake || busyDao) ? 'disabled' : ''}>Propose</button>
          <p class="status" id="n-status">${!session ? '' : busyDao ? 'One proposal at a time: this one opens once the last one\'s liquidity is back in the pool.'
            : mineTokens < stake ? `You need ${tokensM(stake)} ${esc(symbol)} to propose.` : ''}</p>
        </div>
        <div class="card"><h2>The rules</h2><ul class="terms">
          <li><span>Markets run</span><span>${minutes(g.proposalLengthMinutes)}${g.warmupSeconds ? `, the first ${minutes(g.warmupSeconds / 60)} not counted` : ''}</span></li>
          <li><span>To pass</span><span>Pass TWAP beats Fail by ${g.marketBiasBps / 100}%</span></li>
          <li><span>Winners run</span><span>${minutes(g.executionDelaySeconds / 60)} after, within ${minutes(g.executionWindowSeconds / 60)}</span></li>
          <li><span>At most</span><span>${g.maxTransferBps / 100}% of the treasury, ${g.maxMintBps / 100}% of supply</span></li>
          <li><span>Pool fees</span><span>half to the DAO, half to LFOwn</span></li>
        </ul></div>
      </div>
    </div>`
  wireBanner()
  wirePropose(d, q)
}

function decisionRow(x, mint, q, symbol) {
  const ends = x.markets[1]?.endsAt || x.createdAt + x.lengthMinutes * 60
  const twaps = x.markets.map((m) => (m ? F.observationPrice(m.twap) : 0))
  const lead = x.state === 'resolved' ? x.winner : twaps[1] > twaps[0] * (1 + x.marketBiasBps / 10_000) ? 1 : 0
  const state = x.state === 'resolved' ? `<span class="badge ${x.winner ? 'won' : ''}">${x.winner ? 'Passed' : 'Failed'}</span>`
    : x.state === 'pending' ? `<span class="pill"><b class="dot"></b>${live(ends)}</span>`
    : `<span class="badge">${x.prepared ? 'Opening' : 'Being written'}</span>`
  return `<a class="decision-row" href="/dao/${esc(mint)}/${x.id}">
    <div class="meta"><span class="tag">${esc(symbol)}-${String(x.id).padStart(3, '0')}</span>${state}</div>
    <div class="title">${esc(x.metadata || `Proposal ${x.id}`)}</div>
    ${x.state === 'setup' ? '' : `<div class="meta"><span class="${lead === 1 ? 'pass' : ''}">Pass ${dollars(twaps[1], q)}</span><span class="${lead === 0 ? 'fail' : ''}">Fail ${dollars(twaps[0], q)}</span></div>`}
  </a>`
}

function describe(action, q, meta) {
  if (action.transfer) {
    const symbol = action.transfer.mint.toBase58() === q.mint ? q.symbol : meta.symbol
    return `pay ${coins(action.transfer.amount)} ${esc(symbol)} from the treasury to <span class="addr">${esc(action.transfer.recipient.toBase58())}</span>`
  }
  // The whole address: two that share their ends are two different people.
  return `mint ${tokensM(action.mintTo.amount)} ${esc(meta.symbol)} to <span class="addr">${esc(action.mintTo.recipient.toBase58())}</span>`
}

// A decision's chart and trades come from its markets' transactions: fetched at most
// every half minute, not at every redraw.
const histories = new Map()
async function historyOf(d, id) {
  const key = `${d.dao.toBase58()}:${id}`
  const hit = histories.get(key)
  if (hit && Date.now() - hit.at < 30_000) return hit.data
  const data = await F.marketHistory(connection, d, id, { limit: 80 }).catch(() => ({ points: [[], []], trades: [] }))
  histories.set(key, { at: Date.now(), data })
  return data
}

/** The two markets' spot prices over time, as an SVG: Pass and Fail, like MetaDAO's. */
function chart(points, q, start, end, opening = [], spots = []) {
  // Each market from its opening price, when it was funded, to its price now: a trade
  // shows at once, not at the next crank.
  const live = nowS() < (end || Infinity)
  const series = points.map((s, i) => [
    ...(start && opening[i] ? [{ t: start, v: (Number(opening[i]) / 1e12) * (q.usdPrice || 1) }] : []),
    ...s.map((p) => ({ t: p.t, v: (Number(p.price) / 1e12) * (q.usdPrice || 1) })),
    ...(live && spots[i] ? [{ t: nowS(), v: spots[i] * (q.usdPrice || 1) }] : []),
  ])
  const all = series.flat()
  if (all.length < 2) return '<div class="chart empty-chart">The chart fills in as the markets are cranked, once a minute.</div>'
  const W = 640, H = 240, L = 8, R = 74, T = 12, B = 26
  const t0 = start || Math.min(...all.map((p) => p.t))
  // From the market's opening to now, or to its end.
  const t1 = Math.max(end && end < nowS() ? end : nowS(), t0 + 10)
  // At least 1% either side of the price: prices that differ by a rounding of the last
  // base unit are flat, not a cliff.
  let lo = Math.min(...all.map((p) => p.v)), hi = Math.max(...all.map((p) => p.v))
  const mid = (lo + hi) / 2
  lo = Math.min(lo, mid * 0.99); hi = Math.max(hi, mid * 1.01)
  const pad = (hi - lo) * 0.15
  lo -= pad; hi += pad
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R)
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B)
  // Steps, not slopes: a market's price holds until its next update.
  const path = (s) => s.map((p, i) => (i ? `H${x(p.t).toFixed(1)}V${y(p.v).toFixed(1)}` : `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)).join('')
    + (s.length ? `H${x(Math.min(t1, nowS())).toFixed(1)}` : '')
  // Enough digits for the axis's four labels to differ.
  const digits = Math.min(8, Math.max(3, Math.ceil(Math.log10(Math.abs(mid) / ((hi - lo) / 4 || 1))) + 1))
  const fmt = (v) => '$' + (v >= 1 ? v.toFixed(2) : v.toPrecision(digits))
  const ticks = [0, 1, 2, 3].map((i) => lo + ((hi - lo) * (i + 0.5)) / 4)
  const times = [0, 1, 2].map((i) => t0 + ((t1 - t0) * (i + 0.5)) / 3)
  const last = series.map((s) => s[s.length - 1]).map((p) => p && { ...p, t: Math.min(t1, nowS()), y: y(p.v) })
  return `<div class="chart"><div class="legend"><span class="pass">Pass</span><span class="fail">Fail</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Pass and Fail prices over time">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid-line"/><text x="${W - R + 6}" y="${y(v) + 3}" class="axis">${fmt(v)}</text>`).join('')}
      ${times.map((t) => `<text x="${x(t)}" y="${H - 8}" class="axis" text-anchor="middle">${new Date(t * 1000).toLocaleTimeString([], t1 - t0 < 900 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' })}</text>`).join('')}
      <path d="${path(series[0])}" class="line fail under"/><path d="${path(series[1])}" class="line pass"/>
      ${last.map((p, i) => (p ? `<circle cx="${x(p.t)}" cy="${p.y}" r="3.5" class="${i ? 'pass' : 'fail'}-dot"/>` : '')).join('')}
    </svg></div>`
}

async function renderDecision(mint, id) {
  const { dao: d, meta, q } = await daoFor(mint)
  const [x] = d ? await F.readProposals(connection, d, d.proposalCount, { ids: [id] }) : []
  const symbol = meta?.symbol || short(mint)
  if (!x) {
    view.innerHTML = `${banner()}${crumbs(['DAOs', '/dao'], [symbol, `/dao/${mint}`], [`#${id}`])}<h1>No such decision</h1>`
    wireBanner()
    return
  }
  const [history, position, wallet] = await Promise.all([
    x.state === 'setup' ? { points: [[], []], trades: [] } : historyOf(d, id),
    session && x.state !== 'setup' ? F.readPosition(connection, d, id, session.address) : null,
    // What the visitor can spend: the coin to buy with, the token to sell.
    session ? Promise.all([tokenBalance(d.quoteMint, session.address), tokenBalance(d.baseMint, session.address)]).then(([coin, token]) => ({ coin, token })) : null,
  ])
  const m = x.markets
  const ends = m[1]?.endsAt || x.createdAt + x.lengthMinutes * 60
  const counting = (m[1]?.startedAt || x.createdAt) + x.warmupSeconds
  const twaps = m.map((k) => (k ? F.observationPrice(k.twap) : 0))
  const bar = 1 + x.marketBiasBps / 10_000
  const lead = x.state === 'resolved' ? x.winner : twaps[1] > twaps[0] * bar ? 1 : 0
  const tag = `${symbol}-${String(id).padStart(3, '0')}`
  document.title = `${x.metadata || tag} — LFOwn`
  const status = x.state === 'resolved' ? `<span class="badge ${x.winner ? 'won' : ''}">${x.winner ? 'Passed' : 'Failed'}</span>`
    : x.state === 'pending' ? `<span class="pill"><b class="dot"></b>${live(ends)}</span>`
    : `<span class="badge">${x.prepared ? 'Its markets open within a minute' : 'Being written'}</span>`
  const actions = x.actions[1] ?? []
  const executed = x.executed?.[1] ?? 0
  const g = d.governance
  const opensAt = x.resolvedAt + Number(g.executionDelaySeconds)
  const tabs = { summary: 'Summary', actions: 'Actions', trades: 'Trades', position: 'Position' }

  const tabBody = {
    summary: `<h3>Summary</h3>
      <p>${esc(x.metadata || `Proposal ${id}`)}</p>
      <p>If it passes, the DAO will ${actions.length ? actions.map((a) => describe(a, q, meta)).join(', then ') : 'do nothing'}.
        It passes if the Pass market's TWAP beats the Fail market's by ${x.marketBiasBps / 100}% when the markets close.</p>
      <p class="hint">Proposed by <span class="addr">${esc(x.creator)}</span>${x.stake ? `, who staked ${tokensM(x.stake)} ${esc(symbol)} to ask` : ''}.</p>`,
    actions: `<h3>What passing does</h3>
      ${actions.length ? `<ol class="steps">${actions.map((a, i) => `<li>${describe(a, q, meta)}${executed & (1 << i) ? ' <span class="badge won">done</span>' : ''}</li>`).join('')}</ol>` : '<p>Nothing.</p>'}
      <p class="hint">Run by anyone, on-chain, ${minutes(Number(g.executionDelaySeconds) / 60)} after the decision and within ${minutes(Number(g.executionWindowSeconds) / 60)} of it —
        ${x.state === 'resolved' && x.winner ? (nowS() < opensAt ? `from ${new Date(opensAt * 1000).toLocaleString()}` : 'now') : 'if it passes'}.</p>`,
    trades: history.trades.length ? `<table class="trades"><thead><tr><th>When</th><th>Side</th><th>Trade</th><th>By</th></tr></thead><tbody>
      ${history.trades.slice(0, 40).map((t) => `<tr><td>${new Date(t.t * 1000).toLocaleTimeString()}</td>
        <td class="${t.option ? 'pass' : 'fail'}">${LABELS[t.option]}</td>
        <td>${t.buy ? `bought ${tokensM(t.output)} for ${coins(t.input)}` : `sold ${tokensM(t.input)} for ${coins(t.output)}`}</td>
        <td class="addr">${esc(short(t.trader))}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No trade yet.</p>',
    position: !session ? '<p class="hint">Connect a wallet to see your position.</p>' : !position ? '<p class="hint">Nothing yet.</p>'
      : `<table class="trades"><thead><tr><th>Side</th><th>${esc(q.symbol)} (conditional)</th><th>${esc(symbol)} (conditional)</th></tr></thead><tbody>
        ${[1, 0].map((i) => `<tr><td class="${i ? 'pass' : 'fail'}">${LABELS[i]}</td><td>${coins(position[i].coin)}</td><td>${tokensM(position[i].token)}</td></tr>`).join('')}
        </tbody></table>
        ${x.state === 'resolved' ? `<button class="btn" type="button" id="t-redeem">Redeem the ${LABELS[x.winner]} side</button><p class="status" id="t-redeem-status"></p>` : ''}`,
  }

  view.innerHTML = `${banner()}
    ${crumbs(['DAOs', '/dao'], [symbol, `/dao/${mint}`], [tag])}
    <div class="decision">
      <div class="main">
        <div class="meta head-meta"><span class="tag">${esc(tag)}</span>${status}</div>
        <h1 class="decision-title">${esc(x.metadata || `Proposal ${id}`)}</h1>
        ${x.state === 'setup' ? setupNote(x)
          : chart(history.points, q, m[1]?.startedAt, ends, m.map((k) => k?.starting), m.map((k) => k?.spot))}
        <div class="twap">
          <div class="twap-head"><h2>TWAP</h2>
            <div><span class="pass ${lead === 1 ? 'lead' : ''}">Pass ${dollars(twaps[1], q)}</span><span class="fail ${lead === 0 ? 'lead' : ''}">Fail ${dollars(twaps[0], q)}</span></div></div>
          <div class="twap-bar"><i class="pass" style="width:${twaps[0] + twaps[1] ? (100 * twaps[1]) / (twaps[0] + twaps[1]) : 50}%"></i></div>
          <p class="hint">${x.state === 'pending' && nowS() < counting ? `Counting starts in ${live(counting)}: the first ${minutes(x.warmupSeconds / 60)} of trading is a warmup, not counted.`
            : x.state === 'resolved' ? `Decided: the ${LABELS[x.winner]} market's TWAP won.`
            : `Pass needs ${dollars(twaps[0] * bar, q)} to win: Fail's TWAP plus ${x.marketBiasBps / 100}%.`}</p>
        </div>
        <nav class="tabs">${Object.entries(tabs).map(([k, v]) => `<button type="button" data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${v}</button>`).join('')}</nav>
        <div class="tab-body">${tabBody[ui.tab]}</div>
      </div>
      <aside class="panel">${tradePanel(x, q, symbol, position, wallet)}</aside>
    </div>`
  wireBanner()
  // Tabs and the trade panel's choices change in place, at once: what they show is
  // already read. Redrawing the page for them re-read the chain, and a click during the
  // page's own refresh was lost.
  const wireRedeem = () => wire($('#t-redeem'), $('#t-redeem-status'), async (say) => sendAll([await F.redeemWinningsIxs(connection, d, id, session.address)], { say }), 'Redeemed.')
  const paintTab = () => {
    for (const b of view.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === ui.tab)
    $('.tab-body').innerHTML = tabBody[ui.tab]
    wireRedeem()
  }
  for (const b of view.querySelectorAll('[data-tab]')) b.addEventListener('click', () => { ui.tab = b.dataset.tab; paintTab() })
  const paintPanel = () => {
    $('.panel').innerHTML = tradePanel(x, q, symbol, position, wallet)
    wireTrade(d, x, q, symbol, position, wallet, paintPanel)
  }
  wireTrade(d, x, q, symbol, position, wallet, paintPanel)
  wire($('#t-launch'), $('#t-launch-status'), async (say) => {
    const { accountIxs, launch } = await F.launchIxs(connection, d, id, (await ensureWallet()).address)
    await sendAll([accountIxs, [launch]], { say })
  }, 'Launched: the markets are open.')
  wire($('#t-prepare'), $('#t-prepare-status'), async (say) => sendAll([[await F.prepareIx(connection, d, id, session.address)]], { say }), 'The liquidity is out.')
  wireRedeem()
}

/**
 * Before its markets open. Prepared: the liquidity is out, and anyone may launch the
 * markets — the keeper does within a minute, or the visitor now. Not prepared: its creator
 * has yet to take the liquidity out, which fixes its options.
 */
function setupNote(x) {
  if (x.prepared) {
    return `<div class="empty"><p><b>The liquidity is out of the pool.</b> Its markets open as soon as someone launches them: LFOwn's
      keeper does within a minute, and anyone can, now.</p>
      <p><button class="btn" type="button" id="t-launch">Launch the markets now</button></p><p class="status" id="t-launch-status"></p></div>`
  }
  const mine = session && session.address === x.creator
  return `<div class="empty"><p>Its creator has yet to take the liquidity out of the pool, which fixes its options; its markets open after that.</p>
    ${mine ? '<p><button class="btn" type="button" id="t-prepare">Take the liquidity out</button></p><p class="status" id="t-prepare-status"></p>' : ''}</div>`
}

/**
 * What a trade on side `i` can spend: on MetaDAO's terms, the coin to buy with and the
 * DAO's token to sell, plus what the visitor already holds of that side's conditional
 * coin or token, which is used first.
 */
const spendable = (action, i, position, wallet) => (action === 'buy'
  ? { real: wallet?.coin ?? 0n, held: position?.[i]?.coin ?? 0n }
  : { real: wallet?.token ?? 0n, held: position?.[i]?.token ?? 0n })

function tradePanel(x, q, symbol, position, wallet) {
  if (x.state === 'resolved') {
    return `<div class="panel-box"><span class="lab">Decided</span><div class="result ${x.winner ? 'pass' : 'fail'}">${LABELS[x.winner]}</div>
      <p class="hint">The ${LABELS[x.winner]} side redeems one for one into ${esc(q.symbol)} and ${esc(symbol)}; the other side is worth nothing now.
      Your position and the redeem button are under Position.</p></div>`
  }
  if (x.state !== 'pending') return `<div class="panel-box"><p class="hint">Trading opens with its markets.</p></div>`
  const m = x.markets
  const side = LABELS[ui.outcome]
  const other = LABELS[1 - ui.outcome]
  const buying = ui.action === 'buy'
  const unit = buying ? q.symbol : symbol
  const { real, held } = spendable(ui.action, ui.outcome, position, wallet)
  const amount = (units) => (buying ? coins(units) : tokensM(units))
  return `<div class="panel-box">
    <span class="lab">Outcome market</span>
    <div class="seg">${[1, 0].map((i) => `<button type="button" data-outcome="${i}" class="${ui.outcome === i ? 'on' : ''}"><b class="${i ? 'pass' : 'fail'}-sq"></b>${LABELS[i]} ${dollars(m[i]?.spot ?? 0, q)}</button>`).join('')}</div>
    <span class="lab">Action</span>
    <div class="seg">${['buy', 'sell'].map((a) => `<button type="button" data-action="${a}" class="${ui.action === a ? 'on' : ''}">${a === 'buy' ? 'Buy' : 'Sell'}</button>`).join('')}</div>
    <span class="lab">You spend</span>
    <label class="spend"><input id="t-amount" inputmode="decimal" placeholder="0" value="${esc(ui.amount)}"><span>${esc(unit)}</span></label>
    ${session ? `<p class="hint">You have ${amount(real)} ${esc(unit)}${held ? ` and ${amount(held)} ${side} ${esc(unit)} already split` : ''}${real + held ? ' · <button class="link" type="button" id="t-max">max</button>' : ''}</p>` : ''}
    <div class="recv"><span>You receive, estimated</span><b id="t-recv">—</b></div>
    <p class="hint">A trade is exposure to an outcome, not a vote. ${buying
      ? `Your ${esc(q.symbol)} is split into a Pass and a Fail ${esc(q.symbol)}, and the ${side} one buys ${side} ${esc(symbol)}: if ${side} wins you keep the ${esc(symbol)}; if ${other} wins, your ${other} ${esc(q.symbol)} redeems for ${esc(q.symbol)}.`
      : `Your ${esc(symbol)} is split into a Pass and a Fail ${esc(symbol)}, and the ${side} one is sold for ${side} ${esc(q.symbol)}: if ${side} wins you have ${esc(q.symbol)} instead of ${esc(symbol)}; if ${other} wins, your ${other} ${esc(symbol)} redeems for ${esc(symbol)}.`}</p>
    <button class="btn wide" type="button" id="t-go">${session ? `${buying ? 'Buy' : 'Sell'} ${side}` : 'Connect wallet'}</button>
    <p class="status" id="t-status"></p>
  </div>`
}

function wireTrade(d, x, q, symbol, position, wallet, repaint) {
  for (const b of view.querySelectorAll('[data-outcome]')) b.addEventListener('click', () => { ui.outcome = Number(b.dataset.outcome); repaint() })
  for (const b of view.querySelectorAll('[data-action]')) b.addEventListener('click', () => { ui.action = b.dataset.action; ui.amount = ''; repaint() })
  const input = $('#t-amount')
  if (!input) return
  const estimate = () => {
    ui.amount = input.value
    const m = x.markets[ui.outcome]
    const units = BigInt(Math.max(0, Math.round(Number(input.value) * 1e6)) || 0)
    if (!m || !units) { $('#t-recv').textContent = '—'; return }
    $('#t-recv').textContent = ui.action === 'buy'
      ? `${tokensM(F.swapOutput(units, m.reserveCoin, m.reserveToken, m.fee))} ${LABELS[ui.outcome]} ${symbol}`
      : `${coins(F.sellOutput(units, m.reserveToken, m.reserveCoin, m.fee))} ${LABELS[ui.outcome]} ${q.symbol}`
  }
  input.addEventListener('input', estimate)
  estimate()
  $('#t-max')?.addEventListener('click', () => {
    const { real, held } = spendable(ui.action, ui.outcome, position, wallet)
    input.value = String(Number(real + held) / 1e6)
    estimate()
  })
  wire($('#t-go'), $('#t-status'), async (say) => {
    await ensureWallet()
    const units = BigInt(Math.round(Number(input.value) * 1e6))
    const unit = ui.action === 'buy' ? q.symbol : symbol
    if (!(units > 0n)) throw new Error(`Enter an amount of ${unit}.`)
    const { real, held } = spendable(ui.action, ui.outcome, position, wallet)
    if (wallet && units > real + held) throw new Error(`You have ${Number(real + held) / 1e6} ${unit} to spend.`)
    const ixs = ui.action === 'buy'
      ? await F.backOptionIxs(connection, d, x.id, session.address, ui.outcome, units)
      : await F.sellOptionIxs(connection, d, x.id, session.address, ui.outcome, units)
    await sendAll([ixs], { say })
    ui.amount = ''
    histories.clear()
  }, ui.action === 'buy' ? 'Bought.' : 'Sold.')
}

/**
 * A question's length, in bytes. It rides in the proposal's transaction, which with 48
 * bytes of question is 1,229 of Solana's 1,232; 64 did not fit.
 */
const QUESTION_BYTES = 48

function wirePropose(d, q) {
  wire($('#n-go'), $('#n-status'), async (say) => {
    const wallet = await ensureWallet()
    const title = $('#n-title').value.trim()
    if (!title) throw new Error('Write the question.')
    // Bytes, not characters: the question rides in a transaction already near its limit.
    if (new TextEncoder().encode(title).length > QUESTION_BYTES) throw new Error(`The question is too long: ${QUESTION_BYTES} characters at most.`)
    const amount = Number($('#n-amount').value)
    if (!(amount > 0)) throw new Error('Enter an amount.')
    let to
    try { to = new PublicKey($('#n-to').value.trim() || wallet.address) } catch { throw new Error('That is not a wallet address.') }
    const units = BigInt(Math.round(amount * 1e6))
    // The program refuses a winner over the DAO's limits; better to say so before the vote.
    const g = d.governance
    if ($('#n-kind').value === 'mint') {
      const supply = BigInt((await connection.getTokenSupply(d.baseMint)).value.amount)
      if (units * 10_000n > supply * BigInt(g.maxMintBps)) throw new Error(`A proposal mints at most ${g.maxMintBps / 100}% of the supply.`)
    } else if (units * 10_000n > (await tokenBalance(d.quoteMint, d.treasury)) * BigInt(g.maxTransferBps)) {
      throw new Error(`A proposal pays at most ${g.maxTransferBps / 100}% of the treasury.`)
    }
    const action = $('#n-kind').value === 'mint'
      ? { mintTo: { amount: units, recipient: to } }
      : { transfer: { mint: d.quoteMint, amount: units, recipient: to } }
    const id = d.proposalCount
    // One approval, four transactions, each near Solana's size limit: the proposal and its
    // markets; its option and the liquidity it takes out of the pool; the markets' token
    // accounts; the markets opened with that liquidity. The keeper would launch them
    // within a minute; the proposer does it now. Should the last ones fail, anyone can.
    const { accountIxs, launch } = await F.launchIxs(connection, d, id, wallet.address)
    await sendAll([
      await F.proposeIxs(connection, d, id, wallet.address, title),
      [await F.setActionsIx(connection, d, id, wallet.address, 1, [action]), await F.prepareIx(connection, d, id, wallet.address)],
      accountIxs,
      [launch],
    ], { say })
    history.pushState(null, '', `/dao/${d.baseMint.toBase58()}/${id}`)
  }, 'Proposed: its markets are open.')
}

// ── routing ──────────────────────────────────────────────────────────────────

let rendering = false
let again = false
async function render() {
  if (!config) return
  // One draw at a time; a navigation that arrives during one is drawn right after it.
  if (rendering) { again = true; return }
  rendering = true
  try {
    const [section, mint, id] = location.pathname.split('/').filter(Boolean)
    markTab(section)
    const isMint = (v) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v ?? '')
    if (section === 'dao' && isMint(mint) && /^\d+$/.test(id ?? '')) await renderDecision(mint, Number(id))
    else if (section === 'dao' && isMint(mint)) await renderDaoPage(mint)
    else if (section === 'dao') await renderDaos()
    else if (isMint(mint)) await renderRaise(mint)
    else await renderIndex()
  } catch (e) {
    console.error(e)
    view.innerHTML = `<p class="empty">Could not read the chain: ${esc(fairError(e))}</p>`
  } finally {
    rendering = false
    if (again) { again = false; render() }
  }
}

/** The header's Raise and DAO tabs: shown here, and the current one marked. */
function markTab(section) {
  for (const a of document.querySelectorAll('[data-fair]')) {
    a.hidden = false
    if (a.getAttribute('href') === `/${section === 'dao' ? 'dao' : 'raise'}`) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
}

// Links within the app, in the page or the header's tabs, move without a page load.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/raise"], a[href^="/dao"]')
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return
  e.preventDefault()
  if (a.getAttribute('href') !== location.pathname) ui.tab = 'summary'
  history.pushState(null, '', a.getAttribute('href')) // renders, see below
  window.scrollTo(0, 0)
})
window.addEventListener('popstate', render)
// Pushed by the "Open the raise" handler after it lands.
const push = history.pushState.bind(history)
history.pushState = (...args) => { push(...args); setTimeout(render, 0) }

// Every second: countdowns tick, and one that reaches zero redraws the page, since what
// the page offers changes then (a raise to settle, a market to finalize).
function tick() {
  let ended = false
  for (const el of view.querySelectorAll('[data-until]')) {
    const ts = Number(el.dataset.until)
    el.textContent = until(ts)
    if (ts <= nowS() && !el.dataset.ended) { el.dataset.ended = '1'; ended = true }
  }
  if (ended && !busy && !document.activeElement?.matches('input, select')) setTimeout(render, 1500)
}
setInterval(tick, 1000)

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  const res = await fetch('/api/fair/config').catch(() => null)
  if (!res?.ok) {
    view.innerHTML = '<h1>Fair <em>launch</em></h1><p class="lede">Fair launches are not open yet: their programs go through an audit before they touch real money.</p>'
    return
  }
  config = await res.json()
  for (const k of ['tokensForInvestors', 'tokensForPool']) config.terms[k] = BigInt(config.terms[k])
  config.governance.proposalStake = BigInt(config.governance.proposalStake)
  connection = new Connection(`${location.origin}${config.rpcPath}`, 'confirmed')
  // A throwaway wallet, on this machine only, for a test cluster: Phantom cannot sign for a
  // local chain, and on devnet it lets the flow be checked without one.
  if (['localnet', 'devnet'].includes(config.cluster)) (await import('./dev-wallet.js')).installDevWallet()
  paintConnect()
  await render()
  for (let wait = 0; wait < 8 && !available().length; wait++) await new Promise((r) => setTimeout(r, 250))
  const resumed = await reconnect({ chain: fairChain() }).catch(() => null)
  if (resumed) { session = resumed; paintConnect(); render() }
  // A raise and its markets move by the minute; so does this page.
  setInterval(() => { if (!busy && !document.hidden && !document.activeElement?.matches('input, select')) render() }, 20_000)
}
boot()
