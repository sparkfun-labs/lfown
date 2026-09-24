// LFOwn fair launch — one whole launch against the local chain, through the site's own
// library and keeper. No browser: this proves the instructions the pages will send.
//
//   (in onchain/) npm run localnet          then, at the root:
//   node scripts/test-fair-local.mjs
//
// A raise opened for 20 seconds and oversubscribed, settled and turned into a DAO by the
// keeper, claimed; a proposal staked and prepared by a backer, launched by the keeper,
// backed by a trader, decided by its market, executed, its liquidity and stake returned —
// every step checked on chain. About seven minutes, most of it the proposal's market.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { fairConfig } from '../src/fair-api.mjs'
import { faucet, runFairKeeper } from '../src/lib/fair-keeper.mjs'
import * as F from '../src/lib/fair-launch.mjs'

const env = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
  .split('\n').map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]))
const config = fairConfig(env)
if (config?.cluster !== 'localnet') throw new Error('Run `npm run localnet` in onchain/ first: this test only runs on a local chain.')
const connection = new Connection(config.rpc, 'confirmed')
const coin = config.quotes[0]
const quoteMint = new PublicKey(coin.mint)
const stamp = () => new Date().toISOString().slice(11, 19)
const say = (m) => console.log(`${stamp()} ${m}`)
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000))
const balance = async (address) => {
  try { return BigInt((await connection.getTokenAccountBalance(address)).value.amount) } catch { return 0n }
}
const whole = (units) => Number(units) / 1e6

async function send(ixs, signers, label) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs)
  tx.feePayer = signers[0].publicKey
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.sign(...signers)
  const signature = await connection.sendRawTransaction(tx.serialize())
  const { value } = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  if (value?.err) throw new Error(`${label}: ${JSON.stringify(value.err)}`)
  return signature
}
const memory = new Map()
const keeperPass = () => runFairKeeper({ config, keeperSecret: env.FAIR_KEEPER_KEY, memory, log: (m) => say(`  keeper: ${m}`) })

// ── people ──
const [creator, alice, bob] = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
for (const who of [creator, alice, bob]) await faucet(config, env.FAIR_FAUCET_KEY, who.publicKey.toBase58())
say(`three wallets with 2 SOL and 5,000 ${coin.symbol} each`)

// ── the raise ──
const mint = Keypair.generate()
const terms = { ...config.terms, durationSeconds: 20 }
const opened = await F.buildOpenRaise(connection, {
  creator: creator.publicKey, mint, quoteMint, usdPrice: coin.usdPrice,
  name: 'Fair Test', symbol: 'FAIR', uri: '', terms, governance: config.governance,
})
await send(opened.transactions[0].instructions, [creator, mint], 'token')
await send(opened.transactions[1].instructions, [creator], 'raise')
const raise = await F.readRaise(connection, mint.publicKey)
assert.equal(raise.state, 'live')
assert.equal(raise.goal, F.goalInCoin(coin.usdPrice))
say(`raise open: goal ${whole(raise.goal)} ${coin.symbol} ($5,000), ${whole(raise.tokensForInvestors) / 1e6}M tokens to backers`)
const meta = await connection.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from('metadata'), F.METADATA_PROGRAM.toBuffer(), mint.publicKey.toBuffer()], F.METADATA_PROGRAM)[0])
assert.ok(meta && Buffer.from(meta.data).includes(Buffer.from('Fair Test')), 'the token has its name on chain')

// Oversubscribed: 600 + 400 = 1,000 against a goal of about 836.
await send([await F.commitIx(connection, raise, alice.publicKey, 600n * F.UNIT)], [alice], 'alice commits')
await send([await F.commitIx(connection, raise, bob.publicKey, 400n * F.UNIT)], [bob], 'bob commits')
const committed = await F.readRaise(connection, mint.publicKey)
assert.equal(committed.totalCommitted, 1_000n * F.UNIT)
say('alice commits 600, bob 400: oversubscribed')

