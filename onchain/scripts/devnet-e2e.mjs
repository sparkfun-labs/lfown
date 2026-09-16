// LFOwn fair launch — the whole on-chain flow on devnet, end to end, over a real Meteora
// DAMM v2 pool.
//
//   node scripts/devnet-e2e.mjs
//
// Devnet only. Every token is a mint this script creates — the quote coin stands in for an
// ownership coin such as META — every wallet but the payer is generated here, and the payer
// is the local Solana CLI key (~/.config/solana/id.json), spending devnet SOL only.
//
//   1. a 60-second raise of 1,000 quote coins for 10M tokens, two backers, oversubscribed
//   2. settle: 200 coins to the DAO treasury, 800 coins + 8M tokens + mint authority to the
//      pool operator
//   3. the operator opens the DAMM v2 pool with them and hands the DAO its position and mint
//   4. a proposal funded by half the pool's liquidity; option 1 pays and mints for a grantee
//   5. a trader backs option 1, the TWAP runs five minutes, option 1 wins and a stranger
//      executes it
//   6. a stranger brings the liquidity home and returns it to the pool
//   7. the pool trades; a stranger claims the fees, split 50/50 with LFOwn
//   8. backers claim their tokens and refunds

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'
import anchor from '@coral-xyz/anchor'
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, AccountLayout, AuthorityType, MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createMintToInstruction, createSetAuthorityInstruction, createTransferInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  deriveCustomizablePoolAddress, derivePositionAddress, derivePositionNftAccount, deriveTokenVaultAddress, getBaseFeeParams,
} from '@meteora-ag/cp-amm-sdk'

const { BN } = anchor
const here = (p) => new URL(p, import.meta.url)
const KEY = readFileSync(here('../../.dev.vars'), 'utf8').match(/api-key=([a-f0-9-]+)/)[1]
const RPC = `https://devnet.helius-rpc.com/?api-key=${KEY}`
if (!RPC.includes('devnet')) throw new Error('devnet only')
const connection = new Connection(RPC, 'confirmed')
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))))

const idl = (name) => JSON.parse(readFileSync(here(`../target/idl/${name}.json`), 'utf8'))
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {})
const raiseP = new anchor.Program(idl('lfown_raise'), provider)
const fut = new anchor.Program(idl('futarchy'), provider)
const amm = new anchor.Program(idl('amm'), provider)
const vault = new anchor.Program(idl('vault'), provider)
const damm = new anchor.Program(JSON.parse(readFileSync(here('../idls/cp_amm.json'), 'utf8')), provider)
const FEE_AUTHORITY = new PublicKey(idl('amm').constants.find((c) => c.name === 'FEE_AUTHORITY').value)
const DAMM_POOL_AUTHORITY = new PublicKey('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC')
const DAMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], damm.programId)[0]
const MIN_SQRT = 4_295_048_016n
const MAX_SQRT = 79_226_673_521_066_979_257_578_248_091n

const UNIT = 1_000_000n
const bn = (v) => new BN(v.toString())
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const pda = (program, seeds) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === 'string' ? Buffer.from(s) : s instanceof PublicKey ? s.toBuffer() : s)), program.programId)[0]
const ata = (mint, owner, program = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, program)
const meta = (pubkey, isWritable = true) => ({ pubkey, isSigner: false, isWritable })
const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n } return x }
const liquidityFor = (a, b, p) => { const fromA = a * ((p * MAX_SQRT) / (MAX_SQRT - p)); const fromB = (b << 128n) / (p - MIN_SQRT); return (fromA < fromB ? fromA : fromB) - 1n }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

