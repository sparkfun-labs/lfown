// LFOwn futarchy fork — a DAO's whole governance cycle over a real Meteora DAMM v2 pool,
// run in LiteSVM.
//
//   anchor build && npm test
//
// The forked futarchy, amm and vault programs as compiled, and Meteora's DAMM v2 program
// as deployed (dumped from devnet into tests/fixtures). What this proves is the point of
// the fork: the treasury, the mint and the pool's liquidity answer to the program and the
// market, and to no key. A winning option's actions run on-chain; a losing option's never
// can; the pool's liquidity goes out to a proposal's markets and back without anyone's
// signature; and the pool's fees are split with LFOwn by the program itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LiteSVM, Clock, FailedTransactionMetadata } from 'litesvm'
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
const idl = (name) => JSON.parse(readFileSync(here(`../target/idl/${name}.json`), 'utf8'))
const provider = new anchor.AnchorProvider(new Connection('http://127.0.0.1:1'), new anchor.Wallet(Keypair.generate()), {})
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
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const pda = (program, seeds) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === 'string' ? Buffer.from(s) : s instanceof PublicKey ? s.toBuffer() : s)), program.programId)[0]
const ata = (mint, owner, program = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, program)
const meta = (pubkey, isWritable = true) => ({ pubkey, isSigner: false, isWritable })
const bn = (v) => new BN(v.toString())
const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n } return x }
/** The same liquidity arithmetic the program uses (src/liquidity.rs), for sizing the pool. */
const liquidityFor = (a, b, p) => { const fromA = a * ((p * MAX_SQRT) / (MAX_SQRT - p)); const fromB = (b << 128n) / (p - MIN_SQRT); return (fromA < fromB ? fromA : fromB) - 1n }

function world() {
  const svm = new LiteSVM()
  for (const [p, file] of [[fut, '../target/deploy/futarchy.so'], [amm, '../target/deploy/amm.so'], [vault, '../target/deploy/vault.so'], [damm, 'fixtures/cp_amm.so']]) {
    svm.addProgramFromFile(p.programId, here(file).pathname)
  }
  const payer = Keypair.generate()
  svm.airdrop(payer.publicKey, BigInt(1_000 * LAMPORTS_PER_SOL))

  // Everything here CPIs several programs deep; the default 200k compute units is not enough.
  const send = (ixs, signers) => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs)
    tx.recentBlockhash = svm.latestBlockhash()
    tx.feePayer = signers[0].publicKey
    tx.sign(...signers)
    const res = svm.sendTransaction(tx)
    svm.expireBlockhash()
    if (res instanceof FailedTransactionMetadata) {
      const logs = res.meta().logs()
      return { ok: false, code: logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean), logs }
    }
    return { ok: true, logs: res.logs() }
  }
  const must = (r, what) => { assert.ok(r.ok, `${what} failed: ${r.code ?? ''}\n${r.logs?.slice(-25).join('\n')}`); return r }
  const refused = (r, code, what) => {
    assert.equal(r.ok, false, `${what} should have been refused`)
    if (code) assert.equal(r.code, code, `${what}: expected ${code}, got ${r.code}\n${r.logs?.slice(-15).join('\n')}`)
  }
  const person = (sol = 10) => { const kp = Keypair.generate(); svm.airdrop(kp.publicKey, BigInt(sol * LAMPORTS_PER_SOL)); return kp }
  const createMint = (authority) => {
    const mint = Keypair.generate()
    must(send([
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, 6, authority, null),
    ], [payer, mint]), 'create mint')
    return mint.publicKey
  }
  const fund = (mint, owner, amount) => must(send([
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(mint, owner), owner, mint),
    createMintToInstruction(mint, ata(mint, owner), payer.publicKey, amount),
  ], [payer]), 'fund')
  const account = (address, program = TOKEN_PROGRAM_ID) => { const a = svm.getAccount(address); return a ? AccountLayout.decode(Buffer.from(a.data)) : null }
  const balance = (address) => account(address)?.amount ?? 0n
  const supply = (mint) => MintLayout.decode(Buffer.from(svm.getAccount(mint).data)).supply
  const warp = (seconds) => {
    const c = svm.getClock()
    svm.setClock(new Clock(c.slot + 500n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(seconds)))
  }
  const decode = (program, name, address) => program.coder.accounts.decode(name, Buffer.from(svm.getAccount(address).data))
  return { svm, payer, send, must, refused, person, createMint, fund, balance, supply, warp, decode }
}

