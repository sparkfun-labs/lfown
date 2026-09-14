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
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { resolveVaultCreators } from '../src/lib/launches.mjs'
import { deriveDbcPoolAddress, deriveDbcEventAuthority, deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, derivePositionNftAccount } from '@meteora-ag/cp-amm-sdk'
import { lpPositions } from '../src/lib/lp-fees.mjs'
import { feeReport } from '../src/lib/fee-report.mjs'
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
let sharedPool, sharedVault, sharedPot, sharedDamm

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

await test('a pot is split pro rata, without the curve, and nothing is left behind', () => {
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
  assert.equal(by.CCC, undefined, 'a share too small to be worth an account is dropped')
  // CCC's share is not held back. A vault is claimed all or nothing, so a share left
  // out of one run is already in the pot, and nothing reads the pot again: holding it
  // back used to strand it. It is re-split among the holders who are paid.
  assert.equal(carried, 0n, 'nothing is left behind in the pot')
  assert.equal(paid, 1_000_000n, 'the whole pot is handed out')
  assert.equal(by.AAA + by.BBB, 1_000_000n)
  assert.equal(by.AAA, 753_769n, '150 of the 199 kept, plus the rounding remainder')
  assert.equal(by.BBB, 246_231n, '49 of the 199 kept')

  // Dropping the smallest raises the others, so the cut has to be made from the top.
  // Here nobody clears the floor on the full list, yet the largest does on their own.
  const lifted = allocate([{ address: 'A', amount: 40n }, { address: 'B', amount: 30n },
    { address: 'C', amount: 30n }], 1_000_000n, { dust: 500_000n })
  assert.deepEqual(lifted.payouts, [{ address: 'A', amount: 1_000_000n }],
    'dropping everyone under the floor at once would have paid nobody')
  assert.equal(lifted.carried, 0n)

  const exact = allocate([{ address: 'AAA', amount: 3n }, { address: 'BBB', amount: 3n },
    { address: 'CCC', amount: 3n }], 10n)
  assert.equal(exact.payouts.reduce((t, p) => t + p.amount, 0n), 10n,
    'a remainder that does not divide is still handed out')
  assert.equal(exact.carried, 0n)

  assert.deepEqual(allocate([], 5n), { payouts: [], paid: 0n, carried: 5n },
    'a coin nobody holds pays nobody — and the caller must not claim it')
  assert.deepEqual(allocate([{ address: 'A', amount: 1n }], 100n, { dust: 500n }).payouts, [],
    'nor a pot too small for even one person')
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

await chainTest('the registry credits the person who launched it, not the vault', async () => {
  const [shared] = await resolveVaultCreators(connection, PublicKey, [{ creator: sharedVault.toBase58() }])
  assert.equal(shared.creator, payer.publicKey.toBase58(),
    'the leaderboard, the profile page and the claim button all go by this field')
  assert.equal(shared.vault, sharedVault.toBase58(), 'and the vault is kept, to claim through')

  const [plain] = await resolveVaultCreators(connection, PublicKey, [{ creator: payer.publicKey.toBase58() }])
  assert.equal(plain.creator, payer.publicKey.toBase58(), 'a wallet is left exactly as it was')
  assert.equal(plain.vault, undefined)
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

await chainTest('a creator claims through the vault in one transaction', async () => {
  await send(await client.pool.swap({
    owner: payer.publicKey, pool: sharedPool,
    amountIn: new BN(150 * 1e6), minimumAmountOut: new BN(0),
    swapBaseForQuote: false, referralTokenAccount: null,
  }))
  const { poolState } = await client.state.getPool(sharedPool)
  assert(BigInt(poolState.creatorQuoteFee.toString()) > 0n, 'trading should have left fees in the pool')

  // What trade.js builds: pull the pool's creator fees into the vault, take this share.
  const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
  const pull = await dfs.fundByClaimDbcCreatorTradingFee({
    signer: payer.publicKey, creator: payer.publicKey, feeVault: sharedVault,
    poolConfig: config.publicKey, virtualPool: sharedPool,
  })
  const take = await dfs.claimUserFee({ feeVault: sharedVault, user: payer.publicKey, payer: payer.publicKey })
  const tx = new Transaction().add(...pull.instructions, ...take.instructions)
  const size = sizeOf(tx)
  process.stdout.write(`(${size} bytes) `)
  assert(size <= 1232, `the creator's claim must fit one transaction, measured ${size} bytes`)

  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, quoteMint, payer.publicKey)
  const held = (await getAccount(connection, ata.address)).amount
  await send(tx)
  assert((await getAccount(connection, ata.address)).amount > held, 'the creator must receive their share')

  const after = await dfs.getFeeBreakdown(sharedVault)
  const mine = after.userFees.find((u) => u.address.equals(payer.publicKey))
  // Within a unit: the program floors per share, the same dust it leaves in the vault.
  assert(BigInt(mine.feeUnclaimed.toString()) <= 1n, 'nothing of the creator\'s is left behind')
  const theirs = after.userFees.find((u) => u.address.equals(sharedPot.publicKey))
  assert(BigInt(theirs.feeUnclaimed.toString()) > 0n, "and the holders' part is waiting in the vault for them")
})

await chainTest('the pot pulls fees in without the creator, and spends no SOL doing it', async () => {
  await send(await client.pool.swap({
    owner: payer.publicKey, pool: sharedPool,
    amountIn: new BN(150 * 1e6), minimumAmountOut: new BN(0),
    swapBaseForQuote: false, referralTokenAccount: null,
  }))
  assert.equal(await connection.getBalance(sharedPot.publicKey), 0, 'the pot starts with no SOL')

  // What the hourly payout builds. The base-token account the pull insists on belongs
  // to someone who has never held this coin, so the SDK sees it missing and adds its
  // own create with the pot as payer — the path that would fail on an empty pot. The
  // collector's create goes first, and the SDK's then has nothing left to pay for.
  const stranger = Keypair.generate().publicKey
  const { poolState } = await client.state.getPool(sharedPool)
  const receiver = getAssociatedTokenAddressSync(poolState.baseMint, stranger)
  const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
  const pull = await dfs.fundByClaimDbcCreatorTradingFee({
    signer: sharedPot.publicKey, creator: stranger, feeVault: sharedVault,
    poolConfig: config.publicKey, virtualPool: sharedPool,
  })
  await send(new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, receiver, stranger, poolState.baseMint))
    .add(...pull.instructions), [sharedPot])

  const potAta = getAssociatedTokenAddressSync(quoteMint, sharedPot.publicKey)
  await send(await dfs.claimUserFee({ feeVault: sharedVault, user: sharedPot.publicKey, payer: payer.publicKey }), [sharedPot])

  assert((await getAccount(connection, potAta)).amount > 0n, "the holders' share must reach the pot")
  assert.equal(await connection.getBalance(sharedPot.publicKey), 0,
    'and the pot must still hold no SOL — every fee and every account was paid by someone else')
})

await chainTest('a shared coin graduates, and its creator position belongs to the vault', async () => {
  // PartialFill takes what is left of the curve and refunds the rest.
  await send(await client.pool.swap2({
    owner: payer.publicKey, payer: payer.publicKey, pool: sharedPool,
    amountIn: new BN(5_000 * 1e6), minimumAmountOut: new BN(0),
    swapMode: SwapMode.PartialFill, swapBaseForQuote: false, referralTokenAccount: null,
  }))
  await graduate(client, connection, sharedPool.toBase58(), payer)
  const { poolState } = await client.state.getPool(sharedPool)
  assert.equal(poolState.isMigrated, 1, 'the shared pool should have migrated')

  sharedDamm = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100], poolState.baseMint, quoteMint)
  const damm = await new CpAmm(connection).fetchPoolState(sharedDamm)
  // What the whole design leans on. The program pays a position's fees into the vault
  // only from token B, and a vault holds one mint — the quote.
  assert.equal(damm.tokenAMint.toBase58(), poolState.baseMint.toBase58(), 'the base is token A')
  assert.equal(damm.tokenBMint.toBase58(), quoteMint.toBase58(), 'the quote is token B, the side paid into the vault')
  assert.equal(damm.collectFeeMode, 1, 'and fees are collected in token B only')

  const held = (await lpPositions(connection, sharedVault.toBase58())).filter((p) => p.pool === sharedDamm.toBase58())
  assert.equal(held.length, 1, "the creator's locked position must have been minted to the vault, the pool's creator when it migrated")
})

