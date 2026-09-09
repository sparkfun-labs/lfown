// LFOwn — collect the DAO's share of trading fees.
//
// Fees do not arrive anywhere on their own. Every trade parks the partner's share
// inside the pool account; somebody has to call claimPartnerTradingFee, pool by
// pool, and the program then sends it to that config's fee claimer. This walks
// every pool LFOwn has a config for and claims what has accrued.
//
// The fee claimer is the only signer the program accepts, but it does not have to
// hold any SOL: the transaction fee and the destination account's rent can be paid
// by anybody who co-signs. That is the split here — the deployer pays, the claimer
// authorises.
//
//   node scripts/claim-fees.mjs                       # show what is waiting
//   LFOWN_ARM=yes node scripts/claim-fees.mjs         # claim (needs the claimer key)
//   node scripts/claim-fees.mjs --unsigned            # print transactions to sign
//                                                     # elsewhere, e.g. a multisig
//
// LFOWN_CLAIMER_KEYPAIR=/path/to/key.json points at the fee claimer's keypair when
// it is not the same file as the deployer's.

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { FEES } from '../src/lib/config.mjs'
import { buildRegistry } from '../src/lib/registry.mjs'
import { listLaunches } from '../src/lib/launches.mjs'
import { lpPositions, buildLpClaim } from '../src/lib/lp-fees.mjs'

const ARMED = process.env.LFOWN_ARM === 'yes'
const UNSIGNED = process.argv.includes('--unsigned')
const RPC = readFileSync('.dev.vars', 'utf8').match(/https:\/\/[^\s"]+/)[0]
const KEYPAIR_PATH = process.env.LFOWN_KEYPAIR
  ?? (existsSync('.keys/lfown-deployer.json') ? '.keys/lfown-deployer.json' : `${homedir()}/.config/solana/id.json`)
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))))

const claimerPath = process.env.LFOWN_CLAIMER_KEYPAIR
const claimer = claimerPath
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(claimerPath, 'utf8'))))
  : (payer.publicKey.toBase58() === FEES.recipient ? payer : null)

if (ARMED && !claimer) {
  console.error(`The fee claimer ${FEES.recipient} has to sign. Point at its keypair:`)
  console.error('  LFOWN_CLAIMER_KEYPAIR=/path/to/key.json LFOWN_ARM=yes node scripts/claim-fees.mjs')
  console.error('Or build the transactions for a wallet or multisig to sign:')
  console.error('  node scripts/claim-fees.mjs --unsigned')
  process.exit(1)
}
if (claimer && claimer.publicKey.toBase58() !== FEES.recipient) {
  console.error(`That keypair is ${claimer.publicKey.toBase58()}, not the fee claimer ${FEES.recipient}.`)
  process.exit(1)
}

const connection = new Connection(RPC, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')

const wrangler = (...a) => execFileSync('npx', ['wrangler', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const keys = JSON.parse(wrangler('kv', 'key', 'list', '--binding', 'REGISTRY', '--remote')).map((k) => k.name)

const { coins } = await buildRegistry()
const configs = []
for (const key of keys) {
  if (!key.startsWith('config:') && !key.startsWith('retired:')) continue
  const [, mint, tier] = key.split(':')
  const coin = coins.find((c) => c.mint === mint)
  if (!coin) continue
  const { config } = JSON.parse(wrangler('kv', 'key', 'get', '--binding', 'REGISTRY', key, '--remote'))
  configs.push({ config, mint, symbol: coin.symbol, usdPrice: coin.usdPrice, tier })
}

console.log(ARMED ? '*** ARMED ***' : 'dry run — set LFOWN_ARM=yes to claim')
console.log('claimer :', FEES.recipient, '(signs)')
console.log('receiver:', FEES.treasury, '(receives)')
console.log('payer   :', payer.publicKey.toBase58())
console.log('configs :', configs.length, '\n')

const pools = await listLaunches(client, connection, PublicKey, configs)
let total = 0

for (const p of pools) {
  const { poolState } = await client.state.getPool(new PublicKey(p.pool))
  const waiting = Number(poolState.partnerQuoteFee.toString()) / 1e6
  if (waiting <= 0) { console.log(`  ${(p.symbol ?? '?').padEnd(10)} nothing waiting`); continue }

  total += waiting * (p.quoteUsdPrice ?? 0)
  console.log(`  ${(p.symbol ?? '?').padEnd(10)} ${waiting} ${p.quoteSymbol} ≈ $${(waiting * (p.quoteUsdPrice ?? 0)).toFixed(2)}`)
  if (!ARMED && !UNSIGNED) continue

  try {
    const tx = await client.partner.claimPartnerTradingFeeToReceiver({
      feeClaimer: new PublicKey(FEES.recipient),
      payer: payer.publicKey,
      pool: new PublicKey(p.pool),
      maxBaseAmount: poolState.partnerBaseFee,
      maxQuoteAmount: poolState.partnerQuoteFee,
      receiver: new PublicKey(FEES.treasury), // the DAO, not the key that signs
    })
    tx.feePayer = payer.publicKey
    tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash

    if (UNSIGNED) {
      tx.partialSign(payer) // the payer's half; the claimer adds theirs
      console.log('    sign this:', tx.serialize({ requireAllSignatures: false }).toString('base64'))
      continue
    }
    const signers = claimer.publicKey.equals(payer.publicKey) ? [payer] : [payer, claimer]
    console.log('    claimed:', await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' }))
  } catch (e) {
    console.error('    failed:', e.message.split('\n')[0])
  }
}

// After graduation the fees move to a DAMM v2 position: different program, both
// tokens, and the DBC counters stop moving. Sweeping only the curve would quietly
// leave everything a graduated coin earns behind.
const prices = new Map(coins.map((c) => [c.mint, c.usdPrice]))
const positions = await lpPositions(connection, FEES.recipient)
if (positions.length) console.log('\ngraduated pools:')
for (const p of positions) {
  const usd = p.feeB * (prices.get(p.tokenB) ?? 0) + p.feeA * (prices.get(p.tokenA) ?? 0)
  if (p.feeA === 0 && p.feeB === 0) { console.log(`  ${p.pool.slice(0, 8)}… nothing waiting`); continue }
  total += usd
  console.log(`  ${p.pool.slice(0, 8)}… ${p.feeA} / ${p.feeB} ≈ $${usd.toFixed(2)}`)
  if (!ARMED) continue
  try {
    const tx = await buildLpClaim(connection, p, {
      owner: FEES.recipient, receiver: FEES.treasury, feePayer: payer.publicKey.toBase58(),
    })
    tx.feePayer = payer.publicKey
    const signers = claimer.publicKey.equals(payer.publicKey) ? [payer] : [payer, claimer]
    console.log('    claimed:', await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' }))
  } catch (e) {
    console.error('    failed:', e.message.split('\n')[0])
  }
}

console.log(`\ntotal waiting ≈ $${total.toFixed(2)}`)
if (!ARMED && total > 0) console.log('Run again with LFOWN_ARM=yes to claim.')
