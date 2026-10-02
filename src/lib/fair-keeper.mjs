// LFOwn — the fair-launch keeper: every step anyone may take, taken on time.
//
// Nothing in a fair launch needs LFOwn's permission, but most of it needs someone to press
// the button: open the DAO of a raise that met its goal (or settle one that did not as
// failed), record the pool
// price so the guard has a checkpoint, launch a proposal its creator prepared, crank the
// markets' TWAP every minute, finalize, bring the liquidity home, execute the winner's
// actions, return the proposer's stake, claim the pool's fees. This does all of it, every
// time it runs, and it can do nothing else: every instruction here is one the programs
// would take from a stranger, and none sends anything to the keeper.
//
// One run is one pass over every raise and DAO. The Worker's minute cron runs it when
// FAIR_KEEPER_KEY is set (it is not, in production); scripts/fair-keeper.mjs runs it in a
// loop against a local validator. Each step is caught on its own: one stuck proposal must
// not stop the others. It tends only raises on LFOwn's own terms, and sends a bounded
// number of transactions per pass: anyone can open a raise, and a keeper that paid for
// every one of them could be drained, or kept busy past its cron's time.

import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import * as F from './fair-launch.mjs'
import { waitFor } from './confirm.mjs'

/** A keypair from a setting, with an error that never quotes the setting. */
const keypairFrom = (secret) => {
  try {
    return Keypair.fromSecretKey(Uint8Array.from(typeof secret === 'string' ? JSON.parse(secret) : secret))
  } catch {
    throw new Error('a fair-launch key setting is not a JSON secret key')
  }
}

/**
 * The checkpoint moves 1% a minute at most, toward the pool's price: the keeper moves it
 * every minute, so it follows a real price and undoes anyone who tried to drag it.
 */
const CHECKPOINT_REFRESH = 60
/** Transactions per pass, all DAOs and raises together. */
const MAX_SENDS_PER_PASS = 40
/** DAOs opened per pass: each costs the keeper about 0.06 SOL of rent. */
const MAX_BOOTSTRAPS_PER_PASS = 2
/** Transactions one DAO may take in a pass, so one busy DAO cannot starve the others. */
const MAX_SENDS_PER_DAO = 8
/** A proposal left in Setup this long, its liquidity never out, is cancelled (the program's CANCEL_AFTER_SECONDS). */
const CANCEL_AFTER = 24 * 60 * 60
/** Pool fees are claimed at most this often per DAO. */
const FEE_CLAIM_EVERY = 60 * 60
/** The TWAP takes one observation a minute at most. */
const CRANK_EVERY = 60

async function send(connection, signer, ixs, label, log) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs)
  tx.feePayer = signer.publicKey
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.sign(signer)
  const signature = await connection.sendRawTransaction(tx.serialize())
  // Polled, not subscribed: a Worker has no websocket to the RPC to wait on.
  await waitFor(connection, signature, lastValidBlockHeight, { timeoutMs: 60_000 })
  log(`${label} ✓ ${signature.slice(0, 12)}…`)
  return signature
}

/** The chain's clock, not this machine's: a local validator's can differ by minutes. */
async function chainNow(connection) {
  const slot = await connection.getSlot('confirmed')
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000)
}

const tokenBalance = async (connection, address) => {
  try { return BigInt((await connection.getTokenAccountBalance(address)).value.amount) } catch { return 0n }
}

/**
 * One pass. `memory` remembers when fees were last claimed, per DAO: a Map in a script,
 * KV in the Worker, anything with async get/set.
 */
