// LFOWN — end-to-end test, on devnet, of a coin that charges a transfer fee.
//
// Since DBC 0.2.2 a config can mint every coin it launches as Token-2022 with a transfer
// fee. LFOWN's are 2%, fixed for good, withheld for the partner (LFOWN's fee claimer) to
// collect and hand to holders. This runs that whole life against a stand-in quote mint:
// config, launch, buys and sells, the fee withheld on each, the fee collected, the curve
// filled and graduated, and the fee still in force on the DAMM v2 pool.
//
//   node scripts/test-transfer-fee-devnet.mjs
//
// spl-token reports "no authority" as the default pubkey, not null.
// It asserts rather than prints: a step that silently does the wrong thing is the failure
// that matters here. Devnet SOL only.

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import {
  createMint, mintTo, getOrCreateAssociatedTokenAccount, getAccount, getMint, getAssociatedTokenAddressSync,
  getTransferFeeConfig, getTransferFeeAmount, createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction, createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import {
  DynamicBondingCurveClient, buildCurve, SwapMode, TokenType, TokenDecimal, ActivationType, CollectFeeMode,
  MigrationOption, MigrationFeeOption, MigratedCollectFeeMode, BaseFeeMode, TokenAuthorityOption,
  getSwapQuoteTransferFees, deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildLaunchTransactions } from '../src/lib/launch-builder.mjs'
import { readyToGraduate, graduate } from '../src/lib/graduate.mjs'
import { FEES } from '../src/lib/config.mjs'
import { tokenAccounts, withheldOf, collectTransactions } from '../src/lib/transfer-fees.mjs'
import { payoutInstructions } from '../src/lib/holder-payouts.mjs'
import { deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { SystemProgram } from '@solana/web3.js'

const KEY = readFileSync('.dev.vars', 'utf8').match(/api-key=([a-f0-9-]+)/)[1]
const RPC = `https://devnet.helius-rpc.com/?api-key=${KEY}`
const connection = new Connection(RPC, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.keys/devnet.json', 'utf8'))))

const TRANSFER_FEE_BPS = 200
const THRESHOLD = 30 // stand-in quote tokens to fill the curve
const unit = 10 ** 6

const send = async (tx, signers = []) => {
  tx.feePayer = payer.publicKey
  for (let attempt = 1; ; attempt++) {
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    tx.signatures = []
    try {
      return await sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: 'confirmed' })
    } catch (e) {
      if (/Blockhash not found|block height exceeded/i.test(e.message) && attempt < 4) continue
      const logs = typeof e.getLogs === 'function' ? await e.getLogs(connection).catch(() => null) : e.transactionLogs
      if (logs?.length) console.error(`\n${logs.join('\n')}\n`)
      throw e
    }
  }
}
let step = 0
const ok = (what) => console.log(`  ok ${String(++step).padStart(2)}  ${what}`)

/** Raw base units held and withheld in `owner`'s Token-2022 account of `mint`. */
async function held(mint, owner) {
  const account = await getAccount(connection, getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID), 'confirmed', TOKEN_2022_PROGRAM_ID)
  return { amount: account.amount, withheld: getTransferFeeAmount(account)?.withheldAmount ?? 0n, address: account.address }
}

console.log(`payer ${payer.publicKey.toBase58()} — ${(await connection.getBalance(payer.publicKey)) / 1e9} SOL on devnet\n`)

// ── a stand-in quote coin: 6-decimal SPL, as an ownership coin is ─────────────
const quoteMint = await createMint(connection, payer, payer.publicKey, null, 6)
const payerQuote = await getOrCreateAssociatedTokenAccount(connection, payer, quoteMint, payer.publicKey)
await mintTo(connection, payer, quoteMint, payerQuote.address, payer, 1_000 * unit)
ok(`stand-in quote mint ${quoteMint.toBase58()}, 1,000 minted`)