/** A quote-for-coin buy on the graduated pool, which is what earns a position its fees. */
const tradeGraduated = async () => {
  const cp = new CpAmm(connection)
  const damm = await cp.fetchPoolState(sharedDamm)
  await send(await cp.swap({
    payer: payer.publicKey, pool: sharedDamm,
    inputTokenMint: quoteMint, outputTokenMint: damm.tokenAMint,
    amountIn: new BN(400 * 1e6), minimumAmountOut: new BN(0),
    tokenAMint: damm.tokenAMint, tokenBMint: damm.tokenBMint,
    tokenAVault: damm.tokenAVault, tokenBVault: damm.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
  }))
  const [position] = (await lpPositions(connection, sharedVault.toBase58())).filter((p) => p.pool === sharedDamm.toBase58())
  return { damm, position }
}

await chainTest('after graduation a creator claims through the vault in one transaction', async () => {
  const { position } = await tradeGraduated()
  assert(position.feeB > 0, 'trading after graduation should have earned the position quote-side fees')
  assert.equal(position.feeA, 0, 'and nothing in the coin itself')

  // What trade.js builds: pull the position's fees into the vault, take this share.
  const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
  const pull = await dfs.fundByClaimDammV2Fee({
    signer: payer.publicKey, owner: payer.publicKey, feeVault: sharedVault,
    dammV2Pool: sharedDamm, dammV2Position: new PublicKey(position.position),
    dammV2PositionNftAccount: derivePositionNftAccount(new PublicKey(position.nftMint)),
  })
  const take = await dfs.claimUserFee({ feeVault: sharedVault, user: payer.publicKey, payer: payer.publicKey })
  const tx = new Transaction().add(...pull.instructions, ...take.instructions)
  const size = sizeOf(tx)
  process.stdout.write(`(${size} bytes) `)
  assert(size <= 1232, `the creator's graduated claim must fit one transaction, measured ${size} bytes`)

  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, quoteMint, payer.publicKey)
  const before = (await getAccount(connection, ata.address)).amount
  await send(tx)
  assert((await getAccount(connection, ata.address)).amount > before, 'the creator must receive their share')

  const theirs = (await dfs.getFeeBreakdown(sharedVault)).userFees.find((u) => u.address.equals(sharedPot.publicKey))
  assert(BigInt(theirs.feeUnclaimed.toString()) > 0n, "and the holders' part waits in the vault")
})