/**
 * A launched token: a DAMM v2 pool of 8M tokens against 4,000 of a quote coin (the
 * ownership coin a launch is paired with), and a DAO that holds the token's mint and,
 * once attached, the pool's position.
 */
async function launchedDao(w, { name = 'lfown-test', withdrawalBps = 5_000 } = {}) {
  const admin = w.payer
  const quoteMint = w.createMint(admin.publicKey)
  const baseMint = w.createMint(admin.publicKey)
  w.fund(baseMint, admin.publicKey, 20_000_000n * UNIT)
  w.fund(quoteMint, admin.publicKey, 20_000n * UNIT)

  const dao = pda(fut, ['dao', name])
  const moderator = pda(fut, ['moderator', name])
  const treasury = pda(fut, ['treasury', dao])
  const mintAuthority = pda(fut, ['mint_authority', dao])
  const liquidityAuthority = pda(fut, ['liquidity', dao])

  // The pool, as the raise's pool operator opens it.
  const pool = deriveCustomizablePoolAddress(baseMint, quoteMint)
  const nft = Keypair.generate()
  const position = derivePositionAddress(nft.publicKey)
  const tokenAVault = deriveTokenVaultAddress(baseMint, pool)
  const tokenBVault = deriveTokenVaultAddress(quoteMint, pool)
  const a = 8_000_000n * UNIT
  const b = 4_000n * UNIT
  const sqrtPrice = isqrt((b << 128n) / a)
  const openPool = await damm.methods.initializeCustomizablePool({
    poolFees: {
      baseFee: { data: getBaseFeeParams({ baseFeeMode: 0, feeTimeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } }).data },
      compoundingFeeBps: 0, padding: 0, dynamicFee: null,
    },
    sqrtMinPrice: bn(MIN_SQRT), sqrtMaxPrice: bn(MAX_SQRT), hasAlphaVault: false,
    liquidity: bn(liquidityFor(a, b, sqrtPrice)), sqrtPrice: bn(sqrtPrice),
    activationType: 1, collectFeeMode: 1, activationPoint: null,
  }).accountsStrict({
    creator: admin.publicKey, positionNftMint: nft.publicKey, positionNftAccount: derivePositionNftAccount(nft.publicKey), payer: admin.publicKey,
    poolAuthority: DAMM_POOL_AUTHORITY, pool, position, tokenAMint: baseMint, tokenBMint: quoteMint, tokenAVault, tokenBVault,
    payerTokenA: ata(baseMint, admin.publicKey), payerTokenB: ata(quoteMint, admin.publicKey),
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: SystemProgram.programId, eventAuthority: DAMM_EVENT_AUTHORITY, program: damm.programId,
  }).instruction()
  w.must(w.send([openPool], [admin, nft]), 'open the DAMM v2 pool')

  const positionNftAccount = ata(nft.publicKey, liquidityAuthority, TOKEN_2022_PROGRAM_ID)
  const d = {
    name, admin, quoteMint, baseMint, dao, moderator, treasury, mintAuthority, liquidityAuthority,
    pool, position, nft: nft.publicKey, tokenAVault, tokenBVault, positionNftAccount,
    liquidityBase: ata(baseMint, liquidityAuthority), liquidityQuote: ata(quoteMint, liquidityAuthority),
  }
  d.init = async (bps = withdrawalBps) => fut.methods.initializeDao(name, pool, { damm: {} }, bps)
    .accountsStrict({ admin: admin.publicKey, dao, moderator, treasury, mintAuthority, liquidityAuthority, baseMint, quoteMint, systemProgram: SystemProgram.programId })
    .instruction()
  d.attach = async () => fut.methods.attachPosition()
    .accountsStrict({ admin: admin.publicKey, dao, liquidityAuthority, pool, position, positionNftAccount })
    .instruction()
  d.handOverPosition = () => w.must(w.send([
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, positionNftAccount, liquidityAuthority, nft.publicKey, TOKEN_2022_PROGRAM_ID),
    createTransferInstruction(derivePositionNftAccount(nft.publicKey), positionNftAccount, admin.publicKey, 1, [], TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, d.liquidityBase, liquidityAuthority, baseMint),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, d.liquidityQuote, liquidityAuthority, quoteMint),
  ], [admin]), 'hand the position NFT to the DAO')
  d.handOverMint = () => w.must(w.send([createSetAuthorityInstruction(baseMint, admin.publicKey, AuthorityType.MintTokens, mintAuthority)], [admin]), 'hand the mint to the DAO')
  return d
}

