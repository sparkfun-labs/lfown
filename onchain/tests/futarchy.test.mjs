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
const raiseP = new anchor.Program(idl('lfown_raise'), provider)
const FEE_AUTHORITY = new PublicKey(idl('amm').constants.find((c) => c.name === 'FEE_AUTHORITY').value)
const DAMM_POOL_AUTHORITY = new PublicKey('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC')
const DAMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], damm.programId)[0]
const MIN_SQRT = 4_295_048_016n
const MAX_SQRT = 79_226_673_521_066_979_257_578_248_091n

const UNIT = 1_000_000n
/** A DAO's governance, as the tests run it: five-minute markets, no warmup, no margin. */
const GOV = { proposalLengthMinutes: 5, warmupSeconds: 0, marketBiasBps: 0, maxObservationChangeBps: 10_000, marketFeeBps: 50, proposalStake: new anchor.BN(0) }
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
  for (const [p, file] of [[fut, '../target/deploy/futarchy.so'], [amm, '../target/deploy/amm.so'], [vault, '../target/deploy/vault.so'], [raiseP, '../target/deploy/lfown_raise.so'], [damm, 'fixtures/cp_amm.so']]) {
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
async function launchedDao(w, { name = 'lfown-test', withdrawalBps = 5_000, gov = GOV } = {}) {
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
  d.init = async (bps = withdrawalBps) => fut.methods.initializeDao(name, pool, { damm: {} }, bps, gov)
    .accountsStrict({ admin: admin.publicKey, dao, moderator, treasury, mintAuthority, liquidityAuthority, baseMint, quoteMint, systemProgram: SystemProgram.programId })
    .instruction()
  d.record = async () => fut.methods.recordPrice().accountsStrict({ dao, pool }).instruction()
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
  // The price guard needs a checkpoint a minute old before any liquidity moves.
  w.must(w.send([await d.record()], [d.admin]), 'record the pool price')
  w.warp(61)
  return d
}

/** A fresh checkpoint at today's pool price, usable a minute later. */
async function recheck(w, d) {
  w.warp(300)
  w.must(w.send([await d.record()], [w.payer]), 'record the pool price')
  w.warp(61)
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

const proposeIx = async (d, p, creator) => {
  const [o0, o1] = p.options
  return fut.methods.initializeProposal(null)
    .accountsStrict({
      creator: creator.publicKey, moderator: d.moderator, dao: d.dao, proposal: p.proposal,
      pool: d.pool, tokenMint: d.baseMint, creatorToken: ata(d.baseMint, creator.publicKey), stakeEscrow: pda(fut, ['stake', p.proposal]),
      ...programs,
    })
    .remainingAccounts([
      meta(d.baseMint, false), meta(d.quoteMint, false), meta(p.vault), meta(ata(d.baseMint, p.vault)), meta(ata(d.quoteMint, p.vault)),
      meta(o0.condBase), meta(o1.condBase), meta(o0.condQuote), meta(o1.condQuote),
      meta(o0.pool), meta(o0.reserveA), meta(o0.reserveB), meta(FEE_AUTHORITY, false), meta(o0.feeVault),
      meta(o1.pool), meta(o1.reserveA), meta(o1.reserveB), meta(o1.feeVault),
    ]).instruction()
}

/** Proposes as `creator` (the admin by default), who needs a DAO-token account for the stake. */
async function tryPropose(w, d, id, creator = d.admin) {
  const p = proposalAddresses(d, id)
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, ata(d.baseMint, creator.publicKey), creator.publicKey, d.baseMint),
    await proposeIx(d, p, creator),
  ]
  return { p, result: w.send(ixs, [creator]) }
}
async function createProposal(w, d, id, creator = d.admin) {
  const { p, result } = await tryPropose(w, d, id, creator)
  w.must(result, 'initialize proposal')
  return p
}

const setActions = (d, p, optionIndex, actions, signer = d.admin) =>
  fut.methods.setOptionActions(optionIndex, actions)
    .accountsStrict({ creator: signer.publicKey, proposal: p.proposal, optionActions: p.actions(optionIndex), systemProgram: SystemProgram.programId })
    .instruction()