async function send(ixs, signers, what) {
  for (let attempt = 1; ; attempt++) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs)
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    tx.recentBlockhash = blockhash
    tx.feePayer = signers[0].publicKey
    tx.sign(...signers)
    let sig
    try {
      sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' })
    } catch (e) {
      const logs = e.logs ?? (typeof e.getLogs === 'function' ? await e.getLogs(connection).catch(() => null) : null)
      return { ok: false, code: logs?.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean), error: e.message, logs }
    }
    while (true) {
      const { value } = await connection.getSignatureStatuses([sig])
      const s = value[0]
      if (s?.err) return { ok: false, error: JSON.stringify(s.err), sig }
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return { ok: true, sig }
      if ((await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) break
      await sleep(800)
    }
    if (attempt >= 3) return { ok: false, error: `${what}: expired three times` }
  }
}
const must = async (p, what) => { const r = await p; assert.ok(r.ok, `${what} failed: ${r.code ?? ''} ${r.error ?? ''}\n${r.logs?.slice(-20).join('\n') ?? ''}`); log('✔', what); return r }
const refused = async (p, code, what) => { const r = await p; assert.equal(r.ok, false, `${what} should have been refused`); if (code) assert.equal(r.code, code, `${what}: expected ${code}, got ${r.code}`); log('✔ refused:', what, code ? `(${code})` : '') }
const balance = async (address) => { const a = await connection.getAccountInfo(address, 'confirmed'); return a ? AccountLayout.decode(a.data).amount : 0n }
const decode = async (program, name, address) => program.coder.accounts.decode(name, (await connection.getAccountInfo(address, 'confirmed')).data)
const fmt = (units) => (Number(units) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })

async function createMint(authority, label) {
  const mint = Keypair.generate()
  await must(send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, 6, authority, null),
  ], [payer, mint], 'mint'), `create ${label} ${mint.publicKey.toBase58()}`)
  return mint.publicKey
}
const mintTo = (mint, owner, amount) => must(send([
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(mint, owner), owner, mint),
  createMintToInstruction(mint, ata(mint, owner), payer.publicKey, amount),
], [payer], 'mint to'), `give ${owner.toBase58().slice(0, 8)} ${fmt(amount)}`)
async function wallet(sol) {
  const kp = Keypair.generate()
  await must(send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) })], [payer], 'fund'), `fund ${kp.publicKey.toBase58().slice(0, 8)} with ${sol} SOL`)
  return kp
}