// ── the keeper settles it and opens the DAO the raise committed to ──
while ((await F.readRaise(connection, mint.publicKey)).endsAt > Math.floor(Date.now() / 1000) - 2) await sleep(2)
await keeperPass() // settle
await keeperPass() // open the DAO
const settled = await F.readRaise(connection, mint.publicKey)
assert.equal(settled.state, 'succeeded')
assert.ok(settled.claimsOpen, 'claims opened with the pool')
const dao = await F.readDao(connection, mint.publicKey, quoteMint)
assert.ok(dao, 'the keeper opened the DAO')
assert.equal(await balance(F.ata(quoteMint, dao.treasury)), raise.goal - raise.quoteToPool, 'the treasury got the 20% of the goal the pool did not')
say(`keeper settled the raise and opened DAO ${dao.dao.toBase58().slice(0, 8)}… with its pool`)

for (const who of [alice, bob]) {
  const before = await balance(F.ata(quoteMint, who.publicKey))
  await send([await F.claimIx(connection, settled, who.publicKey)], [who], 'claim')
  const expected = F.allocation(settled, who === alice ? 600n * F.UNIT : 400n * F.UNIT)
  assert.equal(await balance(F.ata(mint.publicKey, who.publicKey)), expected.tokens, 'tokens as the library predicts')
  assert.equal(await balance(F.ata(quoteMint, who.publicKey)) - before, expected.refund, 'refund as the library predicts')
}
say(`claims: alice ${whole(F.allocation(settled, 600n * F.UNIT).tokens) / 1e6}M tokens, bob ${whole(F.allocation(settled, 400n * F.UNIT).tokens) / 1e6}M, the excess refunded`)

// ── a proposal: alice stakes, pays herself 10 coins from the treasury if it passes ──
await sleep(62) // the bootstrap's price checkpoint becomes usable after a minute
const d = await F.readDao(connection, mint.publicKey, quoteMint)
await send(await F.proposeIxs(connection, d, 0, alice.publicKey, 'Pay alice 10 tMETA'), [alice], 'propose')
await send([
  await F.setActionsIx(connection, d, 0, alice.publicKey, 1, [{ transfer: { mint: quoteMint, amount: 10n * F.UNIT, recipient: alice.publicKey } }]),
  await F.prepareIx(connection, d, 0, alice.publicKey),
], [alice], 'actions and liquidity')
say('alice staked 100k tokens, proposed, and took the liquidity out; she walks away')
await keeperPass() // launches it
let [p] = await F.readProposals(connection, await F.readDao(connection, mint.publicKey, quoteMint), 1)
assert.equal(p.state, 'pending', 'the keeper launched the prepared proposal')

await send(await F.backOptionIxs(connection, d, 0, bob.publicKey, 1, 200n * F.UNIT), [bob], 'bob backs option 1')
say('bob backs option 1 with 200 tMETA; the market runs')

for (let i = 0; i < 40; i++) {
  await keeperPass()
  ;[p] = await F.readProposals(connection, await F.readDao(connection, mint.publicKey, quoteMint), 1)
  if (p.state === 'resolved') break
  await sleep(15)
}
assert.equal(p.state, 'resolved', 'the market decided')
assert.equal(p.winner, 1, 'option 1 won')
say(`option 1 won: TWAPs ${p.markets.map((m) => F.observationPrice(m.twap).toFixed(8)).join(' vs ')}`)

// One more pass or two: liquidity home and back in the pool, action executed, stake returned.
const aliceCoinBefore = await balance(F.ata(quoteMint, alice.publicKey))
for (let i = 0; i < 6; i++) { await keeperPass(); await sleep(12) }
const after = await F.readDao(connection, mint.publicKey, quoteMint)
assert.equal(after.activeProposal, null, 'the liquidity came home')
;[p] = await F.readProposals(connection, after, 1)
assert.equal(p.executed[1] & 1, 1, 'the transfer ran')
assert.equal(p.stake, 0n, 'the stake went back')
assert.ok(await balance(F.ata(quoteMint, alice.publicKey)) - aliceCoinBefore >= 10n * F.UNIT, 'alice was paid by the treasury')
say('the keeper brought the liquidity home, paid alice from the treasury, and returned her stake')

await send(await F.redeemWinningsIxs(connection, d, 0, bob.publicKey), [bob], 'bob redeems')
say(`bob redeemed his winning side: ${whole(await balance(F.ata(mint.publicKey, bob.publicKey))) / 1e6}M tokens now`)
say('done: a whole fair launch, raise to decision, with no key but the participants’ own')
process.exit(0)