export async function runFairKeeper({ config, keeperSecret, memory = new Map(), log = console.log }) {
  const connection = new Connection(config.rpc, 'confirmed')
  const keeper = keypairFrom(keeperSecret)
  const me = keeper.publicKey
  let budget = MAX_SENDS_PER_PASS
  const step = async (label, build) => {
    if (budget <= 0) return false
    try {
      const ixs = await build()
      if (ixs?.length) {
        budget -= 1
        await send(connection, keeper, ixs, label, log)
      }
      return true
    } catch (e) {
      log(`${label} ✗ ${String(e.message ?? e).split('\n')[0].slice(0, 200)}`)
      return false
    }
  }

  await F.assertCluster(connection, config.cluster)
  const now = await chainNow(connection)
  const raises = []
  for (const r of await F.listRaises(connection)) if (await F.isStandardRaise(connection, config, r)) raises.push(r)

  // Raises that ended first, a couple of DAOs opened per pass: a raise has a deadline, and
  // one that misses it is refunded instead of becoming its DAO.
  let bootstraps = MAX_BOOTSTRAPS_PER_PASS
  for (const r of raises) {
    if (budget <= 0) break
    if (r.state !== 'live' || now < r.endsAt) continue
    const tag = r.baseMint.slice(0, 6)
    // Met its goal in time: settling it *is* opening its DAO, in one instruction, after its
    // three associated accounts are opened on their own (4th audit M2). Otherwise it
    // failed, and settling it lets its backers take their coins back.
    const opens = r.totalCommitted >= r.goal && now < r.endsAt + r.claimDelaySeconds
    if (opens && bootstraps-- <= 0) continue
    if (opens && !(await step(`${tag} accounts for the DAO`, async () => F.bootstrapAccountIxs(r, me)))) continue
    await step(opens ? `${tag} open the DAO` : `${tag} settle as failed`, async () => [opens
      ? await F.bootstrapIx(connection, r, me, { terms: config.terms, governance: config.governance })
      : await F.settleIx(connection, r, me)])
  }

  // Then every DAO, a share each, starting one further along every pass: with a fixed
  // order, the first DAOs took the whole budget and the last ones' checkpoints went stale
  // (4th audit M6).
  const daos = raises.filter((r) => r.state === 'succeeded')
  const start = Number(await memory.get('cursor') ?? 0) % Math.max(1, daos.length)
  await memory.set('cursor', String(start + 1))
  for (const r of [...daos.slice(start), ...daos.slice(0, start)]) {
    if (budget <= 0) break
    const dao = await F.readDao(connection, r.baseMint, r.quoteMint).catch(() => null)
    if (!dao) continue
    let share = MAX_SENDS_PER_DAO
    const daoStep = async (label, build) => (share-- > 0 ? step(label, build) : false)
    await tendDao({ connection, me, dao, now, step: daoStep, memory, tag: r.baseMint.slice(0, 6) })
  }
  if (budget <= 0) log('pass stopped at its transaction budget; the rest waits for the next one')
}