const started = Date.now()
log('payer', payer.publicKey.toBase58(), (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, 'devnet SOL')
for (const p of [raiseP, fut, amm, vault, damm]) assert.ok((await connection.getAccountInfo(p.programId))?.executable, `${p.programId} is not deployed on devnet`)

// ── 1. the raise, in an ownership coin ──────────────────────────────────────
const coin = await createMint(payer.publicKey, 'quote coin (stand-in for an ownership coin)')
const daoName = `e2e-${Date.now().toString(36)}`
const dao = pda(fut, ['dao', daoName])
const moderator = pda(fut, ['moderator', daoName])
const treasury = pda(fut, ['treasury', dao])
const mintAuthority = pda(fut, ['mint_authority', dao])
const liquidityAuthority = pda(fut, ['liquidity', dao])

const baseKp = Keypair.generate()
const baseMint = baseKp.publicKey
const raise = pda(raiseP, ['raise', baseMint])
const operator = payer
const GOAL = 1_000n * UNIT
const POOL_QUOTE = 800n * UNIT
const POOL_TOKENS = 8_000_000n * UNIT
await must(send([
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: baseMint, lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
  createInitializeMint2Instruction(baseMint, 6, raise, null),
  await raiseP.methods.initializeRaise({
    goal: bn(GOAL), tokensForInvestors: bn(10_000_000n * UNIT), tokensForPool: bn(POOL_TOKENS),
    quoteToPool: bn(POOL_QUOTE), durationSeconds: bn(60), claimDelaySeconds: bn(3_600),
  }).accountsStrict({
    baseMint, quoteMint: coin, raise, baseVault: ata(baseMint, raise), quoteVault: ata(coin, raise),
    treasury, poolOperator: operator.publicKey, authority: payer.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction(),
], [payer, baseKp], 'open raise'), `open raise ${raise.toBase58()} for token ${baseMint.toBase58()}`)

const commitment = (user) => pda(raiseP, ['commitment', raise, user])
const commit = async (user, amount) => send([await raiseP.methods.commit(bn(amount)).accountsStrict({
  raise, commitment: commitment(user.publicKey), userQuote: ata(coin, user.publicKey), quoteVault: ata(coin, raise),
  user: user.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
}).instruction()], [user], 'commit')
const alice = await wallet(0.1)
const bob = await wallet(0.1)
await mintTo(coin, alice.publicKey, 1_200n * UNIT)
await mintTo(coin, bob.publicKey, 800n * UNIT)
await must(commit(alice, 1_200n * UNIT), 'alice commits 1,200 coins')
await must(commit(bob, 800n * UNIT), 'bob commits 800 coins — 2× oversubscribed')

const { endsAt } = await decode(raiseP, 'raise', raise)
const wait = Number(endsAt) * 1000 - Date.now() + 8_000
log(`waiting ${Math.ceil(wait / 1000)} s for the raise to end`)
await sleep(Math.max(wait, 0))
await must(send([await raiseP.methods.settle().accountsStrict({
  raise, baseMint, quoteMint: coin, baseVault: ata(baseMint, raise), quoteVault: ata(coin, raise),
  treasury, treasuryQuote: ata(coin, treasury), poolOperator: operator.publicKey,
  operatorQuote: ata(coin, operator.publicKey), operatorBase: ata(baseMint, operator.publicKey),
  cranker: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
}).instruction()], [payer], 'settle'), 'settle the raise')
assert.equal(await balance(ata(coin, treasury)), 200n * UNIT)
log('✔ treasury 200 coins · operator 800 coins + 8M tokens + mint authority')

// ── 2. the pool, and the DAO takes it over ──────────────────────────────────
const pool = deriveCustomizablePoolAddress(baseMint, coin)
const nft = Keypair.generate()
const position = derivePositionAddress(nft.publicKey)
const tokenAVault = deriveTokenVaultAddress(baseMint, pool)
const tokenBVault = deriveTokenVaultAddress(coin, pool)
const sqrtPrice = isqrt((POOL_QUOTE << 128n) / POOL_TOKENS)
await must(send([await damm.methods.initializeCustomizablePool({
  poolFees: { baseFee: { data: getBaseFeeParams({ baseFeeMode: 0, feeTimeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } }).data }, compoundingFeeBps: 0, padding: 0, dynamicFee: null },
  sqrtMinPrice: bn(MIN_SQRT), sqrtMaxPrice: bn(MAX_SQRT), hasAlphaVault: false,
  liquidity: bn(liquidityFor(POOL_TOKENS, POOL_QUOTE, sqrtPrice)), sqrtPrice: bn(sqrtPrice),
  activationType: 1, collectFeeMode: 1, activationPoint: null,
}).accountsStrict({
  creator: operator.publicKey, positionNftMint: nft.publicKey, positionNftAccount: derivePositionNftAccount(nft.publicKey), payer: operator.publicKey,
  poolAuthority: DAMM_POOL_AUTHORITY, pool, position, tokenAMint: baseMint, tokenBMint: coin, tokenAVault, tokenBVault,
  payerTokenA: ata(baseMint, operator.publicKey), payerTokenB: ata(coin, operator.publicKey),
  tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
  systemProgram: SystemProgram.programId, eventAuthority: DAMM_EVENT_AUTHORITY, program: damm.programId,
}).instruction()], [operator, nft], 'pool'), `open DAMM v2 pool ${pool.toBase58()} with 8M tokens + 800 coins`)

const positionNftAccount = ata(nft.publicKey, liquidityAuthority, TOKEN_2022_PROGRAM_ID)
const liquidityBase = ata(baseMint, liquidityAuthority)
const liquidityQuote = ata(coin, liquidityAuthority)
await must(send([createSetAuthorityInstruction(baseMint, operator.publicKey, AuthorityType.MintTokens, mintAuthority)], [operator], 'mint'), 'operator hands the mint to the DAO')
await must(send([await fut.methods.initializeDao(daoName, pool, { damm: {} }, 5_000)
  .accountsStrict({ admin: operator.publicKey, dao, moderator, treasury, mintAuthority, liquidityAuthority, baseMint, quoteMint: coin, systemProgram: SystemProgram.programId })
  .instruction()], [operator], 'dao'), `open DAO ${dao.toBase58()} (proposals take 50% of the position)`)
await must(send([
  createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, positionNftAccount, liquidityAuthority, nft.publicKey, TOKEN_2022_PROGRAM_ID),
  createTransferInstruction(derivePositionNftAccount(nft.publicKey), positionNftAccount, operator.publicKey, 1, [], TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, liquidityBase, liquidityAuthority, baseMint),
  createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, liquidityQuote, liquidityAuthority, coin),
  await fut.methods.attachPosition().accountsStrict({ admin: operator.publicKey, dao, liquidityAuthority, pool, position, positionNftAccount }).instruction(),
], [operator], 'attach'), 'operator hands the position NFT to the DAO; the DAO attaches it')
const positionLiquidity = async () => BigInt((await decode(damm, 'position', position)).unlockedLiquidity.toString())
const startLiquidity = await positionLiquidity()