await chainTest('after graduation the pot pulls from the position too, and still spends no SOL', async () => {
  const { damm, position } = await tradeGraduated()
  assert.equal(await connection.getBalance(sharedPot.publicKey), 0, 'the pot starts with no SOL')

  // What the hourly payout builds. Token A's account belongs to someone who has never
  // held the coin, so the SDK would rent it with the pot's SOL; the collector's create
  // goes first and leaves the SDK's with nothing to pay for.
  const stranger = Keypair.generate().publicKey
  const receiver = getAssociatedTokenAddressSync(damm.tokenAMint, stranger)
  const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
  const pull = await dfs.fundByClaimDammV2Fee({
    signer: sharedPot.publicKey, owner: stranger, feeVault: sharedVault,
    dammV2Pool: sharedDamm, dammV2Position: new PublicKey(position.position),
    dammV2PositionNftAccount: derivePositionNftAccount(new PublicKey(position.nftMint)),
  })
  await send(new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, receiver, stranger, damm.tokenAMint))
    .add(...pull.instructions), [sharedPot])

  const potAta = getAssociatedTokenAddressSync(quoteMint, sharedPot.publicKey)
  const before = (await getAccount(connection, potAta)).amount
  await send(await dfs.claimUserFee({ feeVault: sharedVault, user: sharedPot.publicKey, payer: payer.publicKey }), [sharedPot])
  assert((await getAccount(connection, potAta)).amount > before, "the holders' share of graduated fees must reach the pot")
  assert.equal(await connection.getBalance(sharedPot.publicKey), 0, 'and the pot still holds no SOL')
})

await chainTest('the fee report splits a shared coin between its creator and its holders', async () => {
  const shared = await client.state.getPool(sharedPool)
  const plain = await client.state.getPool(pool)
  const prices = new Map([[quoteMint.toBase58(), 1]])
  const { coins, totals } = await feeReport(client, connection, [
    { pool: sharedPool.toBase58(), baseMint: shared.poolState.baseMint.toBase58(), quoteMint: quoteMint.toBase58(),
      creator: payer.publicKey.toBase58(), vault: sharedVault.toBase58(), symbol: 'SHRD' },
    { pool: pool.toBase58(), baseMint: plain.poolState.baseMint.toBase58(), quoteMint: quoteMint.toBase58(),
      creator: payer.publicKey.toBase58(), symbol: 'TEST' },
  ], { prices })
  const bySymbol = Object.fromEntries(coins.map((c) => [c.symbol, c]))
  const close = (a, b) => Math.abs(a - b) < 1e-6

  const s = bySymbol.SHRD
  assert(s.holders > 0, "a shared coin must report its holders' share")
  // 20 of the creator's 50 points went to holders, on the curve and after graduation alike.
  assert(close(s.holders, ((s.creator + s.holders) * 20) / 50),
    `holders must get two fifths of the creator's half, got ${s.holders} of ${s.creator + s.holders}`)
  assert(close(s.creator + s.holders + s.lfown, s.total),
    'creator, holders and the DAO must add up to what the coin generated — every page sums them to show it')
  assert(close(s.creator + s.holders, s.lfown), "and the creator's half, split or not, still equals the DAO's")

  const t = bySymbol.TEST
  assert.equal(t.holders, 0, 'a coin that does not share gives holders nothing')
  assert(close(t.creator, t.lfown), 'and its creator keeps the whole half')
  assert(close(totals.holdersUsd, s.holdersUsd), 'the totals carry the holders too')
})

console.log(`\n${passed} passed${onChain ? '' : ', on-chain suite skipped'}`)
if (onChain) {
  console.log('config   :', config.publicKey.toBase58())
  console.log('base mint:', baseMint.publicKey.toBase58())
}
