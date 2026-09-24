// LFOwn — a launch whose creator fees belong to another wallet, end to end on devnet.
//
// The launch page's "Fees go to" field, through the same builder the page uses:
//   1. a launch with a vault writes the named wallet into the creator's slot, and the
//      site reads it back as that coin's fee wallet while still crediting the launcher;
//   2. a trade later, that wallet pulls the fees into the vault and claims them with
//      its own signature — and the launcher, who signed the launch, cannot;
//   3. a free launch naming a fee wallet still passes the sponsor's check;
//   4. with no vault, the pool itself is handed to the named wallet;
//   5. addresses that could never claim are refused before anything is built.
//
//   node scripts/test-fee-wallet-devnet.mjs
//
// Spends devnet SOL from .keys/devnet.json only.

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import {
  DynamicBondingCurveClient, buildCurve, TokenType, TokenDecimal, ActivationType, CollectFeeMode,
  MigrationOption, MigrationFeeOption, BaseFeeMode, TokenAuthorityOption, DEFAULT_MIGRATED_POOL_FEE_PARAMS,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DynamicFeeSharingClient } from '@meteora-ag/dynamic-fee-sharing-sdk'
import BN from 'bn.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FEES } from '../src/lib/config.mjs'
import { buildLaunchTransactions } from '../src/lib/launch-builder.mjs'
import { resolveVaultCreators } from '../src/lib/launches.mjs'
import { deriveVault } from '../src/lib/fee-split.mjs'
import { checkSponsored } from '../src/lib/sponsor.mjs'