const prepare = async (d, p, creator = d.admin) => fut.methods.prepareProposalLiquidity()
  .accountsStrict({
    creator: creator.publicKey, proposal: p.proposal, moderator: d.moderator, dao: d.dao, liquidityAuthority: d.liquidityAuthority,
    liquidityBase: d.liquidityBase, liquidityQuote: d.liquidityQuote, poolAuthority: DAMM_POOL_AUTHORITY,
    tokenAMint: d.baseMint, tokenBMint: d.quoteMint, tokenProgram: TOKEN_PROGRAM_ID, ...dammAccounts(d),
  }).instruction()

async function launch(w, d, p, payer = d.admin) {
  const owner = d.liquidityAuthority
  const opts = p.options
  // The authority is a PDA with no lamports to pay rent, so its conditional token
  // accounts exist before the vault deposits into them.
  w.must(w.send(opts.flatMap((o) => [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(o.condBase, owner), owner, o.condBase),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(o.condQuote, owner), owner, o.condQuote),
  ]), [payer]), 'conditional accounts for the liquidity authority')
  const ix = await fut.methods.launchProposal()
    .accountsStrict({ payer: payer.publicKey, proposal: p.proposal, vault: p.vault, moderator: d.moderator, dao: d.dao, liquidityAuthority: owner, ...programs })
    .remainingAccounts([
      meta(d.baseMint, false), meta(d.quoteMint, false), meta(ata(d.baseMint, p.vault)), meta(ata(d.quoteMint, p.vault)),
      meta(ata(d.baseMint, owner)), meta(ata(d.quoteMint, owner)),
      ...opts.map((o) => meta(o.condBase)), ...opts.map((o) => meta(o.condQuote)),
      ...opts.map((o) => meta(ata(o.condBase, owner))), ...opts.map((o) => meta(ata(o.condQuote, owner))),
      ...opts.map((o) => meta(o.pool)), ...opts.map((o) => meta(o.reserveA)), ...opts.map((o) => meta(o.reserveB)),
    ]).instruction()
  return w.send([ix], [payer])
}

