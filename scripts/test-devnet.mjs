// LFOwn — end-to-end test on devnet.
//
// Runs the whole mechanism against a stand-in quote mint: a plain 6-decimal SPL
// token, mechanically identical to a MetaDAO ownership coin. Every ownership coin
// was checked on chain and they are all classic SPL with 6 decimals and no
// extensions, so devnet is a fair rehearsal.
//
//   npm test
//
// It asserts rather than prints: a step that silently does the wrong thing is the
// failure mode that matters here, not a crash.

import { Connection, Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js'
import { createMint, mintTo, getOrCreateAssociatedTokenAccount, getAccount } from '@solana/spl-token'
import {
  DynamicBondingCurveClient, buildCurve, SwapMode,
  TokenType, TokenDecimal, ActivationType, CollectFeeMode,
  MigrationOption, MigrationFeeOption, BaseFeeMode, TokenAuthorityOption,
  DEFAULT_MIGRATED_POOL_FEE_PARAMS,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FEES, feeBreakdown } from '../src/lib/config.mjs'
import { readyToGraduate, graduate } from '../src/lib/graduate.mjs'

const KEY = readFileSync('.dev.vars', 'utf8').match(/api-key=([a-f0-9-]+)/)[1]
const connection = new Connection(`https://devnet.helius-rpc.com/?api-key=${KEY}`, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.keys/devnet.json', 'utf8'))))
const send = (tx, signers = []) => {
  tx.feePayer = payer.publicKey
  return sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: 'confirmed' })
}

let passed = 0
const test = async (name, fn) => {
  process.stdout.write(`  ${name} … `)
  await fn()
  passed++
  console.log('ok')
}

console.log('LFOwn tests\n')

// The arithmetic tests need nothing; the rest needs a funded devnet wallet. Running
// half the suite beats refusing to run any of it because a faucet is busy.
const balance = await connection.getBalance(payer.publicKey).catch(() => 0)
const onChain = balance > 0.2 * LAMPORTS_PER_SOL
if (!onChain) {
  console.log(`  (on-chain tests skipped — fund ${payer.publicKey.toBase58()} on devnet)\n`)
}
const chainTest = (name, fn) => (onChain ? test(name, fn) : Promise.resolve())

const RAISE = 1_000
let quoteMint, config, baseMint, pool

await test('the fee split matches what the launch screen promises', () => {
  const cut = feeBreakdown(FEES.totalBps)
  assert.equal(cut.creator + cut.partner + cut.protocol, FEES.totalBps, 'the three shares must add up to the fee')
  assert.equal(cut.protocol, FEES.totalBps * 0.2, 'Meteora keeps a fifth before the split')
  assert.equal(cut.creator, cut.partner, 'creator and DAO split what remains evenly')
})

await chainTest('a config opens against a non-SOL quote mint', async () => {
  quoteMint = await createMint(connection, payer, payer.publicKey, null, 6)
  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, quoteMint, payer.publicKey)
  await mintTo(connection, payer, quoteMint, ata.address, payer, 10_000n * 1_000_000n)

  const curve = buildCurve({
    token: {
      tokenType: TokenType.SPL,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.SIX,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: FEES.totalBps, endingFeeBps: FEES.totalBps,
          numberOfPeriod: 0, totalDuration: 0,
        },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: FEES.creatorSharePct,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: DEFAULT_MIGRATED_POOL_FEE_PARAMS,
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
      totalVestingDuration: 0, cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Slot,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: RAISE,
  })

  config = Keypair.generate()
  await send(await client.partner.createConfig({
    config: config.publicKey,
    feeClaimer: payer.publicKey,
    leftoverReceiver: payer.publicKey,
    quoteMint,
    payer: payer.publicKey,
    ...curve,
  }), [config])

  const state = await client.state.getPoolConfig(config.publicKey)
  assert.equal(state.quoteMint.toBase58(), quoteMint.toBase58(), 'the quote mint must be ours, not SOL')
  assert.equal(state.creatorTradingFeePercentage, FEES.creatorSharePct)
})

await chainTest('a token launches on it', async () => {
  baseMint = Keypair.generate()
  await send(await client.creator.createPool({
    baseMint: baseMint.publicKey,
    config: config.publicKey,
    name: 'Test Coin', symbol: 'TEST', uri: 'https://example.invalid/t.json',
    payer: payer.publicKey, poolCreator: payer.publicKey,
  }), [baseMint])

  const wrapper = await client.state.getPoolByBaseMint(baseMint.publicKey)
  assert(wrapper, 'the pool should exist right after the launch')
  pool = wrapper.publicKey
})