const KEY = readFileSync('.dev.vars', 'utf8').match(/api-key=([a-f0-9-]+)/)[1]
const connection = new Connection(`https://devnet.helius-rpc.com/?api-key=${KEY}`, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')
const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.keys/devnet.json', 'utf8'))))
const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`)
const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
const fund = (to, sol) => send(new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [funder])

// The pot has to be the site's own for the fee wallet to be read back: the resolver
// tells the creator's slot from the holders' by it.
const holderPot = FEES.holderPot

// A quote coin and a config on it, as create-config opens one for an ownership coin.
const quoteMint = await createMint(connection, funder, funder.publicKey, null, 6)
const config = Keypair.generate()
const curve = buildCurve({
  token: { tokenType: TokenType.SPL, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.SIX, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
  fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: FEES.totalBps, endingFeeBps: FEES.totalBps, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: true, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: FEES.creatorSharePct, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
  migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, migratedPoolFee: DEFAULT_MIGRATED_POOL_FEE_PARAMS },
  liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 50, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50, creatorLiquidityPercentage: 0 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Slot, percentageSupplyOnMigration: 20, migrationQuoteThreshold: 1_000_000,
})
await send(await client.partner.createConfig({ config: config.publicKey, feeClaimer: funder.publicKey, leftoverReceiver: funder.publicKey, quoteMint, payer: funder.publicKey, ...curve }), [funder, config])
say(`quote ${quoteMint.toBase58()} · config ${config.publicKey.toBase58()}`)

const launcher = Keypair.generate() // the fan
const earner = Keypair.generate() // the person the coin is about
await fund(launcher.publicKey, 0.1)
await fund(earner.publicKey, 0.02) // a claim's fee and one token account, nothing more

async function launch(label, { holderPct, feeWallet, sponsor = null }) {
  const mint = Keypair.generate()
  const built = await buildLaunchTransactions({
    client, connection, config: config.publicKey.toBase58(), creator: launcher.publicKey.toBase58(),
    token: { name: label, symbol: 'FW', uri: 'https://example.invalid/fw.json' },
    mint, quoteMint: quoteMint.toBase58(), holderPct, holderPot, feeWallet, sponsor,
  })
  return { built, mint }
}

// 1. A launch with a vault, fees to the earner.
const { built, mint } = await launch('fees to another wallet', { holderPct: 37.5, feeWallet: earner.publicKey.toBase58() })
assert.equal(built.feeWallet, earner.publicKey.toBase58())
for (const tx of built.transactions) {
  tx.partialSign(mint)
  await send(tx, [launcher, mint].filter((k) => tx.signatures.some((s) => s.publicKey.equals(k.publicKey))))
}
const pool = new PublicKey(built.pool)
const vaultKey = new PublicKey(built.vault)
assert.equal(vaultKey.toBase58(), deriveVault(mint.publicKey, quoteMint).toBase58())
const { poolState } = await client.state.getPool(pool)
assert.equal(poolState.creator.toBase58(), built.vault, 'the pool belongs to its vault')
const vault = await dfs.getFeeVault(vaultKey)
assert.equal(vault.owner.toBase58(), launcher.publicKey.toBase58(), 'the vault still records who launched')
const slots = vault.users.filter((u) => u.share > 0).map((u) => [u.address.toBase58(), u.share])
assert.deepEqual(slots, [[earner.publicKey.toBase58(), 25], [holderPot, 75]], 'the earner holds the creator slot')
const [entry] = await resolveVaultCreators(connection, PublicKey, [{ creator: built.vault, baseMint: built.baseMint }])
assert.equal(entry.creator, launcher.publicKey.toBase58(), 'the site credits the launcher with the coin')
assert.equal(entry.feeWallet, earner.publicKey.toBase58(), 'and pays the earner its fees')
say(`✔ launched ${built.baseMint}: vault pays ${short(earner.publicKey)} 25, holders 75; launcher recorded`)

// 2. Someone trades; the earner collects.
const trader = Keypair.generate()
await fund(trader.publicKey, 0.02)
const traderAta = await getOrCreateAssociatedTokenAccount(connection, funder, quoteMint, trader.publicKey)
await mintTo(connection, funder, quoteMint, traderAta.address, funder, 500n * 1_000_000n)
await send(await client.pool.swap({
  owner: trader.publicKey, pool, amountIn: new BN(300 * 1e6), minimumAmountOut: new BN(0),
  swapBaseForQuote: false, referralTokenAccount: null,
}), [trader])

// Exactly the page's claim, signed by the earner: pull the curve's fees into the vault,
// then take the earner's share of it.
const pull = await dfs.fundByClaimDbcCreatorTradingFee({
  signer: earner.publicKey, creator: earner.publicKey, feeVault: vaultKey,
  poolConfig: config.publicKey, virtualPool: pool,
})
const take = await dfs.claimUserFee({ feeVault: vaultKey, user: earner.publicKey, payer: earner.publicKey })
await send(new Transaction().add(...pull.instructions, ...take.instructions), [earner])
const earnerAta = await getOrCreateAssociatedTokenAccount(connection, funder, quoteMint, earner.publicKey)
const got = (await getAccount(connection, earnerAta.address)).amount
assert(got > 0n, 'the earner must have been paid')
say(`✔ a trade later, the earner claimed ${Number(got) / 1e6} with its own signature`)

await assert.rejects(dfs.claimUserFee({ feeVault: vaultKey, user: launcher.publicKey, payer: launcher.publicKey }), /User not found/)
say('✔ the launcher is not a shareholder and cannot claim')

// 3. The same launch, free: the sponsor's check does not care who earns.
const sponsor = Keypair.generate()
const free = await launch('free, fees to another wallet', { holderPct: 37.5, feeWallet: earner.publicKey.toBase58(), sponsor: sponsor.publicKey.toBase58() })
free.built.transactions[1].partialSign(launcher)
for (const tx of free.built.transactions) tx.partialSign(free.mint)
const programs = { dbc: client.pool.program, dfs: dfs.program }
const checked = checkSponsored(free.built.transactions, { sponsor: sponsor.publicKey, programs, configs: [{ config: config.publicKey.toBase58(), mint: quoteMint.toBase58() }] })
assert.equal(checked.creator, launcher.publicKey.toBase58())
say('✔ a free launch naming a fee wallet passes the sponsor’s check')

// 4. No vault: the pool itself goes to the earner, in the launch.
const plain = await launch('no vault, fees to another wallet', { holderPct: 0, feeWallet: earner.publicKey.toBase58() })
assert.equal(plain.built.transactions.length, 1)
plain.built.transaction.partialSign(plain.mint)
await send(plain.built.transaction, [launcher, plain.mint])
const plainPool = (await client.state.getPool(new PublicKey(plain.built.pool))).poolState
assert.equal(plainPool.creator.toBase58(), earner.publicKey.toBase58(), 'the pool is the earner’s from the first trade')
say('✔ without a vault, the pool is handed to the earner in the launch itself')

// 5. Refused before anything is built.
await assert.rejects(launch('to a program account', { holderPct: 37.5, feeWallet: built.vault }), /program, not a wallet/)
await assert.rejects(launch('to the pot', { holderPct: 37.5, feeWallet: holderPot }), /pot/)
await assert.rejects(launch('to nonsense', { holderPct: 37.5, feeWallet: 'SrMessi' }), /not a Solana address/)
const own = await launch('to oneself', { holderPct: 37.5, feeWallet: launcher.publicKey.toBase58() })
assert.equal(own.built.feeWallet, null, 'naming yourself is the ordinary launch')
say('✔ a program account, the pot and a non-address are refused; naming yourself changes nothing')

say('done')

function short(k) { const s = k.toBase58(); return `${s.slice(0, 4)}…${s.slice(-4)}` }