// ── the config: the production curve, plus the transfer fee and what it requires ──
const curve = buildCurve({
  token: { tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 6, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
  fee: {
    baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: FEES.totalBps, endingFeeBps: FEES.totalBps, numberOfPeriod: 0, totalDuration: 0 } },
    dynamicFeeEnabled: true, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: FEES.creatorSharePct, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.Customizable,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.Compounding, compoundingFeeBps: 0, dynamicFee: 1, poolFeeBps: 100 },
  },
  liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 50, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50, creatorLiquidityPercentage: 0 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Slot, percentageSupplyOnMigration: 20, migrationQuoteThreshold: THRESHOLD,
})
const configKey = Keypair.generate()
await send(await client.partner.createConfig2({
  config: configKey.publicKey, feeClaimer: payer.publicKey, leftoverReceiver: payer.publicKey, quoteMint, payer: payer.publicKey, ...curve,
  transferFeeParameters: { transferFeeBasisPoints: TRANSFER_FEE_BPS, withheldAuthority: 0, migratedTransferFeeAuthorityOption: 0 },
}), [configKey])
const config = await client.state.getPoolConfig(configKey.publicKey)
assert.equal(Number(config.transferFeeFlag), 1, 'the config records a base transfer fee')
assert.equal(Number(config.tokenType), 1, 'the config mints Token-2022 coins')
ok(`config ${configKey.publicKey.toBase58()}: Token-2022 coins, transferFeeFlag 1, version ${config.version}`)

// ── a launch, through the same builder the site uses ──────────────────────────
const mint = Keypair.generate()
const built = await buildLaunchTransactions({
  client, connection, config: configKey.publicKey, creator: payer.publicKey.toBase58(), mint, quoteMint: quoteMint.toBase58(),
  token: { name: 'Fee Test', symbol: 'FEET', uri: 'https://letsfuckingown.fun/x.json' }, holderPct: 0,
})
for (const tx of built.transactions ?? [built.transaction]) await send(tx, [mint])
const coin = await getMint(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID)
const fee = getTransferFeeConfig(coin)
assert.ok(fee, 'the coin carries a TransferFeeConfig')
assert.equal(Number(fee.newerTransferFee.transferFeeBasisPoints), TRANSFER_FEE_BPS, 'at 2%')
assert.ok(!fee.transferFeeConfigAuthority || fee.transferFeeConfigAuthority.equals(PublicKey.default), 'nobody can change it')
assert.equal(fee.withdrawWithheldAuthority?.toBase58(), payer.publicKey.toBase58(), 'the partner (fee claimer) collects what it withholds')
ok(`coin ${mint.publicKey.toBase58()}: Token-2022, ${TRANSFER_FEE_BPS / 100}% transfer fee, no fee authority, withheld for the fee claimer`)

// ── a buy: what lands is the curve's output less 2% withheld in the buyer's account ──
const { poolState } = await client.state.getPoolByBaseMint(mint.publicKey).then((p) => ({ poolState: p.account.poolState, address: p.publicKey }))
const poolAddress = (await client.state.getPoolByBaseMint(mint.publicKey)).publicKey
const quoteOf = async (amountIn, sellingBase) => {
  const { poolState: pool } = await client.state.getPool(poolAddress)
  return client.pool.swapQuote2({
    virtualPool: { poolState: pool }, config, swapBaseForQuote: sellingBase, swapMode: SwapMode.ExactIn, amountIn: new BN(amountIn),
    slippageBps: 100, hasReferral: false, currentPoint: new BN(await connection.getSlot()),
    ...(await getSwapQuoteTransferFees(connection, config, { baseMint: mint.publicKey })),
  })
}
const swap = async (amountIn, sellingBase, minimumOut) => send(await client.pool.swap2({
  owner: payer.publicKey, payer: payer.publicKey, pool: poolAddress, amountIn: new BN(amountIn), minimumAmountOut: new BN(minimumOut),
  swapMode: SwapMode.ExactIn, swapBaseForQuote: sellingBase, referralTokenAccount: null,
}))
const buyQuote = await quoteOf(5 * unit, false)
await swap(5 * unit, false, buyQuote.minimumAmountOut.toString())
const afterBuy = await held(mint.publicKey, payer.publicKey)
const gross = afterBuy.amount + afterBuy.withheld
assert.ok(afterBuy.withheld > 0n, 'a fee is withheld on the buy')
const rate = Number(afterBuy.withheld) / Number(gross)
assert.ok(Math.abs(rate - TRANSFER_FEE_BPS / 10_000) < 0.0001, `the withheld share is 2% (got ${(rate * 100).toFixed(4)}%)`)
assert.ok(afterBuy.amount >= BigInt(buyQuote.minimumAmountOut.toString()), 'the buyer gets at least the quote\'s minimum, fee already taken')
ok(`buy 5 → ${Number(afterBuy.amount) / unit} coins kept, ${Number(afterBuy.withheld) / unit} withheld (${(rate * 100).toFixed(2)}%); quote said ≥ ${Number(buyQuote.minimumAmountOut) / unit}`)