await chainTest('a launch with a dev buy lands in one transaction', async () => {
  // The pool does not exist while this transaction is being built, so anything that
  // reads its on-chain state fails with "Pool not found". This is the path that
  // regressed once already.
  const devMint = Keypair.generate()
  const transaction = await client.creator.createPoolWithFirstBuy({
    createPoolParam: {
      baseMint: devMint.publicKey,
      config: config.publicKey,
      name: 'Dev Buy', symbol: 'DEVB', uri: 'https://example.invalid/d.json',
      payer: payer.publicKey, poolCreator: payer.publicKey,
    },
    firstBuyParam: {
      buyer: payer.publicKey, receiver: payer.publicKey,
      buyAmount: new BN(50 * 1e6), minimumAmountOut: new BN(0),
      referralTokenAccount: null,
    },
  })
  await send(transaction, [devMint])

  const wrapper = await client.state.getPoolByBaseMint(devMint.publicKey)
  assert(wrapper, 'the pool should exist after the launch')
  assert(
    Number(wrapper.account.poolState.quoteReserve.toString()) > 0,
    'the dev buy should have moved the curve in the same transaction',
  )
  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, devMint.publicKey, payer.publicKey)
  assert((await getAccount(connection, ata.address)).amount > 0n, 'the creator should hold their tokens')
})

await chainTest('buying moves the curve and sells back', async () => {
  await send(await client.pool.swap({
    owner: payer.publicKey, pool,
    amountIn: new BN(100 * 1e6), minimumAmountOut: new BN(0),
    swapBaseForQuote: false, referralTokenAccount: null,
  }))

  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, baseMint.publicKey, payer.publicKey)
  const bought = (await getAccount(connection, ata.address)).amount
  assert(bought > 0n, 'a buy must return base tokens')

  await send(await client.pool.swap({
    owner: payer.publicKey, pool,
    amountIn: new BN((bought / 2n).toString()), minimumAmountOut: new BN(0),
    swapBaseForQuote: true, referralTokenAccount: null,
  }))
  const left = (await getAccount(connection, ata.address)).amount
  assert(left < bought, 'a sell must reduce the balance')
})

await chainTest('trading leaves fees for both sides', async () => {
  const { poolState } = await client.state.getPool(pool)
  assert(Number(poolState.partnerQuoteFee.toString()) > 0, 'the DAO share should have accrued')
  assert(Number(poolState.creatorQuoteFee.toString()) > 0, 'the creator share should have accrued')
})

await chainTest('a partial fill completes the curve exactly', async () => {
  // An oversized ExactIn buy fails with InsufficientLiquidity: the curve holds only
  // enough base for the threshold. PartialFill takes what is left and refunds the rest.
  await send(await client.pool.swap2({
    owner: payer.publicKey, payer: payer.publicKey, pool,
    amountIn: new BN(5_000 * 1e6), minimumAmountOut: new BN(0),
    swapMode: SwapMode.PartialFill, swapBaseForQuote: false, referralTokenAccount: null,
  }))

  const { poolState } = await client.state.getPool(pool)
  const threshold = await client.state.getPoolMigrationQuoteThreshold(pool)
  assert(poolState.quoteReserve.gte(threshold), 'the curve should be at or past its threshold')
})

await chainTest('the keeper sees it as ready', async () => {
  const ready = await readyToGraduate(client, [{ pool: pool.toBase58(), isMigrated: false }])
  assert.equal(ready.length, 1, 'a full curve must be reported as ready to graduate')
})

await chainTest('graduation migrates it into DAMM v2', async () => {
  await graduate(client, connection, pool.toBase58(), payer)
  const { poolState } = await client.state.getPool(pool)
  assert.equal(poolState.isMigrated, 1, 'the pool should be flagged as migrated')
})

await chainTest('the keeper stops offering it once migrated', async () => {
  const ready = await readyToGraduate(client, [{ pool: pool.toBase58(), isMigrated: false }])
  assert.equal(ready.length, 0, 'a migrated pool must not be cranked twice')
})

console.log(`\n${passed} passed${onChain ? '' : ', on-chain suite skipped'}`)
if (onChain) {
  console.log('config   :', config.publicKey.toBase58())
  console.log('base mint:', baseMint.publicKey.toBase58())
}
