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
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 172_800) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86_400)} days`
}
const minutes = (m) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440} days` : m >= 120 && m % 60 === 0 ? `${m / 60} h` : `${m} min`)

let config = null
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
async function names(mints) {
  const pdas = mints.map((m) => PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('metadata'), F.METADATA_PROGRAM.toBytes(), new PublicKey(m).toBytes()], F.METADATA_PROGRAM)[0])
  const infos = await connection.getMultipleAccountsInfo(pdas)
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
  const faucet = config.cluster === 'localnet' && session
    ? '<button class="btn ghost" type="button" id="faucet">Get test SOL and coins</button>' : ''
  return `<div class="net"><b>Test network · ${esc(config.cluster)}</b>
    <span>Fair launches run on a test chain until their programs are audited. Nothing here is real money.</span>${faucet}</div>`
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

function termsList(quote, t = config.terms, g = config.governance) {
  const goal = F.goalInCoin(quote.usdPrice || 1, t.goalUsd)
  const supply = t.tokensForInvestors + t.tokensForPool
  return `<ul class="terms">
    <li><span>Goal</span><span>${usd(t.goalUsd)} ≈ ${coins(goal)} ${esc(quote.symbol)}</span></li>
    <li><span>Price</span><span>one price for everyone: ${coins((goal * 1_000_000n) / t.tokensForInvestors, 6)} ${esc(quote.symbol)} per token</span></li>
    <li><span>Backers</span><span>${tokensM(t.tokensForInvestors)} tokens (${Math.round(Number((t.tokensForInvestors * 1000n) / supply)) / 10}%), excess refunded</span></li>
    <li><span>Pool</span><span>${tokensM(t.tokensForPool)} tokens + ${t.poolShareBps / 100}% of the raise, owned by the DAO</span></li>
    <li><span>Treasury</span><span>${(10_000 - t.poolShareBps) / 100}% of the raise</span></li>
    <li><span>Raise lasts</span><span>${minutes(t.durationSeconds / 60)}</span></li>
    <li><span>Proposals</span><span>${minutes(g.proposalLengthMinutes)}, pass by ${g.marketBiasBps / 100}%, stake ${tokensM(BigInt(g.proposalStake))} tokens</span></li>
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
    await sendAll(built.transactions.map((t) => t.instructions), { extra: [[mint], []], say })
    history.pushState(null, '', `/raise/${mint.publicKey.toBase58()}`)
  }, 'Raise open.')
}

function raiseCard(r, meta) {
  const q = quoteOf(r.quoteMint)
  const pct = r.goal ? Math.min(100, Number((r.totalCommitted * 1000n) / r.goal) / 10) : 0
  const state = r.state === 'live' ? (r.endsAt > nowS() ? `ends in ${until(r.endsAt)}` : 'ended, settling') : r.state
  return `<a class="raise" href="/raise/${esc(r.baseMint)}">
    <div><div class="nm">${esc(meta.symbol || short(r.baseMint))}</div><div class="pair">${esc(meta.name)} · paired with ${esc(q.symbol)}</div></div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    <div class="meta"><span>${coins(r.totalCommitted, 0)} / ${coins(r.goal, 0)} ${esc(q.symbol)}</span><span>${esc(state)}</span></div>
  </a>`
}

async function renderRaise(mint) {
  const raise = await F.readRaise(connection, mint)
  if (!raise) {
    view.innerHTML = `${banner()}<a class="back" href="/raise">← Fair launches</a><h1>No raise here</h1><p class="lede">Nothing was raised for ${esc(short(mint))} on ${esc(config.cluster)}.</p>`
    wireBanner()
    return
  }
  const q = quoteOf(raise.quoteMint)
  const [meta] = await names([raise.baseMint])
  const dao = raise.state === 'succeeded' ? await F.readDao(connection, raise.baseMint, raise.quoteMint) : null
  const mine = session ? await F.readCommitment(connection, raise, session.address) : null
  const pct = Number((raise.totalCommitted * 1000n) / raise.goal) / 10
  const ended = raise.endsAt <= nowS()
  const state = raise.state === 'live' ? (ended ? 'ended' : 'live') : raise.state
  const price = (raise.goal * 1_000_000n) / raise.tokensForInvestors

  view.innerHTML = `${banner()}
    <a class="back" href="/raise">← Fair launches</a>
    <h1>${esc(meta.symbol || short(raise.baseMint))} <span class="badge ${state === 'live' ? 'live' : ''}">${esc(state)}</span></h1>
    <p class="lede">${esc(meta.name)} · a fair launch paired with ${esc(q.symbol)} · mint <span class="skel">${esc(short(raise.baseMint))}</span></p>
    <div class="totals">
      <div class="tot"><span class="lab">Committed</span><span class="big">${coins(raise.totalCommitted, 0)} ${esc(q.symbol)}</span><span class="sub">of ${coins(raise.goal, 0)} · ${pct}%</span></div>
      <div class="tot"><span class="lab">Price per token</span><span class="big">${coins(price, 6)}</span><span class="sub">${esc(q.symbol)}, the same for everyone</span></div>
      <div class="tot"><span class="lab">${state === 'live' ? 'Ends in' : 'Ended'}</span><span class="big">${state === 'live' ? until(raise.endsAt) : new Date(raise.endsAt * 1000).toLocaleString()}</span></div>
      <div class="tot"><span class="lab">To backers</span><span class="big">${tokensM(raise.tokensForInvestors)}</span><span class="sub">tokens, pro rata</span></div>
    </div>
    <div class="progress" style="margin:-18px 0 28px"><i style="width:${Math.min(100, pct)}%"></i></div>
    <div class="cols">
      <div class="card hot" id="position">${positionCard(raise, mine, q, ended)}</div>
      <div class="card"><h2>The deal</h2>${termsList(q)}</div>
    </div>
    <div id="dao"></div>`
  wireBanner()
  wirePosition(raise, q)
  if (dao) await renderDao(dao, q, meta)
}

function positionCard(raise, mine, q, ended) {
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
      <button class="btn" type="button" id="p-commit">Commit</button><p class="status" id="p-status"></p>`
  }
  if (raise.state === 'live') {
    return `<h2>The raise has ended</h2><p>Settling it pays the pool and the treasury, or opens refunds if it missed its goal.
      LFOwn's keeper does it within a minute; anyone can.</p>
      <button class="btn" type="button" id="p-settle">Settle now</button><p class="status" id="p-status"></p>`
  }
  if (raise.state === 'failed') {
    if (!committed) return '<h2>The raise missed its goal</h2><p>Every backer takes their whole commitment back. You had none here.</p>'
    return mine.settled ? `<h2>Refunded</h2><p>Your ${coins(committed)} ${esc(q.symbol)} came back.</p>`
      : `<h2>The raise missed its goal</h2><p>Your ${coins(committed)} ${esc(q.symbol)} come back in full.</p>
        <button class="btn" type="button" id="p-refund">Take it back</button><p class="status" id="p-status"></p>`
  }
  if (!committed) return '<h2>The raise succeeded</h2><p>You did not back it. Its token trades in the DAO\'s pool below.</p>'
  const a = F.allocation(raise, committed)
  if (mine.settled) return `<h2>Claimed</h2><p>You received ${tokensM(a.tokens)} tokens${a.refund ? ` and ${coins(a.refund)} ${esc(q.symbol)} back` : ''}.</p>`
  const opensAt = raise.settledAt + raise.claimDelaySeconds
  return `<h2>Your allocation</h2>
    <p><b>${tokensM(a.tokens)} tokens</b>${a.refund ? ` and <b>${coins(a.refund)} ${esc(q.symbol)}</b> back, the part over the goal` : ''}.</p>
    ${raise.claimsOpen || nowS() >= opensAt
      ? '<button class="btn" type="button" id="p-claim">Claim</button>'
      : `<p class="hint">Claims open as soon as the DAO's pool exists (the keeper opens it within a minute), and on their own after ${until(opensAt)} whatever happens.</p>`}
    <p class="status" id="p-status"></p>`
}

function wirePosition(raise, q) {
  $('#p-connect')?.addEventListener('click', () => ensureWallet().catch(() => {}))
  const status = $('#p-status')
  wire($('#p-commit'), status, async (say) => {
    const amount = Math.round(Number($('#p-amount').value) * 1e6)
    if (!(amount > 0)) throw new Error(`Enter an amount of ${q.symbol}.`)
    await sendAll([[await F.commitIx(connection, raise, session.address, BigInt(amount))]], { say })
  }, 'Committed.')
  wire($('#p-settle'), status, async (say) => sendAll([[await F.settleIx(connection, raise, session.address)]], { say }), 'Settled.')
  wire($('#p-claim'), status, async (say) => sendAll([[await F.claimIx(connection, raise, session.address)]], { say }), 'Claimed.')
  wire($('#p-refund'), status, async (say) => sendAll([[await F.refundIx(connection, raise, session.address)]], { say }), 'Refunded.')
}

// ── the DAO ──────────────────────────────────────────────────────────────────

async function renderDao(d, q, meta) {
  const box = $('#dao')
  const p = F.programs(connection)
  const pool = await p.cpAmm.account.pool.fetch(d.pool)
  const sqrt = Number(BigInt(pool.sqrtPrice.toString())) / 2 ** 64
  const price = sqrt * sqrt // coin per token
  const [treasury, mineTokens, proposals] = await Promise.all([
    tokenBalance(d.quoteMint, d.treasury),
    session ? tokenBalance(d.baseMint, session.address) : 0n,
    F.readProposals(connection, d, d.proposalCount),
  ])
  const g = d.governance
  const stake = BigInt(g.proposalStake.toString())
  box.innerHTML = `
    <div class="sec-head"><h2>The DAO</h2><span class="skel">${esc(short(d.dao))} · governed by futarchy</span></div>
    <div class="totals">
      <div class="tot"><span class="lab">Pool price</span><span class="big">${price.toPrecision(3)}</span><span class="sub">${esc(q.symbol)} per ${esc(meta.symbol)}</span></div>
      <div class="tot"><span class="lab">Treasury</span><span class="big">${coins(treasury)} ${esc(q.symbol)}</span><span class="sub">moves only when a proposal wins</span></div>
      <div class="tot"><span class="lab">Proposals</span><span class="big">${d.proposalCount}</span><span class="sub">${d.activeProposal ? 'one is trading now' : 'none trading'}</span></div>
      ${session ? `<div class="tot"><span class="lab">You hold</span><span class="big">${tokensM(mineTokens)}</span><span class="sub">${esc(meta.symbol)}</span></div>` : ''}
    </div>
    <div class="cols">
      <div>${proposals.length ? proposals.map((x) => proposalCard(x, d, q, meta)).join('') : '<p class="empty">No proposal yet.</p>'}</div>
      <div class="card">
        <h2>Propose</h2>
        <p>Anyone holding ${tokensM(stake)} ${esc(meta.symbol)} can ask the market. The stake comes back once it decides.
          Markets run ${minutes(g.proposalLengthMinutes)}; an option has to beat the status quo by ${g.marketBiasBps / 100}%.</p>
        <label><span class="lab">Question (64 characters)</span><input id="n-title" maxlength="64" placeholder="Pay the designer 50 ${esc(q.symbol)}"></label>
        <div class="row">
          <label><span class="lab">If it passes</span><select id="n-kind"><option value="transfer">Pay from the treasury</option><option value="mint">Mint new ${esc(meta.symbol)}</option></select></label>
          <label><span class="lab">Amount</span><input id="n-amount" inputmode="decimal" placeholder="50"></label>
        </div>
        <label><span class="lab">To</span><input id="n-to" placeholder="${session ? esc(session.address) : 'a wallet address'}"></label>
        <button class="btn" type="button" id="n-go" ${session && mineTokens < stake ? 'disabled' : ''}>Propose</button>
        <p class="status" id="n-status">${session && mineTokens < stake ? `You need ${tokensM(stake)} ${esc(meta.symbol)} to propose.` : ''}</p>
      </div>
    </div>`
  wireDao(d, q, proposals)
}

function describe(action, q, meta) {
  if (action.transfer) {
    const symbol = action.transfer.mint.toBase58() === q.mint ? q.symbol : meta.symbol
    return `pay ${coins(action.transfer.amount)} ${esc(symbol)} from the treasury to ${esc(short(action.transfer.recipient.toBase58()))}`
  }
  return `mint ${tokensM(action.mintTo.amount)} ${esc(meta.symbol)} to ${esc(short(action.mintTo.recipient.toBase58()))}`
}

function proposalCard(x, d, q, meta) {
  const ends = x.createdAt + x.lengthMinutes * 60
  const warmEnd = x.createdAt + x.warmupSeconds
  const labels = ['Status quo', 'Pass']
  const prices = x.markets.map((m) => (m ? F.observationPrice(m.twap) : 0))
  const lead = prices[1] > prices[0] * (1 + x.marketBiasBps / 10_000) ? 1 : 0
  const state = x.state === 'resolved' ? `decided: ${labels[x.winner].toLowerCase()}`
    : x.state === 'pending' ? `trading · ${until(ends)} left${nowS() < warmEnd ? ' · warming up' : ''}`
    : x.prepared ? 'opening its markets' : 'being written'
  const actions = (x.actions[1] ?? []).map((a) => describe(a, q, meta)).join('; ') || 'nothing'
  return `<div class="proposal" data-id="${x.id}">
    <div><div class="title">${esc(x.metadata || `Proposal ${x.id}`)}</div>
      <div class="meta"><span>#${x.id} · by ${esc(short(x.creator))}</span><span class="badge ${x.state === 'pending' ? 'live' : x.state === 'resolved' ? 'won' : ''}">${esc(state)}</span></div></div>
    <p class="hint">If it passes: ${actions}.</p>
    ${x.state === 'setup' ? '' : `<div class="opts">${labels.map((l, i) => `<div class="opt ${(x.state === 'resolved' ? x.winner : lead) === i ? 'lead' : ''}">
      <span class="lab">${l}${x.state === 'resolved' && x.winner === i ? ' — won' : ''}</span>
      <span class="price">${prices[i] ? prices[i].toPrecision(3) : '—'}</span><span class="hint">TWAP, ${esc(q.symbol)} per ${esc(meta.symbol)}</span></div>`).join('')}</div>`}
    ${x.state === 'pending' && session ? `<div class="actions">
      <input class="t-amount" inputmode="decimal" placeholder="${esc(q.symbol)} amount">
      <button class="btn t-back" data-option="1" type="button">Back pass</button>
      <button class="btn ghost t-back" data-option="0" type="button">Back status quo</button></div>
      <p class="hint">Your ${esc(q.symbol)} becomes a claim on each outcome, and the side you back is bought: if it wins, you keep the ${esc(meta.symbol)} it bought.</p>` : ''}
    ${x.state === 'resolved' && session ? '<div class="actions"><button class="btn ghost t-redeem" type="button">Redeem my winning side</button></div>' : ''}
    <p class="status"></p>
  </div>`
}

function wireDao(d, q, proposals) {
  for (const card of view.querySelectorAll('.proposal')) {
    const id = Number(card.dataset.id)
    const status = card.querySelector('.status')
    for (const b of card.querySelectorAll('.t-back')) {
      wire(b, status, async (say) => {
        const amount = Math.round(Number(card.querySelector('.t-amount').value) * 1e6)
        if (!(amount > 0)) throw new Error(`Enter an amount of ${q.symbol}.`)
        await sendAll([await F.backOptionIxs(connection, d, id, session.address, Number(b.dataset.option), BigInt(amount))], { say })
      }, 'Backed.')
    }
    wire(card.querySelector('.t-redeem'), status, async (say) =>
      sendAll([await F.redeemWinningsIxs(connection, d, id, session.address)], { say }), 'Redeemed.')
  }
  wire($('#n-go'), $('#n-status'), async (say) => {
    const wallet = await ensureWallet()
    const title = $('#n-title').value.trim()
    if (!title) throw new Error('Write the question.')
    const amount = Number($('#n-amount').value)
    if (!(amount > 0)) throw new Error('Enter an amount.')
    let to
    try { to = new PublicKey($('#n-to').value.trim() || wallet.address) } catch { throw new Error('That is not a wallet address.') }
    const units = BigInt(Math.round(amount * 1e6))
    const action = $('#n-kind').value === 'mint'
      ? { mintTo: { amount: units, recipient: to } }
      : { transfer: { mint: d.quoteMint, amount: units, recipient: to } }
    const id = d.proposalCount
    // Two transactions, one approval: the proposal and its markets, then its option and
    // the liquidity it takes out of the pool. From then on anyone can launch it.
    await sendAll([
      await F.proposeIxs(connection, d, id, wallet.address, title),
      [await F.setActionsIx(connection, d, id, wallet.address, 1, [action]), await F.prepareIx(connection, d, id, wallet.address)],
    ], { say })
  }, 'Proposed. Its markets open within a minute.')
}

// ── routing ──────────────────────────────────────────────────────────────────

let rendering = false
async function render() {
  if (!config || rendering) return
  rendering = true
  try {
    const tail = location.pathname.replace(/^\/raise\/?/, '').replace(/\/$/, '')
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tail)) await renderRaise(tail)
    else await renderIndex()
  } catch (e) {
    console.error(e)
    view.innerHTML = `<p class="empty">Could not read the chain: ${esc(fairError(e))}</p>`
  } finally {
    rendering = false
  }
}

view.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/raise"]')
  if (!a || e.metaKey || e.ctrlKey) return
  e.preventDefault()
  history.pushState(null, '', a.getAttribute('href')) // renders, see below
})
window.addEventListener('popstate', render)
// Pushed by the "Open the raise" handler after it lands.
const push = history.pushState.bind(history)
history.pushState = (...args) => { push(...args); setTimeout(render, 0) }

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
  if (config.cluster === 'localnet') (await import('./dev-wallet.js')).installDevWallet()
  paintConnect()
  await render()
  for (let wait = 0; wait < 8 && !available().length; wait++) await new Promise((r) => setTimeout(r, 250))
  const resumed = await reconnect().catch(() => null)
  if (resumed) { session = resumed; paintConnect(); render() }
  // A raise and its markets move by the minute; so does this page.
  setInterval(() => { if (!busy && !document.hidden && !document.activeElement?.matches('input, select')) render() }, 20_000)
}
boot()