// ── a sell: the pool's vault is charged the same way ──────────────────────────
const sellAmount = afterBuy.amount / 2n
const sellQuote = await quoteOf(sellAmount.toString(), true)
const quoteBefore = (await getAccount(connection, payerQuote.address)).amount
await swap(sellAmount.toString(), true, sellQuote.minimumAmountOut.toString())
const quoteGot = (await getAccount(connection, payerQuote.address)).amount - quoteBefore
assert.ok(quoteGot >= BigInt(sellQuote.minimumAmountOut.toString()), 'the seller gets at least the quote\'s minimum')
const vault = poolState.baseVault
const vaultAccount = await getAccount(connection, vault, 'confirmed', TOKEN_2022_PROGRAM_ID)
const vaultWithheld = getTransferFeeAmount(vaultAccount)?.withheldAmount ?? 0n
assert.ok(vaultWithheld > 0n, 'the sell left a fee withheld in the pool\'s vault')
ok(`sell ${Number(sellAmount) / unit} → ${Number(quoteGot) / unit} quote; ${Number(vaultWithheld) / unit} withheld in the pool's vault`)

// ── collecting: harvest every account's withheld fee into the mint, then withdraw it ──
const payerCoin = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, true, TOKEN_2022_PROGRAM_ID)
await send(new Transaction().add(createHarvestWithheldTokensToMintInstruction(mint.publicKey, [payerCoin, vault], TOKEN_2022_PROGRAM_ID)))
const harvested = getTransferFeeConfig(await getMint(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID)).withheldAmount
assert.ok(harvested > 0n, 'the harvest moved the withheld fees into the mint')
assert.equal(getTransferFeeAmount(await getAccount(connection, vault, 'confirmed', TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n, 0n, 'the vault holds nothing withheld after the harvest')
const collector = Keypair.generate().publicKey
const collectorCoin = getAssociatedTokenAddressSync(mint.publicKey, collector, false, TOKEN_2022_PROGRAM_ID)
await send(new Transaction()
  .add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, collectorCoin, collector, mint.publicKey, TOKEN_2022_PROGRAM_ID))
  .add(createWithdrawWithheldTokensFromMintInstruction(mint.publicKey, collectorCoin, payer.publicKey, [], TOKEN_2022_PROGRAM_ID)))