const returnStake = async (d, p, caller, creator) => fut.methods.returnStake()
  .accountsStrict({
    payer: caller.publicKey, proposal: p.proposal, stakeEscrow: pda(fut, ['stake', p.proposal]), creator,
    tokenMint: d.baseMint, creatorToken: ata(d.baseMint, creator),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()

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

/** A buy on the DAO's own pool, `quoteIn` of the coin for the DAO's token. */
const dammSwapIxs = async (d, trader, quoteIn) => [
  createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(d.baseMint, trader.publicKey), trader.publicKey, d.baseMint),
  await damm.methods.swap2({ amount0: bn(quoteIn), amount1: bn(0), swapMode: 0 }).accountsStrict({
    poolAuthority: DAMM_POOL_AUTHORITY, pool: d.pool, inputTokenAccount: ata(d.quoteMint, trader.publicKey), outputTokenAccount: ata(d.baseMint, trader.publicKey),
    tokenAVault: d.tokenAVault, tokenBVault: d.tokenBVault, tokenAMint: d.baseMint, tokenBMint: d.quoteMint, payer: trader.publicKey,
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, eventAuthority: DAMM_EVENT_AUTHORITY, program: damm.programId,
  }).instruction(),
]
const dammSwap = async (w, d, trader, quoteIn) => w.send(await dammSwapIxs(d, trader, quoteIn), [trader])

/** DAO tokens from the admin's own holdings: the mint belongs to the DAO by now. */
const give = (w, d, to, amount) => w.must(w.send([
  createAssociatedTokenAccountIdempotentInstruction(d.admin.publicKey, ata(d.baseMint, to), to, d.baseMint),
  createTransferInstruction(ata(d.baseMint, d.admin.publicKey), ata(d.baseMint, to), d.admin.publicKey, amount),
], [d.admin]), 'give DAO tokens')

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
  // The swaps above moved the pool far past the checkpoint: nothing moves until a new
  // price has been recorded and has held for a minute.
  w.refused((await tryPropose(w, d, 1)).result, 'PriceMovedTooFar', 'proposing at a price far from the checkpoint')
  await recheck(w, d)
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

test('a settled raise becomes a DAO with its own pool in one transaction, and no key holds anything in between', async () => {
  const w = world()
  const authority = w.payer
  const name = 'bootstrapped'
  const coin = w.createMint(authority.publicKey) // stand-in for the ownership coin
  const dao = pda(fut, ['dao', name])
  const treasury = pda(fut, ['treasury', dao])
  const liquidityAuthority = pda(fut, ['liquidity', dao])

  // The raise pays this DAO's PDAs directly: no pool operator in the middle.
  const baseKp = Keypair.generate()
  const baseMint = baseKp.publicKey
  const raise = pda(raiseP, ['raise', baseMint])
  w.must(w.send([
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: baseMint, lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(baseMint, 6, raise, null),
    await raiseP.methods.initializeRaise({
      goal: bn(1_000n * UNIT), tokensForInvestors: bn(10_000_000n * UNIT), tokensForPool: bn(8_000_000n * UNIT),
      quoteToPool: bn(800n * UNIT), durationSeconds: bn(60), claimDelaySeconds: bn(86_400),
    }).accountsStrict({
      baseMint, quoteMint: coin, raise, baseVault: ata(baseMint, raise), quoteVault: ata(coin, raise),
      treasury, poolOperator: liquidityAuthority, authority: authority.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction(),
  ], [authority, baseKp]), 'open the raise for this DAO')

  const commitment = (user) => pda(raiseP, ['commitment', raise, user])
  const alice = w.person()
  const bob = w.person()
  w.fund(coin, alice.publicKey, 1_200n * UNIT)
  w.fund(coin, bob.publicKey, 800n * UNIT)
  for (const [who, amount] of [[alice, 1_200n], [bob, 800n]]) {
    w.must(w.send([await raiseP.methods.commit(bn(amount * UNIT)).accountsStrict({
      raise, commitment: commitment(who.publicKey), userQuote: ata(coin, who.publicKey), quoteVault: ata(coin, raise),
      user: who.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction()], [who]), 'commit')
  }

  const nftMint = (daoKey) => pda(fut, ['position_nft', daoKey])
  const bootstrap = async (signer, daoName = name) => {
    const d = pda(fut, ['dao', daoName])
    const mint = nftMint(d)
    const pool = deriveCustomizablePoolAddress(baseMint, coin)
    return fut.methods.bootstrapDao(daoName, 5_000, GOV).accountsStrict({
      authority: signer.publicKey, raise, dao: d, moderator: pda(fut, ['moderator', daoName]),
      treasury: pda(fut, ['treasury', d]), mintAuthority: pda(fut, ['mint_authority', d]), liquidityAuthority: pda(fut, ['liquidity', d]),
      baseMint, quoteMint: coin, liquidityBase: ata(baseMint, pda(fut, ['liquidity', d])), liquidityQuote: ata(coin, pda(fut, ['liquidity', d])),
      positionNftMint: mint, positionNftAccount: derivePositionNftAccount(mint), poolAuthority: DAMM_POOL_AUTHORITY, pool,
      position: derivePositionAddress(mint), tokenAVault: deriveTokenVaultAddress(baseMint, pool), tokenBVault: deriveTokenVaultAddress(coin, pool),
      eventAuthority: DAMM_EVENT_AUTHORITY, cpAmmProgram: damm.programId, raiseProgram: raiseP.programId,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction()
  }

  // Before settle the pool share is still in the raise, and its accounts do not exist yet.
  w.refused(w.send([await bootstrap(authority)], [authority]), null, 'bootstrapping before the raise has settled')
  w.warp(61)
  w.must(w.send([await raiseP.methods.settle().accountsStrict({
    raise, baseMint, quoteMint: coin, baseVault: ata(baseMint, raise), quoteVault: ata(coin, raise),
    treasury, treasuryQuote: ata(coin, treasury), poolOperator: liquidityAuthority,
    operatorQuote: ata(coin, liquidityAuthority), operatorBase: ata(baseMint, liquidityAuthority),
    cranker: authority.publicKey, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()], [authority]), 'settle')
  assert.equal(w.balance(ata(coin, treasury)), 200n * UNIT, 'the DAO treasury was paid directly')
  assert.equal(w.balance(ata(coin, liquidityAuthority)), 800n * UNIT, 'the DAO liquidity authority holds the pool share')

  const stranger = w.person()
  w.refused(w.send([await bootstrap(stranger)], [stranger]), 'Unauthorized', 'a stranger bootstrapping the DAO')
  // A DAO under another name has other PDAs. Give its liquidity authority token accounts so
  // the refusal comes from the rule itself, not from a missing account.
  const otherLiquidity = pda(fut, ['liquidity', pda(fut, ['dao', 'someone-else'])])
  w.must(w.send([
    createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata(baseMint, otherLiquidity), otherLiquidity, baseMint),
    createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata(coin, otherLiquidity), otherLiquidity, coin),
  ], [authority]), 'token accounts for the other DAO')
  w.refused(w.send([await bootstrap(authority, 'someone-else')], [authority]), 'RaiseNotForThisDao', 'bootstrapping a DAO the raise did not pay')

  w.must(w.send([await bootstrap(authority)], [authority]), 'bootstrap the DAO, its pool and its position')

  const daoAccount = w.decode(fut, 'daoAccount', dao)
  const mint = nftMint(dao)
  const pool = deriveCustomizablePoolAddress(baseMint, coin)
  const position = derivePositionAddress(mint)
  assert.equal(daoAccount.pool.toBase58(), pool.toBase58())
  assert.equal(daoAccount.position.toBase58(), position.toBase58())
  const mintState = MintLayout.decode(Buffer.from(w.svm.getAccount(baseMint).data))
  assert.equal(new PublicKey(mintState.mintAuthority).toBase58(), pda(fut, ['mint_authority', dao]).toBase58(), 'the DAO holds the mint')
  const nftHolder = AccountLayout.decode(Buffer.from(w.svm.getAccount(derivePositionNftAccount(mint)).data).subarray(0, AccountLayout.span))
  assert.equal(new PublicKey(nftHolder.owner).toBase58(), liquidityAuthority.toBase58(), 'the DAO holds the position NFT')
  const poolState = w.decode(damm, 'pool', pool)
  const price = Number(BigInt(poolState.sqrtPrice.toString())) / 2 ** 64
  assert.ok(Math.abs(price * price / 0.0001 - 1) < 1e-6, `the pool opened at the raise price: ${price * price}`)
  const leftBase = w.balance(ata(baseMint, liquidityAuthority))
  const leftCoin = w.balance(ata(coin, liquidityAuthority))
  // Only rounding dust stays behind: the floor of the square-root price leaves a few base
  // units of one side (18 of the coin when measured), never a meaningful amount.
  assert.ok(leftBase < 1_000n && leftCoin < 1_000n, `everything went into the pool, bar dust: ${leftBase} tokens, ${leftCoin} coin units`)
  w.refused(w.send([await bootstrap(authority)], [authority]), null, 'bootstrapping twice')

  // Claims opened with the pool: a backer does not wait out the delay.
  w.must(w.send([await raiseP.methods.claim().accountsStrict({
    raise, commitment: commitment(alice.publicKey), baseMint, quoteMint: coin, baseVault: ata(baseMint, raise), quoteVault: ata(coin, raise),
    userBase: ata(baseMint, alice.publicKey), userQuote: ata(coin, alice.publicKey), user: alice.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()], [alice]), 'alice claims at once')
  assert.equal(w.balance(ata(baseMint, alice.publicKey)), 6_000_000n * UNIT)
  assert.equal(w.balance(ata(coin, alice.publicKey)), 600n * UNIT)

  // And the DAO is live: its first proposal takes its share of the new pool.
  const d = {
    name, admin: authority, quoteMint: coin, baseMint, dao, moderator: pda(fut, ['moderator', name]), treasury,
    mintAuthority: pda(fut, ['mint_authority', dao]), liquidityAuthority, pool, position,
    tokenAVault: deriveTokenVaultAddress(baseMint, pool), tokenBVault: deriveTokenVaultAddress(coin, pool),
    positionNftAccount: derivePositionNftAccount(mint),
    liquidityBase: ata(baseMint, liquidityAuthority), liquidityQuote: ata(coin, liquidityAuthority),
  }
  // The bootstrap recorded the raise price as the first checkpoint; it is usable after a minute.
  w.refused((await tryPropose(w, d, 0)).result, 'NoPriceCheckpoint', 'proposing in the bootstrap’s own minute')
  w.warp(61)
  const p = await createProposal(w, d, 0)
  const opened = w.decode(fut, 'proposalAccount', p.proposal).config
  // 800 coins for 8M tokens is 10⁻⁴, or 10⁸ in the amm's 10¹² scale — less one unit for
  // the pool's square root, which is rounded down.
  const startObs = BigInt(opened.startingObservation.toString())
  assert.ok(startObs >= 99_999_999n && startObs <= 100_000_000n, `the markets open at the raise price: ${startObs}`)
  assert.equal(opened.length, GOV.proposalLengthMinutes, 'the length is the DAO’s, not the proposer’s')
  w.must(w.send([await prepare(d, p)], [authority]), 'the bootstrapped DAO funds its first proposal from its pool')
  const prepared = w.decode(fut, 'proposalAccount', p.proposal)
  assert.ok(BigInt(prepared.baseLiquidity.toString()) > 3_999_000n * UNIT, 'half the 8M tokens came out')
  assert.ok(BigInt(prepared.quoteLiquidity.toString()) > 399n * UNIT, 'and half the 800 coins')
})

test('the price guard: no sandwich moves the DAO’s liquidity, and a new price has to hold for a minute', async () => {
  const w = world()
  const d = await openDao(w)
  const attacker = w.person()
  w.fund(d.quoteMint, attacker.publicKey, 10_000n * UNIT)
  w.refused(w.send([await d.record()], [attacker]), 'CheckpointTooRecent', 'refreshing a checkpoint in its first five minutes')

  // A whole proposal, so the DAO has liquidity waiting to go back into its pool.
  const p = await createProposal(w, d, 0)
  w.must(w.send([await prepare(d, p)], [d.admin]), 'prepare')
  w.must(await launch(w, d, p), 'launch')
  for (let i = 0; i < 5; i++) { w.warp(61); await crankAll(w, p) }
  w.must(await finalize(w, p), 'finalize')
  w.must(await redeem(w, d, p, winner(w, p), attacker), 'redeem')

  // The sandwich return_liquidity used to allow, since anyone may call it: push the price,
  // make the DAO deposit at it, all in one transaction.
  const before = positionLiquidity(w, d)
  w.refused(w.send([...(await dammSwapIxs(d, attacker, 1_000n * UNIT)), await returnLiquidity(d, attacker)], [attacker]), 'PriceMovedTooFar', 'the DAO depositing inside a price push')
  assert.equal(positionLiquidity(w, d), before, 'nothing moved')
  w.must(w.send([await returnLiquidity(d, attacker)], [attacker]), 'at the recorded price, it goes back')

  // Pushing the price and keeping it there: no new proposal opens at it at first…
  w.must(await dammSwap(w, d, attacker, 1_000n * UNIT), 'the price is pushed, and held')
  w.refused((await tryPropose(w, d, 1)).result, 'PriceMovedTooFar', 'opening markets at a pushed price')
  w.must(w.send([await d.record()], [attacker]), 'the pushed price is recorded')
  w.refused((await tryPropose(w, d, 1)).result, 'NoPriceCheckpoint', 'using a checkpoint in its first minute')
  // …but a price that has held for a minute is the price: the guard cannot freeze a DAO
  // whose token has really moved. (Holding it costs, on a real pool, every arbitrageur.)
  w.warp(61)
  const q = await createProposal(w, d, 1)
  const expected = (() => { const s = BigInt(w.decode(damm, 'pool', d.pool).sqrtPrice.toString()); return (s * s * 1_000_000_000_000n) >> 128n })()
  assert.equal(BigInt(w.decode(fut, 'proposalAccount', q.proposal).config.startingObservation.toString()), expected, 'the markets open at the pool’s price')

  // A checkpoint goes stale after half an hour, and a fresh one unblocks.
  w.warp(1_800)
  w.refused(w.send([await prepare(d, q)], [d.admin]), 'NoPriceCheckpoint', 'moving liquidity on a stale checkpoint')
  await recheck(w, d)
  w.must(w.send([await prepare(d, q)], [d.admin]), 'a fresh checkpoint lets it through')
})

test('anyone may propose against a stake, gets it back once the market decides, and anyone launches what is prepared', async () => {
  const w = world()
  const STAKE = 50_000n * UNIT
  const d = await openDao(w, { name: 'staked', gov: { ...GOV, proposalStake: bn(STAKE) } })
  const proposer = w.person()
  const stranger = w.person()

  give(w, d, proposer.publicKey, 10_000n * UNIT)
  w.refused((await tryPropose(w, d, 0, proposer)).result, 'InsufficientStake', 'proposing without the stake')
  give(w, d, proposer.publicKey, 90_000n * UNIT)
  const p = await createProposal(w, d, 0, proposer)
  assert.equal(w.balance(ata(d.baseMint, proposer.publicKey)), 50_000n * UNIT, 'the stake left the proposer')
  assert.equal(w.balance(pda(fut, ['stake', p.proposal])), STAKE, 'and sits with the proposal')
  assert.equal(BigInt(w.decode(fut, 'proposalAccount', p.proposal).stake.toString()), STAKE)

  w.refused(w.send([await returnStake(d, p, stranger, proposer.publicKey)], [stranger]), 'ProposalNotResolved', 'taking the stake back mid-vote')
  w.refused(w.send([await setActions(d, p, 1, [{ transfer: { mint: d.quoteMint, amount: bn(UNIT), recipient: stranger.publicKey } }], stranger)], [stranger]), 'Unauthorized', 'a stranger writing someone else’s options')
  w.must(w.send([await setActions(d, p, 1, [{ transfer: { mint: d.quoteMint, amount: bn(UNIT), recipient: proposer.publicKey } }], proposer)], [proposer]), 'the proposer writes option 1')
  w.refused(w.send([await prepare(d, p, stranger)], [stranger]), 'Unauthorized', 'a stranger taking the liquidity out for someone else’s proposal')
  w.must(w.send([await prepare(d, p, proposer)], [proposer]), 'the proposer prepares: the options are final')
  w.refused(w.send([await setActions(d, p, 1, [{ transfer: { mint: d.quoteMint, amount: bn(2n * UNIT), recipient: proposer.publicKey } }], proposer)], [proposer]), 'LiquidityAlreadyPrepared', 'rewriting an option once the liquidity is out')

  // The proposer walks away with the DAO's liquidity outside its pool; anyone can carry on.
  w.must(await launch(w, d, p, stranger), 'a stranger launches the prepared proposal')
  for (let i = 0; i < 5; i++) { w.warp(61); await crankAll(w, p) }
  w.must(await finalize(w, p), 'finalize')

  w.refused(w.send([await returnStake(d, p, stranger, stranger.publicKey)], [stranger]), 'Unauthorized', 'returning the stake to someone else')
  w.must(w.send([await returnStake(d, p, stranger, proposer.publicKey)], [stranger]), 'anyone returns the stake to the proposer')
  assert.equal(w.balance(ata(d.baseMint, proposer.publicKey)), 100_000n * UNIT, 'the proposer has all of it back')
  assert.equal(w.svm.getAccount(pda(fut, ['stake', p.proposal])), null, 'the escrow is closed')
  w.refused(w.send([await returnStake(d, p, stranger, proposer.publicKey)], [stranger]), null, 'returning it twice')
})
