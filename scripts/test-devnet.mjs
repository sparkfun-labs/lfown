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

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
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
import { DynamicFeeSharingClient, deriveFeeVaultPdaAddress } from '@meteora-ag/dynamic-fee-sharing-sdk'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { deriveDbcPoolAddress, deriveDbcEventAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { FEES, feeBreakdown } from '../src/lib/config.mjs'
import { HOLDER_MAX_PCT, splitFor, vaultShares, needsVault, deriveVault, allocate } from '../src/lib/fee-split.mjs'
import { readyToGraduate, graduate } from '../src/lib/graduate.mjs'

const KEY = readFileSync('.dev.vars', 'utf8').match(/api-key=([a-f0-9-]+)/)[1]
const connection = new Connection(`https://devnet.helius-rpc.com/?api-key=${KEY}`, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.keys/devnet.json', 'utf8'))))
const send = async (tx, signers = []) => {
  tx.feePayer = payer.publicKey
  // The SDK stamps a blockhash when it builds a transaction, which can be several
  // round trips before it is sent, and devnet forgets one quickly enough that runs
  // failed on "Blockhash not found" rather than on anything being wrong. Take a fresh
  // one here, where it is about to be used, and try again when it goes stale anyway.
  for (let attempt = 1; ; attempt++) {
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    tx.signatures = []
    try {
      return await sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: 'confirmed' })
    } catch (e) {
      if (/Blockhash not found|block height exceeded/i.test(e.message) && attempt < 4) continue
      // A failed simulation says why in its logs and nowhere else; without them the
      // error is "Simulation failed" and a stack trace through the web3 library.
      const logs = typeof e.getLogs === 'function' ? await e.getLogs(connection).catch(() => null) : e.transactionLogs
      if (logs?.length) console.error(`\n${logs.join('\n')}\n`)
      throw e
    }
  }
}

/**
 * How many bytes a transaction will weigh, without touching the transaction itself.
 *
 * A blockhash is 32 bytes whatever it says, so a placeholder measures the same as a
 * real one — and measuring on a copy leaves the transaction that actually gets sent
 * to be stamped at the moment it is sent.
 */