const collected = (await getAccount(connection, collectorCoin, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount
assert.equal(collected, harvested, 'everything harvested was withdrawn, and the withdrawal itself is not charged')
ok(`harvested ${Number(harvested) / unit} from the buyer and the vault into the mint, withdrew all ${Number(collected) / unit} to a wallet, uncharged`)

// ── the hourly collection, through the library the Worker uses ───────────────
// A second holder buys, the first sells some more: fees are withheld in the second's
// account and in the pool's vault. Then: list the coin's accounts, read what they
// withhold, harvest and withdraw it to the collector, and hand it to the holders.
const second = Keypair.generate()
await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: second.publicKey, lamports: 50_000_000 })))
const secondQuote = await getOrCreateAssociatedTokenAccount(connection, payer, quoteMint, second.publicKey)
await mintTo(connection, payer, quoteMint, secondQuote.address, payer, 20 * unit)
const secondBuy = await quoteOf(4 * unit, false)
await send(await client.pool.swap2({
  owner: second.publicKey, payer: second.publicKey, pool: poolAddress, amountIn: new BN(4 * unit), minimumAmountOut: new BN(secondBuy.minimumAmountOut.toString()),
  swapMode: SwapMode.ExactIn, swapBaseForQuote: false, referralTokenAccount: null,
}), [second])
await swap(((await held(mint.publicKey, payer.publicKey)).amount / 4n).toString(), true, '0')
const accounts = await tokenAccounts(RPC, mint.publicKey.toBase58())
const owed = await withheldOf(connection, mint.publicKey, accounts)
assert.ok(owed.toHarvest.length >= 2 && owed.total > 0n, 'fees are withheld in the second holder\'s account and the vault')
const { txs: collect, destination } = collectTransactions(mint.publicKey.toBase58(), owed.toHarvest, payer.publicKey)
const potBefore = await getAccount(connection, destination, 'confirmed', TOKEN_2022_PROGRAM_ID).then((a) => a.amount).catch(() => 0n)
for (const tx of collect) await send(tx)
const claimed = (await getAccount(connection, destination, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount - potBefore
assert.equal(claimed, owed.total, 'the collection brings in exactly what was withheld')
ok(`collected ${Number(claimed) / unit} from ${owed.toHarvest.length} accounts in ${collect.length} transaction(s)`)
const fresh = await tokenAccounts(RPC, mint.publicKey.toBase58())
const holders = fresh.filter((a) => a.amount > 0n).map((a) => ({ address: a.owner, amount: a.amount }))
const plan = payoutInstructions({
  holders, pot: payer.publicKey, payer: payer.publicKey, quoteMint: mint.publicKey.toBase58(), amount: claimed, price: 1,
  // The wallet step 6 withdrew to holds coins too; left out with the curve and the collector.
  exclude: [deriveDbcPoolAuthority().toBase58(), poolAddress.toBase58(), payer.publicKey.toBase58(), collector.toBase58()], tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 6,
})
assert.equal(plan.payouts.length, 1, 'the only holder to pay is the second one: the curve and the collector are left out')
const secondBefore = (await held(mint.publicKey, second.publicKey)).amount
for (const instructions of plan.batches) await send(new Transaction().add(...instructions))
const secondGot = (await held(mint.publicKey, second.publicKey)).amount - secondBefore
const expected = (plan.payouts[0].amount * BigInt(10_000 - TRANSFER_FEE_BPS)) / 10_000n
assert.ok(secondGot >= expected - 1n && secondGot <= plan.payouts[0].amount, `the holder receives the payout less the 2% it pays on arrival (got ${secondGot}, sent ${plan.payouts[0].amount})`)
ok(`paid ${Number(plan.payouts[0].amount) / unit} to the one holder, who received ${Number(secondGot) / unit} after the coin's own 2%`)

// ── graduation: fill the curve, migrate, and the fee is still there ───────────
for (let i = 0; i < 6 && !(await readyToGraduate(client, [{ pool: poolAddress.toBase58(), isMigrated: false }])).length; i++) {
  const q = await quoteOf(10 * unit, false).catch(() => null)
  await client.pool.swap2({
    owner: payer.publicKey, payer: payer.publicKey, pool: poolAddress, amountIn: new BN(10 * unit), minimumAmountOut: new BN(0),
    swapMode: SwapMode.PartialFill, swapBaseForQuote: false, referralTokenAccount: null,
  }).then((tx) => send(tx))
  if (!q) break
}
const ready = await readyToGraduate(client, [{ pool: poolAddress.toBase58(), isMigrated: false }])
assert.equal(ready.length, 1, 'the curve is full')
ok('curve filled')
const sig = await graduate(client, connection, poolAddress, payer)
const migrated = (await client.state.getPool(poolAddress)).poolState
assert.ok(migrated.isMigrated, 'the pool says it migrated')
const after = getTransferFeeConfig(await getMint(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID))
assert.equal(Number(after.newerTransferFee.transferFeeBasisPoints), TRANSFER_FEE_BPS, 'the fee survives graduation')
assert.ok(!after.transferFeeConfigAuthority || after.transferFeeConfigAuthority.equals(PublicKey.default), 'and still nobody can change it')
ok(`graduated (${sig.slice(0, 12)}…): the coin still charges ${TRANSFER_FEE_BPS / 100}%, fee config authority still none`)

console.log(`\nall ${step} steps passed — coin ${mint.publicKey.toBase58()} on devnet`)