// ── 3. a proposal funded by the pool ────────────────────────────────────────
const programs = { systemProgram: SystemProgram.programId, vaultProgram: vault.programId, ammProgram: amm.programId, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID }
const dammAccounts = { pool, position, tokenAVault, tokenBVault, positionNftAccount, eventAuthority: DAMM_EVENT_AUTHORITY, cpAmmProgram: damm.programId }
const proposal = pda(fut, ['proposal', moderator, u16(0)])
const vaultPda = pda(vault, ['vault', proposal, u16(0)])
const cmint = (type, i) => pda(vault, ['cmint', vaultPda, Buffer.from([type]), Buffer.from([i])])
const opts = [0, 1].map((i) => {
  const condBase = cmint(0, i); const condQuote = cmint(1, i)
  const p = pda(amm, ['pool', proposal, condQuote, condBase])
  return { condBase, condQuote, pool: p, reserveA: pda(amm, ['reserve', p, condQuote]), reserveB: pda(amm, ['reserve', p, condBase]), feeVault: pda(amm, ['fee_vault', p]) }
})
const start = bn(100_000_000n) // 0.0001 coin per token, scaled by 1e12
await must(send([await fut.methods.initializeProposal({ length: 5, startingObservation: start, maxObservationDelta: start, warmupDuration: 0, marketBias: 0, fee: 50 }, null)
  .accountsStrict({ creator: operator.publicKey, moderator, dao, proposal, ...programs })
  .remainingAccounts([
    meta(baseMint, false), meta(coin, false), meta(vaultPda), meta(ata(baseMint, vaultPda)), meta(ata(coin, vaultPda)),
    meta(opts[0].condBase), meta(opts[1].condBase), meta(opts[0].condQuote), meta(opts[1].condQuote),
    meta(opts[0].pool), meta(opts[0].reserveA), meta(opts[0].reserveB), meta(FEE_AUTHORITY, false), meta(opts[0].feeVault),
    meta(opts[1].pool), meta(opts[1].reserveA), meta(opts[1].reserveB), meta(opts[1].feeVault),
  ]).instruction()], [operator], 'proposal'), `create proposal ${proposal.toBase58()}`)

const grantee = Keypair.generate().publicKey
const actions = pda(fut, ['actions', proposal, Buffer.from([1])])
await must(send([await fut.methods.setOptionActions(1, [
  { transfer: { mint: coin, amount: bn(50n * UNIT), recipient: grantee } },
  { mintTo: { amount: bn(100_000n * UNIT), recipient: grantee } },
]).accountsStrict({ creator: operator.publicKey, proposal, optionActions: actions, systemProgram: SystemProgram.programId }).instruction()], [operator], 'actions'),
'option 1: pay the grantee 50 coins from the treasury, mint them 100,000 tokens')

await must(send([await fut.methods.prepareProposalLiquidity().accountsStrict({
  creator: operator.publicKey, proposal, moderator, dao, liquidityAuthority, liquidityBase, liquidityQuote,
  poolAuthority: DAMM_POOL_AUTHORITY, tokenAMint: baseMint, tokenBMint: coin, tokenProgram: TOKEN_PROGRAM_ID, ...dammAccounts,
}).instruction()], [operator], 'prepare'), 'the DAO takes 50% of its pool position out for the markets')
const prepared = await decode(fut, 'proposalAccount', proposal)
log(`  out of the pool: ${fmt(prepared.baseLiquidity)} tokens + ${fmt(prepared.quoteLiquidity)} coins`)

await must(send(opts.flatMap((o) => [
  createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ata(o.condBase, liquidityAuthority), liquidityAuthority, o.condBase),
  createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ata(o.condQuote, liquidityAuthority), liquidityAuthority, o.condQuote),
]), [operator], 'cond accounts'), 'conditional accounts for the DAO')
await must(send([await fut.methods.launchProposal()
  .accountsStrict({ creator: operator.publicKey, proposal, vault: vaultPda, moderator, dao, liquidityAuthority, ...programs })
  .remainingAccounts([
    meta(baseMint, false), meta(coin, false), meta(ata(baseMint, vaultPda)), meta(ata(coin, vaultPda)),
    meta(liquidityBase), meta(liquidityQuote),
    ...opts.map((o) => meta(o.condBase)), ...opts.map((o) => meta(o.condQuote)),
    ...opts.map((o) => meta(ata(o.condBase, liquidityAuthority))), ...opts.map((o) => meta(ata(o.condQuote, liquidityAuthority))),
    ...opts.map((o) => meta(o.pool)), ...opts.map((o) => meta(o.reserveA)), ...opts.map((o) => meta(o.reserveB)),
  ]).instruction()], [operator], 'launch'), 'launch: the DAO’s liquidity funds both markets')