const sizeOf = (tx) => {
  const copy = new Transaction().add(...tx.instructions)
  copy.feePayer = payer.publicKey
  copy.recentBlockhash = PublicKey.default.toBase58()
  return copy.serialize({ requireAllSignatures: false, verifySignatures: false }).length
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
let sharedPool, sharedVault, sharedPot

await test('the fee split matches what the launch screen promises', () => {
  const cut = feeBreakdown(FEES.totalBps)
  assert.equal(cut.creator + cut.partner + cut.protocol, FEES.totalBps, 'the three shares must add up to the fee')
  assert.equal(cut.protocol, FEES.totalBps * 0.2, 'Meteora keeps a fifth before the split')
  assert.equal(cut.creator, cut.partner, 'creator and DAO split what remains evenly')
})

await test('the holder slider cuts only the creator\'s half', () => {
  const none = splitFor(0)
  assert.equal(none.holders, 0, 'keeping it all gives holders nothing')
  assert.equal(none.creator, 50, 'and leaves the creator the half the config gives them')

  const half = splitFor(HOLDER_MAX_PCT)
  assert.equal(half.creator, 0, 'at the top of the slider the creator keeps nothing')
  assert.equal(half.holders, 50, 'and holders take the half the creator gave up')

  for (const pct of [0, 1, 17, 50]) {
    const cut = splitFor(pct)
    assert.equal(cut.creator + cut.holders, 50, 'the DAO\'s half is never touched')
    assert.equal(cut.partner, 50)
  }
  assert.equal(splitFor(80).holders, 50, 'past the cap it stops at the cap')
  assert.equal(splitFor(-5).holders, 0, 'and below zero it stops at zero')
  assert.equal(splitFor('nonsense').holders, 0, 'anything unreadable means keep it all')
})

await test('the vault is derived the way the SDK derives it', () => {
  const base = Keypair.generate().publicKey
  const quote = Keypair.generate().publicKey
  assert.equal(deriveVault(base, quote).toBase58(), deriveFeeVaultPdaAddress(base, quote).toBase58())
})

await test('a vault never spends a slot on a shareholder owed nothing', () => {
  const creator = Keypair.generate().publicKey
  const holders = Keypair.generate().publicKey

  assert.deepEqual(vaultShares(0, { creator, holders }).map((s) => s.share), [50],
    'keeping it all leaves the creator alone in the vault')
  assert.deepEqual(vaultShares(HOLDER_MAX_PCT, { creator, holders }).map((s) => s.share), [50],
    'giving it all leaves the holder pot alone in it')
  assert.equal(vaultShares(HOLDER_MAX_PCT, { creator, holders })[0].address.toBase58(), holders.toBase58())

  const both = vaultShares(20, { creator, holders })
  assert.deepEqual(both.map((s) => s.share), [30, 20], 'and the shares read like the slider')
  assert.equal(needsVault(0), false, 'no vault at all when nothing is shared')
  assert.equal(needsVault(1), true)
})

await test('a pot is split pro rata, without the curve and without dust', () => {
  const pool = 'PooL11111111111111111111111111111111111111'
  const snapshot = [
    { address: pool, amount: 800n },   // the curve holds most of the supply
    { address: 'AAA', amount: 150n },
    { address: 'BBB', amount: 49n },
    { address: 'CCC', amount: 1n },
    { address: 'DDD', amount: 0n },
  ]
  const { payouts, paid, carried } = allocate(snapshot, 1_000_000n, { exclude: [pool], dust: 10_000n })
  const by = Object.fromEntries(payouts.map((p) => [p.address, p.amount]))

  assert.equal(by.DDD, undefined, 'an empty account is not a holder')
  assert.equal(by[pool], undefined, 'the curve is not paid to hold its own supply')
  assert.equal(by.CCC, undefined, 'a share too small to be worth an account waits')
  assert.equal(by.AAA + by.BBB, paid, 'what is paid is what the payouts add up to')
  assert.equal(paid + carried, 1_000_000n, 'and nothing is invented or lost')
  assert.equal(by.AAA, 750_000n, '150 of 200 eligible')
  assert.equal(by.BBB, 245_000n, '49 of 200, plus CCC\'s share left behind')

  const exact = allocate([{ address: 'AAA', amount: 3n }, { address: 'BBB', amount: 3n },
    { address: 'CCC', amount: 3n }], 10n)
  assert.equal(exact.payouts.reduce((t, p) => t + p.amount, 0n), 10n,
    'a remainder that does not divide is still handed out')
  assert.equal(exact.carried, 0n)

  assert.deepEqual(allocate([], 5n), { payouts: [], paid: 0n, carried: 5n },
    'a coin nobody holds keeps its pot for later')
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

await chainTest('a launch that shares fees with holders fits two signable transactions', async () => {
  const HOLDERS = 20
  const mint = Keypair.generate()
  const holderPot = Keypair.generate()
  const vault = deriveVault(mint.publicKey, quoteMint)
  const dfsPool = deriveDbcPoolAddress(quoteMint, mint.publicKey, config.publicKey)

  const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
  const launch = await client.creator.createPoolWithFirstBuy({
    createPoolParam: {
      baseMint: mint.publicKey, config: config.publicKey,
      // The longest name and symbol the launch screen accepts, and a uri the length
      // every real one has: what is measured below is the worst case, not a lucky
      // one. All three instructions in a single transaction came to 1287 bytes.
      name: 'A'.repeat(32), symbol: 'B'.repeat(10),
      uri: 'https://letsfuckingown.fun/i/00000000-0000-0000-0000-000000000000.json',
      payer: payer.publicKey, poolCreator: payer.publicKey,
    },
    firstBuyParam: {
      buyer: payer.publicKey, receiver: payer.publicKey,
      buyAmount: new BN(200 * 1e6), minimumAmountOut: new BN(0), referralTokenAccount: null,
    },
  })
  const openVault = await dfs.createFeeVaultPda({
    base: mint.publicKey, tokenMint: quoteMint, tokenProgram: TOKEN_PROGRAM_ID,
    owner: payer.publicKey, payer: payer.publicKey,
    userShare: vaultShares(HOLDERS, { creator: payer.publicKey, holders: holderPot.publicKey }),
  })
  // Built by hand rather than through `client.creator.transferPoolCreator`, which
  // reads the pool from chain to find its config — and the pool does not exist until
  // the first transaction has landed. Same trap as the dev buy.
  const program = client.state.program ?? client.program
  const handOver = await program.methods
    .transferPoolCreator()
    .accountsPartial({
      virtualPool: dfsPool,
      config: config.publicKey,
      creator: payer.publicKey,
      newCreator: vault,
      eventAuthority: deriveDbcEventAuthority(),
      program: program.programId,
    })
    .instruction()

  // Two transactions, and the vault goes first. Not because of size — the launch and
  // the hand-over fit together comfortably — but because of what is left behind when
  // the second one fails: an empty vault nobody will ever look at, rather than a coin
  // promising its holders a share it has no way to pay. A wallet signs both in one
  // approval, so the creator still clicks once.
  //
  // The hand-over rides in the same transaction as the launch, after it. The pool
  // does not exist when the instruction is built, which is why it is built by hand,
  // but it does exist by the time it runs.
  //
  // The 1232-byte cap that forces this is being raised to 4096 on mainnet at epoch
  // 1035 (15 Sep 2026), by SIMD-0296 and the v1 transaction format of SIMD-0385.
  // It does not help here yet: building v1 needs @solana/web3.js 3.x or @solana/kit
  // 8, this repo is on 1.98.4, the Meteora SDKs hand back legacy transactions, and a
  // wallet has to advertise v1 in `supportedTransactionVersions` before one can be
  // sent to it. When all three catch up, these two collapse back into one.
  const first = new Transaction().add(...openVault.instructions)
  const second = new Transaction().add(...launch.instructions, handOver)
  const sizes = [first, second].map(sizeOf)
  process.stdout.write(`(${sizes.join(' + ')} bytes) `)
  for (const size of sizes) assert(size <= 1232, `each transaction must fit, measured ${size} bytes`)

  await send(first, [mint])
  await send(second, [mint])

  const { poolState } = await client.state.getPool(dfsPool)
  assert.equal(poolState.creator.toBase58(), vault.toBase58(), 'the vault must now be the pool creator')

  sharedPool = dfsPool
  sharedVault = vault
  sharedPot = holderPot
})

await chainTest('the vault splits the creator fees the way the slider said', async () => {
  // Trade so there is something to share, then pull the creator's side into the vault.
  await send(await client.pool.swap({
    owner: payer.publicKey, pool: sharedPool,
    amountIn: new BN(300 * 1e6), minimumAmountOut: new BN(0),
    swapBaseForQuote: false, referralTokenAccount: null,
  }))

  const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
  await send(await dfs.fundByClaimDbcCreatorTradingFee({
    signer: payer.publicKey, creator: payer.publicKey, feeVault: sharedVault,
    poolConfig: config.publicKey, virtualPool: sharedPool,
  }))

  const breakdown = await dfs.getFeeBreakdown(sharedVault)
  const funded = BigInt(breakdown.totalFundedFee.toString())
  assert(funded > 0n, 'the creator fees should have landed in the vault')

  const share = Object.fromEntries(breakdown.userFees.map((u) => [u.address.toBase58(), BigInt(u.totalFee.toString())]))
  const toHolders = share[sharedPot.publicKey.toBase58()]
  const toCreator = share[payer.publicKey.toBase58()]

  // The program divides by the total share and floors, so a unit or two of what was
  // funded belongs to nobody and stays in the vault. Worth knowing rather than worth
  // fixing: it is dust, it is bounded by the number of shareholders, and nothing here
  // may assume the two shares add up to the whole pot.
  const unattributed = funded - (toHolders + toCreator)
  assert(unattributed >= 0n && unattributed < BigInt(breakdown.userFees.length),
    `rounding must not lose more than dust, lost ${unattributed} of ${funded}`)

  // 20 of the creator's 50 points, so two fifths of what the vault received.
  const expected = (funded * 20n) / 50n
  assert(toHolders <= expected && expected - toHolders <= 1n,
    `holders must get what the slider promised, got ${toHolders} against ${expected}`)
})

await chainTest('each side claims its own share and cannot touch the other', async () => {
  const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
  const before = await dfs.getFeeBreakdown(sharedVault)
  const owed = BigInt(before.userFees.find((u) => u.address.equals(payer.publicKey)).feeUnclaimed.toString())
  assert(owed > 0n, 'the creator should be owed something')

  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, quoteMint, payer.publicKey)
  const held = (await getAccount(connection, ata.address)).amount
  await send(await dfs.claimUserFee({ feeVault: sharedVault, user: payer.publicKey, payer: payer.publicKey }))
  assert.equal((await getAccount(connection, ata.address)).amount - held, owed,
    'a claim must pay exactly what was owed')

  const after = await dfs.getFeeBreakdown(sharedVault)
  const holders = after.userFees.find((u) => u.address.equals(sharedPot.publicKey))
  assert.equal(BigInt(holders.feeClaimed.toString()), 0n,
    "claiming the creator's share must leave the holders' share untouched")
  assert(BigInt(holders.feeUnclaimed.toString()) > 0n, 'which is still there waiting to be handed out')
})

console.log(`\n${passed} passed${onChain ? '' : ', on-chain suite skipped'}`)
if (onChain) {
  console.log('config   :', config.publicKey.toBase58())
  console.log('base mint:', baseMint.publicKey.toBase58())
}