async function openDao(w, opts) {
  const d = await launchedDao(w, opts)
  d.handOverMint()
  w.must(w.send([await d.init()], [d.admin]), 'open the DAO')
  d.handOverPosition()
  w.must(w.send([await d.attach()], [d.admin]), 'attach the position')
  w.fund(d.quoteMint, d.treasury, 1_000n * UNIT)
  return d
}

const positionLiquidity = (w, d) => BigInt(w.decode(damm, 'position', d.position).unlockedLiquidity.toString())
const dammAccounts = (d) => ({
  pool: d.pool, position: d.position, tokenAVault: d.tokenAVault, tokenBVault: d.tokenBVault,
  positionNftAccount: d.positionNftAccount, eventAuthority: DAMM_EVENT_AUTHORITY, cpAmmProgram: damm.programId,
})

function proposalAddresses(d, id) {
  const proposal = pda(fut, ['proposal', d.moderator, u16(id)])
  const vaultPda = pda(vault, ['vault', proposal, u16(id)])
  const cmint = (type, i) => pda(vault, ['cmint', vaultPda, Buffer.from([type]), Buffer.from([i])])
  const option = (i) => {
    const condBase = cmint(0, i)
    const condQuote = cmint(1, i)
    const pool = pda(amm, ['pool', proposal, condQuote, condBase])
    return { condBase, condQuote, pool, reserveA: pda(amm, ['reserve', pool, condQuote]), reserveB: pda(amm, ['reserve', pool, condBase]), feeVault: pda(amm, ['fee_vault', pool]) }
  }
  return { id, proposal, vault: vaultPda, options: [option(0), option(1)], actions: (i) => pda(fut, ['actions', proposal, Buffer.from([i])]) }
}
const programs = { systemProgram: SystemProgram.programId, vaultProgram: vault.programId, ammProgram: amm.programId, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID }

async function createProposal(w, d, id) {
  const p = proposalAddresses(d, id)
  const [o0, o1] = p.options
  const ix = await fut.methods.initializeProposal({ length: 5, startingObservation: bn(500_000_000n), maxObservationDelta: bn(500_000_000n), warmupDuration: 0, marketBias: 0, fee: 50 }, null)
    .accountsStrict({ creator: d.admin.publicKey, moderator: d.moderator, dao: d.dao, proposal: p.proposal, ...programs })
    .remainingAccounts([
      meta(d.baseMint, false), meta(d.quoteMint, false), meta(p.vault), meta(ata(d.baseMint, p.vault)), meta(ata(d.quoteMint, p.vault)),
      meta(o0.condBase), meta(o1.condBase), meta(o0.condQuote), meta(o1.condQuote),
      meta(o0.pool), meta(o0.reserveA), meta(o0.reserveB), meta(FEE_AUTHORITY, false), meta(o0.feeVault),
      meta(o1.pool), meta(o1.reserveA), meta(o1.reserveB), meta(o1.feeVault),
    ]).instruction()
  w.must(w.send([ix], [d.admin]), 'initialize proposal')
  return p
}