const trader = await wallet(0.1)
await mintTo(coin, trader.publicKey, 300n * UNIT)
await must(send([await vault.methods.deposit({ quote: {} }, bn(200n * UNIT))
  .accountsStrict({ signer: trader.publicKey, vault: vaultPda, mint: coin, vaultAta: ata(coin, vaultPda), userAta: ata(coin, trader.publicKey), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
  .remainingAccounts(opts.flatMap((o) => [meta(o.condQuote), meta(ata(o.condQuote, trader.publicKey))])).instruction()], [trader], 'split'), 'trader splits 200 coins')
const o1 = opts[1]
await must(send([
  createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(o1.condBase, trader.publicKey), trader.publicKey, o1.condBase),
  await amm.methods.swap(true, bn(80n * UNIT), bn(0)).accountsStrict({ trader: trader.publicKey, pool: o1.pool, reserveA: o1.reserveA, reserveB: o1.reserveB, feeVault: o1.feeVault, traderAccountA: ata(o1.condQuote, trader.publicKey), traderAccountB: ata(o1.condBase, trader.publicKey), tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
], [trader], 'swap'), 'trader buys option 1')

const { createdAt } = await decode(fut, 'proposalAccount', proposal)
const endMs = (Number(createdAt) + 5 * 60) * 1000
while (Date.now() < endMs + 5_000) {
  await sleep(62_000)
  await must(send(await Promise.all(opts.map((o) => amm.methods.crankTwap().accountsStrict({ pool: o.pool, reserveA: o.reserveA, reserveB: o.reserveB }).instruction())), [payer], 'crank'), 'crank the TWAP')
}
await must(send([await fut.methods.finalizeProposal()
  .accountsStrict({ signer: payer.publicKey, proposal, vault: vaultPda, vaultProgram: vault.programId, ammProgram: amm.programId })
  .remainingAccounts(opts.flatMap((o) => [meta(o.pool), meta(o.reserveA, false), meta(o.reserveB, false)])).instruction()], [payer], 'finalize'), 'finalize')
const { state } = await decode(fut, 'proposalAccount', proposal)
assert.equal(Number(Object.values(state.resolved)[0]), 1, 'option 1 should have won')
log('✔ option 1 won')

const stranger = await wallet(0.1)
const common = { payer: stranger.publicKey, proposal, moderator, dao, optionActions: actions, recipient: grantee, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }
await must(send([await fut.methods.executeTransfer(0).accountsStrict({ ...common, treasury, mint: coin, treasuryToken: ata(coin, treasury), recipientToken: ata(coin, grantee) }).instruction()], [stranger], 'exec'), 'a stranger executes the transfer')
await must(send([await fut.methods.executeMint(1).accountsStrict({ ...common, mintAuthority, mint: baseMint, recipientToken: ata(baseMint, grantee) }).instruction()], [stranger], 'exec'), 'a stranger executes the mint')
assert.equal(await balance(ata(coin, grantee)), 50n * UNIT)
assert.equal(await balance(ata(baseMint, grantee)), 100_000n * UNIT)

// ── 4. the liquidity goes home ──────────────────────────────────────────────
const w1 = opts[1]
await must(send([await fut.methods.redeemLiquidity()
  .accountsStrict({ payer: stranger.publicKey, proposal, vault: vaultPda, moderator, dao, liquidityAuthority, pool: w1.pool, ...programs })
  .remainingAccounts([
    meta(w1.reserveA), meta(w1.reserveB), meta(ata(w1.condQuote, liquidityAuthority)), meta(ata(w1.condBase, liquidityAuthority)),
    meta(baseMint, false), meta(ata(baseMint, vaultPda)), meta(liquidityBase),
    ...opts.flatMap((x) => [meta(x.condBase), meta(ata(x.condBase, liquidityAuthority))]),
    meta(coin, false), meta(ata(coin, vaultPda)), meta(liquidityQuote),
    ...opts.flatMap((x) => [meta(x.condQuote), meta(ata(x.condQuote, liquidityAuthority))]),
  ]).instruction()], [stranger], 'redeem'), 'a stranger redeems the markets’ liquidity')
await must(send([await fut.methods.returnLiquidity().accountsStrict({
  payer: stranger.publicKey, dao, liquidityAuthority, liquidityBase, liquidityQuote, tokenAMint: baseMint, tokenBMint: coin, tokenProgram: TOKEN_PROGRAM_ID, ...dammAccounts,
}).instruction()], [stranger], 'return'), 'a stranger returns it to the pool')
const endLiquidity = await positionLiquidity()
log(`  position liquidity back to ${Number(endLiquidity * 1000n / startLiquidity) / 10}% (the trader who backed the winner kept their share)`)

// ── 5. the pool trades, and the fees are split ──────────────────────────────
const swapper = await wallet(0.1)
await mintTo(coin, swapper.publicKey, 300n * UNIT)
for (let i = 0; i < 3; i++) {
  await must(send([
    createAssociatedTokenAccountIdempotentInstruction(swapper.publicKey, ata(baseMint, swapper.publicKey), swapper.publicKey, baseMint),
    await damm.methods.swap2({ amount0: bn(80n * UNIT), amount1: bn(0), swapMode: 0 }).accountsStrict({
      poolAuthority: DAMM_POOL_AUTHORITY, pool, inputTokenAccount: ata(coin, swapper.publicKey), outputTokenAccount: ata(baseMint, swapper.publicKey),
      tokenAVault, tokenBVault, tokenAMint: baseMint, tokenBMint: coin, payer: swapper.publicKey,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, eventAuthority: DAMM_EVENT_AUTHORITY, program: damm.programId,
    }).instruction(),
  ], [swapper], 'swap'), `someone buys the token on the DAMM v2 pool with 80 coins`)
}
const treasuryBefore = await balance(ata(coin, treasury))
const protocolBefore = await balance(ata(coin, FEE_AUTHORITY))
await must(send([await fut.methods.claimPoolFees().accountsStrict({
  payer: stranger.publicKey, dao, liquidityAuthority, treasury, protocol: FEE_AUTHORITY, baseMint, quoteMint: coin, liquidityBase, liquidityQuote,
  treasuryBase: ata(baseMint, treasury), treasuryQuote: ata(coin, treasury), protocolBase: ata(baseMint, FEE_AUTHORITY), protocolQuote: ata(coin, FEE_AUTHORITY),
  poolAuthority: DAMM_POOL_AUTHORITY, ...dammAccounts, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
}).instruction()], [stranger], 'fees'), 'a stranger claims the pool fees')
const toTreasury = (await balance(ata(coin, treasury))) - treasuryBefore
const toProtocol = (await balance(ata(coin, FEE_AUTHORITY))) - protocolBefore
assert.ok(toProtocol > 0n && toTreasury >= toProtocol && toTreasury - toProtocol <= 1n)
log(`✔ fees: ${fmt(toTreasury)} coins to the DAO treasury, ${fmt(toProtocol)} to LFOwn`)

// ── 6. backers claim ────────────────────────────────────────────────────────
await must(send([await raiseP.methods.openClaims().accountsStrict({ raise, poolOperator: operator.publicKey }).instruction()], [operator], 'open claims'), 'operator opens claims')
for (const [who, name, tokens, refund] of [[alice, 'alice', 6_000_000n, 600n], [bob, 'bob', 4_000_000n, 400n]]) {
  await must(send([await raiseP.methods.claim().accountsStrict({
    raise, commitment: commitment(who.publicKey), baseMint, quoteMint: coin, baseVault: ata(baseMint, raise), quoteVault: ata(coin, raise),
    userBase: ata(baseMint, who.publicKey), userQuote: ata(coin, who.publicKey), user: who.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()], [who], 'claim'), `${name} claims`)
  assert.equal(await balance(ata(baseMint, who.publicKey)), tokens * UNIT)
  assert.equal(await balance(ata(coin, who.publicKey)), refund * UNIT)
}
log('✔ alice 6M tokens + 600 coins back · bob 4M tokens + 400 coins back')
log(`done in ${Math.round((Date.now() - started) / 1000)} s · raise ${raise.toBase58()} · pool ${pool.toBase58()} · DAO ${dao.toBase58()}`)
