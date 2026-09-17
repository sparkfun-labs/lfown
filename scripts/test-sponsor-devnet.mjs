// LFOwn — a free launch, end to end on devnet.
//
// The same transactions the launch page builds and the same check the Worker runs,
// against a throwaway quote mint and config. The creator wallet holds no SOL at all:
// if the launch lands, LFOwn's sponsor really paid for all of it.
//
//   node scripts/test-sponsor-devnet.mjs
//
// Spends devnet SOL from .keys/devnet.json only.

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, transfer } from '@solana/spl-token'
import {
  DynamicBondingCurveClient, buildCurve, TokenType, TokenDecimal, ActivationType, CollectFeeMode,
  MigrationOption, MigrationFeeOption, BaseFeeMode, TokenAuthorityOption, DEFAULT_MIGRATED_POOL_FEE_PARAMS,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DynamicFeeSharingClient } from '@meteora-ag/dynamic-fee-sharing-sdk'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FEES } from '../src/lib/config.mjs'
import { buildLaunchTransactions } from '../src/lib/launch-builder.mjs'
import { checkSponsored, MAX_SPONSOR_LAMPORTS } from '../src/lib/sponsor.mjs'
import { waitFor } from '../src/lib/confirm.mjs'

const KEY = readFileSync('.dev.vars', 'utf8').match(/api-key=([a-f0-9-]+)/)[1]
const connection = new Connection(`https://devnet.helius-rpc.com/?api-key=${KEY}`, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')
const programs = { dbc: client.pool.program, dfs: new DynamicFeeSharingClient(connection, 'confirmed').program }
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.keys/devnet.json', 'utf8'))))
const sol = (l) => (l / LAMPORTS_PER_SOL).toFixed(6)
const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`)

// A quote coin and a config on it, as create-config would open for an ownership coin.
const quoteMint = await createMint(connection, funder, funder.publicKey, null, 6)
const config = Keypair.generate()
const curve = buildCurve({
  token: { tokenType: TokenType.SPL, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.SIX, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
  fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: FEES.totalBps, endingFeeBps: FEES.totalBps, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: true, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: FEES.creatorSharePct, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
  migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, migratedPoolFee: DEFAULT_MIGRATED_POOL_FEE_PARAMS },
  liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 50, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50, creatorLiquidityPercentage: 0 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Slot, percentageSupplyOnMigration: 20, migrationQuoteThreshold: 1_000,
})
const configTx = await client.partner.createConfig({ config: config.publicKey, feeClaimer: funder.publicKey, leftoverReceiver: funder.publicKey, quoteMint, payer: funder.publicKey, ...curve })
await sendAndConfirmTransaction(connection, configTx, [funder, config], { commitment: 'confirmed' })
const configs = [{ config: config.publicKey.toBase58(), mint: quoteMint.toBase58() }]
say(`quote ${quoteMint.toBase58()} · config ${config.publicKey.toBase58()}`)

// The sponsor, funded for the run.
const sponsor = Keypair.generate()
await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: sponsor.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })), [funder], { commitment: 'confirmed' })
say(`sponsor ${sponsor.publicKey.toBase58()} funded with 0.1 SOL`)

const holderPot = Keypair.generate().publicKey.toBase58()

/** The launch page's side, then the Worker's: build, sign, check, simulate, send. */
async function freeLaunch(label, creator, { devBuyQuote = 0 } = {}) {
  const mint = Keypair.generate()
  const built = await buildLaunchTransactions({
    client, connection, config: config.publicKey.toBase58(), creator: creator.publicKey.toBase58(),
    token: { name: label, symbol: 'FREE', uri: 'https://example.invalid/f.json' },
    devBuyQuote, mint, quoteMint: quoteMint.toBase58(), holderPct: 37.5, holderPot, sponsor: sponsor.publicKey.toBase58(),
  })
  assert.equal(built.transactions.length, 2, 'a launch shared with holders is the vault, then the pool')

  // Browser: the creator signs the launch, then the new coin signs both. Sent as bytes.
  const launch = built.transactions[1]
  launch.partialSign(creator)
  const wire = built.transactions.map((tx) => { tx.partialSign(mint); return tx.serialize({ requireAllSignatures: false, verifySignatures: false }) })

  // Worker: parse, check, sign as payer, simulate, send in order.
  const txs = wire.map((b) => Transaction.from(b))
  const result = checkSponsored(txs, { sponsor: sponsor.publicKey, programs, configs })
  assert.equal(result.creator, creator.publicKey.toBase58())
  const creatorBefore = await connection.getBalance(creator.publicKey)
  const sponsorBefore = await connection.getBalance(sponsor.publicKey)
  for (const [i, tx] of txs.entries()) {
    tx.partialSign(sponsor)
    const before = await connection.getBalance(sponsor.publicKey)
    const sim = await connection.simulateTransaction(tx, undefined, [sponsor.publicKey])
    assert.equal(sim.value.err, null, `simulation ${i}: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-4).join(' | ')}`)
    const cost = before - Number(sim.value.accounts[0].lamports)
    assert(cost > 0 && cost <= MAX_SPONSOR_LAMPORTS, `transaction ${i} would cost the sponsor ${sol(cost)} SOL`)
    const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' })
    await waitFor(connection, signature, null, { timeoutMs: 60_000 })
  }
  const spent = sponsorBefore - (await connection.getBalance(sponsor.publicKey))
  const creatorSpent = creatorBefore - (await connection.getBalance(creator.publicKey))
  const { poolState } = await client.state.getPool(new PublicKey(built.pool))
  assert.equal(poolState.creator.toBase58(), built.vault, 'the pool must belong to its fee vault')
  const vault = await new DynamicFeeSharingClient(connection, 'confirmed').getFeeVault(new PublicKey(built.vault))
  assert.equal(vault.owner.toBase58(), creator.publicKey.toBase58(), 'the vault belongs to the creator, not the sponsor')
  say(`✔ ${label}: ${built.baseMint} · sponsor paid ${sol(spent)} SOL · creator paid ${sol(creatorSpent)} SOL`)
  return { spent, creatorSpent, poolState }
}

// 1. A creator with nothing at all.
const broke = Keypair.generate()
const first = await freeLaunch('no SOL, no initial buy', broke)
assert.equal(first.creatorSpent, 0, 'a free launch costs its creator nothing')
assert.equal(await connection.getBalance(broke.publicKey), 0)

// 2. A creator with an initial buy: their coins and their token account's rent, nothing more.
const buyer = Keypair.generate()
await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: buyer.publicKey, lamports: 0.004 * LAMPORTS_PER_SOL })), [funder], { commitment: 'confirmed' })
const from = await getOrCreateAssociatedTokenAccount(connection, funder, quoteMint, funder.publicKey)
await mintTo(connection, funder, quoteMint, from.address, funder, 100n * 1_000_000n)
const to = await getOrCreateAssociatedTokenAccount(connection, funder, quoteMint, buyer.publicKey)
await transfer(connection, funder, from.address, to.address, funder, 50n * 1_000_000n)
const second = await freeLaunch('with an initial buy', buyer, { devBuyQuote: 10 * 1_000_000 })
assert(Number(second.poolState.quoteReserve.toString()) > 0, 'the initial buy landed with the launch')
assert(second.creatorSpent < 0.0035 * LAMPORTS_PER_SOL, `the creator paid ${sol(second.creatorSpent)} SOL, more than a token account`)

// 3. The same transactions, one step off: the check refuses before anything is signed.
const mint = Keypair.generate()
const sneaky = await buildLaunchTransactions({
  client, connection, config: config.publicKey.toBase58(), creator: broke.publicKey.toBase58(),
  token: { name: 'sneaky', symbol: 'SNK', uri: 'https://example.invalid/s.json' },
  mint, quoteMint: quoteMint.toBase58(), holderPct: 37.5, holderPot, sponsor: sponsor.publicKey.toBase58(),
})
sneaky.transactions[1].add(SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: broke.publicKey, lamports: 50_000_000 }))
sneaky.transactions[1].partialSign(broke, mint)
sneaky.transactions[0].partialSign(mint)
assert.throws(() => checkSponsored(sneaky.transactions, { sponsor: sponsor.publicKey, programs, configs }), /program a launch does not use/)
say('✔ a launch with a transfer from the sponsor tacked on is refused')

say(`done · sponsor left with ${sol(await connection.getBalance(sponsor.publicKey))} SOL`)