const setActions = (d, p, optionIndex, actions, signer = d.admin) =>
  fut.methods.setOptionActions(optionIndex, actions)
    .accountsStrict({ creator: signer.publicKey, proposal: p.proposal, optionActions: p.actions(optionIndex), systemProgram: SystemProgram.programId })
    .instruction()

const prepare = async (d, p) => fut.methods.prepareProposalLiquidity()
  .accountsStrict({
    creator: d.admin.publicKey, proposal: p.proposal, moderator: d.moderator, dao: d.dao, liquidityAuthority: d.liquidityAuthority,
    liquidityBase: d.liquidityBase, liquidityQuote: d.liquidityQuote, poolAuthority: DAMM_POOL_AUTHORITY,
    tokenAMint: d.baseMint, tokenBMint: d.quoteMint, tokenProgram: TOKEN_PROGRAM_ID, ...dammAccounts(d),
  }).instruction()

async function launch(w, d, p) {
  const owner = d.liquidityAuthority
  const opts = p.options
  // The authority is a PDA with no lamports to pay rent, so its conditional token
  // accounts exist before the vault deposits into them.
  w.must(w.send(opts.flatMap((o) => [
    createAssociatedTokenAccountIdempotentInstruction(d.admin.publicKey, ata(o.condBase, owner), owner, o.condBase),
    createAssociatedTokenAccountIdempotentInstruction(d.admin.publicKey, ata(o.condQuote, owner), owner, o.condQuote),
  ]), [d.admin]), 'conditional accounts for the liquidity authority')
  const ix = await fut.methods.launchProposal()
    .accountsStrict({ creator: d.admin.publicKey, proposal: p.proposal, vault: p.vault, moderator: d.moderator, dao: d.dao, liquidityAuthority: owner, ...programs })
    .remainingAccounts([
      meta(d.baseMint, false), meta(d.quoteMint, false), meta(ata(d.baseMint, p.vault)), meta(ata(d.quoteMint, p.vault)),
      meta(ata(d.baseMint, owner)), meta(ata(d.quoteMint, owner)),
      ...opts.map((o) => meta(o.condBase)), ...opts.map((o) => meta(o.condQuote)),
      ...opts.map((o) => meta(ata(o.condBase, owner))), ...opts.map((o) => meta(ata(o.condQuote, owner))),
      ...opts.map((o) => meta(o.pool)), ...opts.map((o) => meta(o.reserveA)), ...opts.map((o) => meta(o.reserveB)),
    ]).instruction()
  return w.send([ix], [d.admin])
}

const crankAll = async (w, p) => {
  const ixs = await Promise.all(p.options.map((o) => amm.methods.crankTwap().accountsStrict({ pool: o.pool, reserveA: o.reserveA, reserveB: o.reserveB }).instruction()))
  w.must(w.send(ixs, [w.payer]), 'crank twap')
}
const finalize = async (w, p) => w.send([await fut.methods.finalizeProposal()
  .accountsStrict({ signer: w.payer.publicKey, proposal: p.proposal, vault: p.vault, vaultProgram: vault.programId, ammProgram: amm.programId })
  .remainingAccounts(p.options.flatMap((o) => [meta(o.pool), meta(o.reserveA, false), meta(o.reserveB, false)]))
  .instruction()], [w.payer])

async function redeem(w, d, p, winning, caller) {
  const owner = d.liquidityAuthority
  const o = p.options[winning]
  const ix = await fut.methods.redeemLiquidity()
    .accountsStrict({ payer: caller.publicKey, proposal: p.proposal, vault: p.vault, moderator: d.moderator, dao: d.dao, liquidityAuthority: owner, pool: o.pool, ...programs })
    .remainingAccounts([
      meta(o.reserveA), meta(o.reserveB), meta(ata(o.condQuote, owner)), meta(ata(o.condBase, owner)),
      meta(d.baseMint, false), meta(ata(d.baseMint, p.vault)), meta(ata(d.baseMint, owner)),
      ...p.options.flatMap((x) => [meta(x.condBase), meta(ata(x.condBase, owner))]),
      meta(d.quoteMint, false), meta(ata(d.quoteMint, p.vault)), meta(ata(d.quoteMint, owner)),
      ...p.options.flatMap((x) => [meta(x.condQuote), meta(ata(x.condQuote, owner))]),
    ]).instruction()
  return w.send([ix], [caller])
}