async function tendDao({ connection, me, dao: d, now, step, memory, tag }) {
  // Not while a proposal's markets hold the liquidity: the program refuses it then, and the
  // winning market's TWAP sets the checkpoint when the liquidity comes home.
  if (!d.activeProposal && now - d.checkpoint.at >= CHECKPOINT_REFRESH) {
    await step(`${tag} record price`, async () => [await F.recordPriceIx(connection, d)])
  }

  const proposals = await F.readProposals(connection, d, d.proposalCount)
  for (const p of proposals) {
    const ptag = `${tag} #${p.id}`
    if (p.state === 'setup' && !p.marketsOpen) {
      // Opened, its markets never created (the proposer's next transaction failed): anyone may.
      await step(`${ptag} markets`, async () => [await F.marketsIx(connection, d, p.id, me)])
      continue
    }
    if (p.state === 'setup' && !p.prepared && now >= p.openedAt + CANCEL_AFTER) {
      // Left a day without its liquidity out: cancelled, its whole stake back to its creator.
      await step(`${ptag} cancel`, async () => [await F.cancelProposalIx(connection, d, p.id, me, p.creator)])
      continue
    }
    if (p.state === 'setup' && p.prepared) {
      // Prepared and left: anyone may launch it, so the liquidity is never stranded.
      const { accountIxs, launch } = await F.launchIxs(connection, d, p.id, me)
      if (await step(`${ptag} market accounts`, async () => accountIxs)) {
        await step(`${ptag} launch`, async () => [launch])
      }
      continue
    }
    if (p.state === 'pending') {
      const ends = p.createdAt + p.lengthMinutes * 60
      const stale = p.markets.some((m) => m && now - m.lastUpdate >= CRANK_EVERY)
      if (stale) await step(`${ptag} crank`, () => F.crankIxs(connection, d, p.id))
      if (now >= ends) await step(`${ptag} finalize`, async () => [await F.finalizeIx(connection, d, p.id, me)])
      continue
    }
    if (p.state !== 'resolved') continue
    if (d.activeProposal === p.address) {
      await step(`${ptag} bring the liquidity home`, async () => [await F.redeemLiquidityIx(connection, d, p.id, p.winner, me)])
    }
    // A winner runs after the DAO's delay and within its window, or never.
    const opensAt = p.resolvedAt + Number(d.governance.executionDelaySeconds)
    const closesAt = opensAt + Number(d.governance.executionWindowSeconds)
    if (p.winner > 0 && now >= opensAt && now < closesAt) {
      for (const [i, action] of (p.actions[p.winner] ?? []).entries()) {
        if (p.executed?.[p.winner] & (1 << i)) continue
        await step(`${ptag} execute action ${i}`, async () => [await F.executeIx(connection, d, p.id, p.winner, i, action, me)])
      }
    }
    if (p.stake > 0n) {
      await step(`${ptag} return stake`, async () => [await F.returnStakeIx(connection, d, p.id, me, p.creator)])
    }
  }

  // Whatever came home from the markets goes back into the pool, once the guard allows.
  const fresh = await F.readDao(connection, d.baseMint, d.quoteMint)
  if (!fresh.activeProposal) {
    const [b, q] = await Promise.all([tokenBalance(connection, d.liquidityBase), tokenBalance(connection, d.liquidityQuote)])
    // Only within the guard's band: right after a decision the checkpoint is the winning
    // market's TWAP, and until the pool's price is near it the refresh above walks the
    // checkpoint over, a step a minute; trying the return meanwhile would only fail.
    if (b > 1_000n && q > 1_000n && await F.withinPriceBand(connection, fresh)) {
      await step(`${tag} return liquidity`, async () => [await F.returnLiquidityIx(connection, d, me)])
    }
  }

  const last = Number(await memory.get(`fees:${d.dao.toBase58()}`) ?? 0)
  if (now - last >= FEE_CLAIM_EVERY) {
    if (await step(`${tag} claim pool fees`, async () => [await F.claimPoolFeesIx(connection, d, me)])) {
      await memory.set(`fees:${d.dao.toBase58()}`, String(now))
    }
  }
}

/** What the faucet gives, per stand-in coin, once per wallet. */
const FAUCET_COINS = 5_000n * F.UNIT

/**
 * Test cluster only: the stand-in coins for a wallet that has none of them, and test SOL on
 * localnet. The faucet key holds the stand-in coins' mint authority (scripts/localnet.mjs
 * and onchain/scripts/devnet-setup.mjs create them so). A wallet that already holds some
 * gets nothing more: the faucet pays the fees and the accounts' rent.
 */
export async function faucet(config, faucetSecret, address) {
  let to
  try { to = new PublicKey(address) } catch { throw new Error('not a wallet address') }
  const connection = new Connection(config.rpc, 'confirmed')
  await F.assertCluster(connection, config.cluster)
  const key = keypairFrom(faucetSecret)
  const held = await Promise.all(config.quotes.map((q) => tokenBalance(connection, getAssociatedTokenAddressSync(new PublicKey(q.mint), to, true))))
  if (held.some((b) => b > 0n)) throw new Error('this wallet already has test coins')
  if (config.cluster === 'localnet') {
    await waitFor(connection, await connection.requestAirdrop(to, 2 * LAMPORTS_PER_SOL), null, { timeoutMs: 30_000 })
  }
  const ixs = config.quotes.flatMap((q) => {
    const mint = new PublicKey(q.mint)
    const account = getAssociatedTokenAddressSync(mint, to, true)
    return [
      createAssociatedTokenAccountIdempotentInstruction(key.publicKey, account, to, mint),
      createMintToInstruction(mint, account, key.publicKey, FAUCET_COINS),
    ]
  })
  if (ixs.length) await send(connection, key, ixs, `faucet ${to.toBase58().slice(0, 6)}`, () => {})
  return { sol: config.cluster === 'localnet' ? 2 : 0, coins: config.quotes.map((q) => ({ symbol: q.symbol, amount: 5_000 })) }
}