const returnLiquidity = async (d, caller) => fut.methods.returnLiquidity()
  .accountsStrict({
    payer: caller.publicKey, dao: d.dao, liquidityAuthority: d.liquidityAuthority, liquidityBase: d.liquidityBase, liquidityQuote: d.liquidityQuote,
    tokenAMint: d.baseMint, tokenBMint: d.quoteMint, tokenProgram: TOKEN_PROGRAM_ID, ...dammAccounts(d),
  }).instruction()

const claimFees = async (d, caller) => fut.methods.claimPoolFees()
  .accountsStrict({
    payer: caller.publicKey, dao: d.dao, liquidityAuthority: d.liquidityAuthority, treasury: d.treasury, protocol: FEE_AUTHORITY,
    baseMint: d.baseMint, quoteMint: d.quoteMint, liquidityBase: d.liquidityBase, liquidityQuote: d.liquidityQuote,
    treasuryBase: ata(d.baseMint, d.treasury), treasuryQuote: ata(d.quoteMint, d.treasury),
    protocolBase: ata(d.baseMint, FEE_AUTHORITY), protocolQuote: ata(d.quoteMint, FEE_AUTHORITY),
    poolAuthority: DAMM_POOL_AUTHORITY, ...dammAccounts(d),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()

const executeTransfer = async (w, d, p, optionIndex, actionIndex, { mint, recipient }) => fut.methods.executeTransfer(actionIndex)
  .accountsStrict({
    payer: w.payer.publicKey, proposal: p.proposal, moderator: d.moderator, dao: d.dao, optionActions: p.actions(optionIndex),
    treasury: d.treasury, mint, treasuryToken: ata(mint, d.treasury), recipient, recipientToken: ata(mint, recipient),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()
const executeMint = async (w, d, p, optionIndex, actionIndex, recipient) => fut.methods.executeMint(actionIndex)
  .accountsStrict({
    payer: w.payer.publicKey, proposal: p.proposal, moderator: d.moderator, dao: d.dao, optionActions: p.actions(optionIndex),
    mintAuthority: d.mintAuthority, mint: d.baseMint, recipient, recipientToken: ata(d.baseMint, recipient),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()

async function dammSwap(w, d, trader, quoteIn) {
  return w.send([
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(d.baseMint, trader.publicKey), trader.publicKey, d.baseMint),
    await damm.methods.swap2({ amount0: bn(quoteIn), amount1: bn(0), swapMode: 0 }).accountsStrict({
      poolAuthority: DAMM_POOL_AUTHORITY, pool: d.pool, inputTokenAccount: ata(d.quoteMint, trader.publicKey), outputTokenAccount: ata(d.baseMint, trader.publicKey),
      tokenAVault: d.tokenAVault, tokenBVault: d.tokenBVault, tokenAMint: d.baseMint, tokenBMint: d.quoteMint, payer: trader.publicKey,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, eventAuthority: DAMM_EVENT_AUTHORITY, program: damm.programId,
    }).instruction(),
  ], [trader])
}

const winner = (w, p) => {
  const { state } = w.decode(fut, 'proposalAccount', p.proposal)
  return state.resolved ? Number(Object.values(state.resolved)[0]) : null
}

test('a DAO is only opened over a token and a position it actually controls', async () => {
  const w = world()
  const d = await launchedDao(w)
  w.refused(w.send([await d.init()], [d.admin]), 'MintNotControlled', 'opening a DAO while the admin still holds the mint')
  d.handOverMint()
  w.refused(w.send([await d.init(0)], [d.admin]), 'InvalidWithdrawal', 'a withdrawal share of zero')
  w.refused(w.send([await d.init(10_000)], [d.admin]), 'InvalidWithdrawal', 'a withdrawal share of everything')
  w.must(w.send([await d.init()], [d.admin]), 'open the DAO')
  // The position NFT is still the admin's: the DAO does not get to call it its own.
  w.must(w.send([createAssociatedTokenAccountIdempotentInstruction(d.admin.publicKey, d.positionNftAccount, d.liquidityAuthority, d.nft, TOKEN_2022_PROGRAM_ID)], [d.admin]), 'empty nft account')
  w.refused(w.send([await d.attach()], [d.admin]), 'InvalidPosition', 'attaching a position the DAO does not hold')
  d.handOverPosition()
  w.must(w.send([await d.attach()], [d.admin]), 'attach the position')
  w.refused(w.send([await d.attach()], [d.admin]), 'PositionAlreadyAttached', 'attaching twice')
})

test('the pool funds a proposal, the winner runs on-chain, the liquidity goes home, and fees are split', async () => {
  const w = world()
  const d = await openDao(w)
  const startLiquidity = positionLiquidity(w, d)
  const stranger = w.person()
  const grantee = Keypair.generate().publicKey

  // ── proposal 0: option 1 pays a grantee and mints them tokens ──
  const p = await createProposal(w, d, 0)
  const actions = [
    { transfer: { mint: d.quoteMint, amount: bn(400n * UNIT), recipient: grantee } },
    { mintTo: { amount: bn(100_000n * UNIT), recipient: grantee } },
  ]
  w.refused(w.send([await setActions(d, p, 0, actions)], [d.admin]), 'NoActionsOnStatusQuo', 'actions on the status quo')
  w.refused(w.send([await setActions(d, p, 2, actions)], [d.admin]), 'InvalidOptionIndex', 'actions on a missing option')
  w.refused(w.send([await setActions(d, p, 1, actions, stranger)], [stranger]), 'Unauthorized', 'actions set by a stranger')
  w.must(w.send([await setActions(d, p, 1, actions)], [d.admin]), 'attach actions to option 1')

  w.refused(await launch(w, d, p), 'LiquidityNotPrepared', 'launching before the pool has funded the markets')
  w.must(w.send([await prepare(d, p)], [d.admin]), 'prepare: half the position comes out')
  const prepared = w.decode(fut, 'proposalAccount', p.proposal)
  const baseOut = BigInt(prepared.baseLiquidity.toString())
  const quoteOut = BigInt(prepared.quoteLiquidity.toString())
  assert.ok(baseOut > 3_999_000n * UNIT && baseOut <= 4_000_000n * UNIT, `about 4M tokens out, got ${baseOut / UNIT}`)
  assert.ok(quoteOut > 1_999n * UNIT && quoteOut <= 2_000n * UNIT, `about 2,000 quote out, got ${quoteOut / UNIT}`)
  assert.ok(positionLiquidity(w, d) <= startLiquidity / 2n + 1n, 'the position lost half its liquidity')
  w.refused(w.send([await prepare(d, p)], [d.admin]), 'LiquidityAlreadyPrepared', 'preparing twice')
  w.refused(w.send([await returnLiquidity(d, stranger)], [stranger]), 'ProposalAlreadyActive', 'pushing a proposal’s liquidity back into the pool')

  w.must(await launch(w, d, p), 'launch from the DAO’s liquidity')
  assert.equal(w.balance(d.liquidityBase), 0n, 'every prepared token went into the markets')
  assert.equal(w.balance(d.liquidityQuote), 0n)
  w.refused(w.send([await setActions(d, p, 1, [actions[0]])], [d.admin]), 'InvalidState', 'changing actions after launch')
  w.refused(w.send([await executeTransfer(w, d, p, 1, 0, { mint: d.quoteMint, recipient: grantee })], [w.payer]), 'ProposalNotResolved', 'executing before the market decides')
  // Nobody can pull a live market's liquidity: its provider is the DAO's PDA, not a person.
  const o1live = p.options[1]
  w.must(w.send([
    createAssociatedTokenAccountIdempotentInstruction(d.admin.publicKey, ata(o1live.condQuote, d.admin.publicKey), d.admin.publicKey, o1live.condQuote),
    createAssociatedTokenAccountIdempotentInstruction(d.admin.publicKey, ata(o1live.condBase, d.admin.publicKey), d.admin.publicKey, o1live.condBase),
  ], [d.admin]), 'admin conditional accounts')
  w.refused(w.send([await amm.methods.removeLiquidity(bn(UNIT), bn(UNIT)).accountsStrict({
    depositor: d.admin.publicKey, pool: o1live.pool, reserveA: o1live.reserveA, reserveB: o1live.reserveB,
    depositorTokenAccA: ata(o1live.condQuote, d.admin.publicKey), depositorTokenAccB: ata(o1live.condBase, d.admin.publicKey), tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction()], [d.admin]), null, 'the admin draining a live market')

  // A trader backs option 1.
  const trader = w.person()
  w.fund(d.quoteMint, trader.publicKey, 1_000n * UNIT)
  w.must(w.send([await vault.methods.deposit({ quote: {} }, bn(500n * UNIT))
    .accountsStrict({ signer: trader.publicKey, vault: p.vault, mint: d.quoteMint, vaultAta: ata(d.quoteMint, p.vault), userAta: ata(d.quoteMint, trader.publicKey), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .remainingAccounts(p.options.flatMap((o) => [meta(o.condQuote), meta(ata(o.condQuote, trader.publicKey))])).instruction()], [trader]), 'trader splits quote')
  const o1 = p.options[1]
  w.must(w.send([
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(o1.condBase, trader.publicKey), trader.publicKey, o1.condBase),
    await amm.methods.swap(true, bn(400n * UNIT), bn(0)).accountsStrict({ trader: trader.publicKey, pool: o1.pool, reserveA: o1.reserveA, reserveB: o1.reserveB, feeVault: o1.feeVault, traderAccountA: ata(o1.condQuote, trader.publicKey), traderAccountB: ata(o1.condBase, trader.publicKey), tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
  ], [trader]), 'trader buys option 1')

  for (let i = 0; i < 5; i++) { w.warp(61); await crankAll(w, p) }
  w.must(await finalize(w, p), 'finalize')
  assert.equal(winner(w, p), 1, 'option 1 won')

  w.refused(w.send([await executeTransfer(w, d, p, 1, 1, { mint: d.quoteMint, recipient: grantee })], [w.payer]), 'InvalidAction', 'running a mint action as a transfer')
  w.refused(w.send([await executeTransfer(w, d, p, 1, 0, { mint: d.quoteMint, recipient: stranger.publicKey })], [w.payer]), 'InvalidAction', 'redirecting a transfer')
  const supplyBefore = w.supply(d.baseMint)
  w.must(w.send([await executeTransfer(w, d, p, 1, 0, { mint: d.quoteMint, recipient: grantee })], [w.payer]), 'execute the transfer')
  w.must(w.send([await executeMint(w, d, p, 1, 1, grantee)], [w.payer]), 'execute the mint')
  w.refused(w.send([await executeMint(w, d, p, 1, 1, grantee)], [w.payer]), 'ActionAlreadyExecuted', 'minting twice')
  assert.equal(w.supply(d.baseMint), supplyBefore + 100_000n * UNIT, 'the supply grew by exactly the mint')
  assert.equal(w.balance(ata(d.quoteMint, d.treasury)), 600n * UNIT, 'the treasury paid exactly 400')
  w.refused(w.send([await executeTransfer(w, d, p, 1, 0, { mint: d.quoteMint, recipient: grantee })], [w.payer]), 'ActionAlreadyExecuted', 'paying twice')
  assert.equal(w.balance(ata(d.quoteMint, grantee)), 400n * UNIT)
  assert.equal(w.balance(ata(d.baseMint, grantee)), 100_000n * UNIT)

  // Anyone brings the markets' liquidity home and puts it back into the pool.
  w.must(await redeem(w, d, p, 1, stranger), 'a stranger redeems the markets’ liquidity')
  assert.equal(w.decode(fut, 'daoAccount', d.dao).activeProposal.toBase58(), PublicKey.default.toBase58(), 'the DAO is free for the next proposal')
  const homeBase = w.balance(d.liquidityBase)
  const homeQuote = w.balance(d.liquidityQuote)
  assert.ok(homeBase > 0n && homeQuote > 0n, 'the authority holds what came back')
  const beforeReturn = positionLiquidity(w, d)
  const poolPrice = BigInt(w.decode(damm, 'pool', d.pool).sqrtPrice.toString())
  w.must(w.send([await returnLiquidity(d, stranger)], [stranger]), 'a stranger returns it to the pool')
  // Exactly the liquidity our own arithmetic says those amounts fund at the pool's price —
  // DAMM v2 accepted the program's figure to the unit.
  assert.equal(positionLiquidity(w, d) - beforeReturn, liquidityFor(homeBase, homeQuote, poolPrice), 'returned liquidity matches src/liquidity.rs')
  assert.ok(w.balance(d.liquidityBase) < homeBase / 1000n || w.balance(d.liquidityQuote) < homeQuote / 1000n, 'one side went back entirely')
  // Less than it started with, and rightly: the trader who backed the winner took some of
  // the markets' tokens home. What is left over waits with the authority for next time.
  const afterReturn = positionLiquidity(w, d)
  assert.ok(afterReturn > startLiquidity * 85n / 100n && afterReturn < startLiquidity, `the position is mostly whole again: ${afterReturn * 1000n / startLiquidity / 10n}%`)

  // ── the pool trades; the fees are the DAO's and LFOwn's, half each ──
  const swapper = w.person()
  w.fund(d.quoteMint, swapper.publicKey, 5_000n * UNIT)
  for (let i = 0; i < 3; i++) w.must(await dammSwap(w, d, swapper, 1_000n * UNIT), 'someone trades on the pool')
  const treasuryBefore = w.balance(ata(d.quoteMint, d.treasury))
  const protocolBefore = w.balance(ata(d.quoteMint, FEE_AUTHORITY))
  w.must(w.send([await claimFees(d, stranger)], [stranger]), 'a stranger claims the pool fees')
  const toTreasury = w.balance(ata(d.quoteMint, d.treasury)) - treasuryBefore
  const toProtocol = w.balance(ata(d.quoteMint, FEE_AUTHORITY)) - protocolBefore
  assert.ok(toProtocol > 0n, 'LFOwn was paid')
  assert.ok(toTreasury - toProtocol <= 1n && toTreasury >= toProtocol, `split 50/50: treasury ${toTreasury}, LFOwn ${toProtocol}`)
  assert.ok(toTreasury + toProtocol > 20n * UNIT, `roughly 1% of 3,000 traded, less Meteora's cut: ${toTreasury + toProtocol}`)

  // ── proposal 1, on the returned liquidity: nobody trades, the status quo wins ──
  const q = await createProposal(w, d, 1)
  w.must(w.send([await setActions(d, q, 1, [{ transfer: { mint: d.quoteMint, amount: bn(1n * UNIT), recipient: grantee } }])], [d.admin]), 'actions for proposal 1')
  w.must(w.send([await prepare(d, q)], [d.admin]), 'prepare proposal 1')
  w.must(await launch(w, d, q), 'launch proposal 1')
  for (let i = 0; i < 5; i++) { w.warp(61); await crankAll(w, q) }
  w.must(await finalize(w, q), 'finalize proposal 1')
  assert.equal(winner(w, q), 0, 'the status quo won')
  w.refused(w.send([await executeTransfer(w, d, q, 1, 0, { mint: d.quoteMint, recipient: grantee })], [w.payer]), 'OptionDidNotWin', "a losing option's transfer")
  w.must(await redeem(w, d, q, 0, stranger), 'redeem proposal 1')
  w.must(w.send([await returnLiquidity(d, stranger)], [stranger]), 'return proposal 1’s liquidity')
})
