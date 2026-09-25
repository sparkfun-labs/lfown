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
import { createHash } from 'node:crypto'
import { LiteSVM, Clock, FailedTransactionMetadata } from 'litesvm'
import anchor from '@coral-xyz/anchor'
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js'
import {
  ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, AccountLayout, AuthorityType, MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeAccount3Instruction, createInitializeMint2Instruction,
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
/** What a raise commits to: sha256(name ‖ withdrawal bps, u16 LE ‖ governance, borsh). */
const daoCommitment = (name, bps, gov) => [...createHash('sha256').update(Buffer.concat([
  Buffer.from(name), Buffer.from([bps & 0xff, bps >> 8]), fut.coder.types.encode('governanceConfig', gov),
])).digest()]
/** A DAO's governance, as the tests run it: five-minute markets, no warmup, no margin. */
const GOV = {
  proposalLengthMinutes: 5, warmupSeconds: 0, marketBiasBps: 0, maxObservationChangeBps: 10_000, marketFeeBps: 50, proposalStake: new anchor.BN(0),
  maxTransferBps: 5_000, maxMintBps: 1_000, executionDelaySeconds: 0, executionWindowSeconds: 3_600, failedStakeSlashBps: 2_000,
}
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

  // A DAO is found by its token's mint, never by a name anyone could type.
  const dao = pda(fut, ['dao', baseMint])
  const moderator = pda(fut, ['moderator', baseMint])
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

/**
 * Walks the checkpoint to today's pool price, a minute and at most 1% at a time — as the
 * keeper does after a real move. Returns how many updates it took.
 */
async function followPrice(w, d) {
  for (let i = 1; i <= 400; i++) {
    w.warp(61)
    w.must(w.send([await d.record()], [w.payer]), 'record the pool price')
    const spot = BigInt(w.decode(damm, 'pool', d.pool).sqrtPrice.toString())
    const check = BigInt(w.decode(fut, 'daoAccount', d.dao).priceCheckpoint.toString())
    if ((spot > check ? spot - check : check - spot) * 1_000n < check) return i
  }
  throw new Error('the checkpoint never caught up')
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
    payer: caller.publicKey, proposal: p.proposal, stakeEscrow: pda(fut, ['stake', p.proposal]),
    dao: d.dao, treasury: d.treasury, treasuryToken: ata(d.baseMint, d.treasury), creator,
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
  const steps = await followPrice(w, d)
  assert.ok(steps > 50, `a 3x move takes the checkpoint many minutes to follow: ${steps}`)
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


// ── raises that become DAOs ─────────────────────────────────────────────────

/** A raise on a fresh token, committed to the DAO `name`/`bps`/`gov` its mint derives. */
async function raiseFor(w, { name = 'fair', claimDelay = 86_400, gov = GOV, bps = 5_000 } = {}) {
  const authority = w.payer
  const coin = w.createMint(authority.publicKey) // stands in for the ownership coin
  const baseKp = Keypair.generate()
  const baseMint = baseKp.publicKey
  const raise = pda(raiseP, ['raise', baseMint])
  const dao = pda(fut, ['dao', baseMint])
  const treasury = pda(fut, ['treasury', dao])
  const liquidityAuthority = pda(fut, ['liquidity', dao])
  const tokenPrograms = { tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }
  w.must(w.send([
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: baseMint, lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(baseMint, 6, raise, null),
    await raiseP.methods.initializeRaise({
      goal: bn(1_000n * UNIT), tokensForInvestors: bn(10_000_000n * UNIT), tokensForPool: bn(8_000_000n * UNIT),
      quoteToPool: bn(800n * UNIT), durationSeconds: bn(60), claimDelaySeconds: bn(claimDelay),
      daoCommitment: daoCommitment(name, bps, gov),
    }).accountsStrict({
      baseMint, quoteMint: coin, raise, baseVault: ata(baseMint, raise), quoteVault: ata(coin, raise),
      treasury, poolOperator: liquidityAuthority, authority: authority.publicKey, ...tokenPrograms,
    }).instruction(),
  ], [authority, baseKp]), 'open the raise')

  const commitment = (user) => pda(raiseP, ['commitment', raise, user])
  const commit = async (who, amount) => w.send([await raiseP.methods.commit(bn(amount)).accountsStrict({
    raise, commitment: commitment(who.publicKey), userQuote: ata(coin, who.publicKey), quoteVault: ata(coin, raise),
    user: who.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()], [who])
  const settle = async (cranker) => w.send([await raiseP.methods.settle().accountsStrict({
    raise, baseMint, quoteMint: coin, baseVault: ata(baseMint, raise), quoteVault: ata(coin, raise),
    treasury, treasuryQuote: ata(coin, treasury), poolOperator: liquidityAuthority,
    operatorQuote: ata(coin, liquidityAuthority), operatorBase: ata(baseMint, liquidityAuthority), cranker: cranker.publicKey, ...tokenPrograms,
  }).instruction()], [cranker])
  const claim = async (signer, owner = signer.publicKey) => w.send([await raiseP.methods.claim().accountsStrict({
    raise, commitment: commitment(owner), baseMint, quoteMint: coin, baseVault: ata(baseMint, raise), quoteVault: ata(coin, raise),
    userBase: ata(baseMint, signer.publicKey), userQuote: ata(coin, signer.publicKey), user: signer.publicKey, ...tokenPrograms,
  }).instruction()], [signer])

  const nftMint = pda(fut, ['position_nft', dao])
  const pool = deriveCustomizablePoolAddress(baseMint, coin)
  const bootstrap = async (signer, { daoName = name, withdrawal = bps, governance = gov, liquidityBase, liquidityQuote } = {}) => w.send([
    await fut.methods.bootstrapDao(daoName, withdrawal, governance).accountsStrict({
      payer: signer.publicKey, raise, dao, moderator: pda(fut, ['moderator', baseMint]),
      treasury, mintAuthority: pda(fut, ['mint_authority', dao]), liquidityAuthority,
      baseMint, quoteMint: coin, baseVault: ata(baseMint, raise), quoteVault: ata(coin, raise), treasuryQuote: ata(coin, treasury),
      liquidityBase: liquidityBase ?? ata(baseMint, liquidityAuthority), liquidityQuote: liquidityQuote ?? ata(coin, liquidityAuthority),
      positionNftMint: nftMint, positionNftAccount: derivePositionNftAccount(nftMint), poolAuthority: DAMM_POOL_AUTHORITY, pool,
      position: derivePositionAddress(nftMint), tokenAVault: deriveTokenVaultAddress(baseMint, pool), tokenBVault: deriveTokenVaultAddress(coin, pool),
      eventAuthority: DAMM_EVENT_AUTHORITY, cpAmmProgram: damm.programId, raiseProgram: raiseP.programId,
      token2022Program: TOKEN_2022_PROGRAM_ID, ...tokenPrograms,
    }).instruction(),
  ], [signer])

  // The DAO as the other helpers see it.
  const d = {
    name, admin: authority, quoteMint: coin, baseMint, dao, moderator: pda(fut, ['moderator', baseMint]), treasury,
    mintAuthority: pda(fut, ['mint_authority', dao]), liquidityAuthority, pool, position: derivePositionAddress(nftMint),
    tokenAVault: deriveTokenVaultAddress(baseMint, pool), tokenBVault: deriveTokenVaultAddress(coin, pool),
    positionNftAccount: derivePositionNftAccount(nftMint), liquidityBase: ata(baseMint, liquidityAuthority), liquidityQuote: ata(coin, liquidityAuthority),
  }
  d.record = async () => fut.methods.recordPrice().accountsStrict({ dao, pool }).instruction()
  return { authority, coin, baseMint, raise, dao, treasury, liquidityAuthority, commit, settle, claim, bootstrap, d, commitment, nftMint, pool }
}

test('a raise becomes its DAO and its pool in one instruction: anyone may open it, only as committed', async () => {
  const w = world()
  const r = await raiseFor(w, { name: 'bootstrapped' })
  const [alice, bob, stranger, mallory] = [w.person(), w.person(), w.person(), w.person()]
  w.fund(r.coin, alice.publicKey, 1_200n * UNIT)
  w.fund(r.coin, bob.publicKey, 800n * UNIT)
  w.must(await r.commit(alice, 1_200n * UNIT), 'alice commits')
  w.must(await r.commit(bob, 800n * UNIT), 'bob commits')

  w.refused(await r.bootstrap(stranger), 'NotEnded', 'opening the DAO before the raise has ended')
  w.warp(61)
  w.refused(await r.settle(stranger), 'NotOperator', 'settling a successful raise without opening its DAO')
  w.refused(await r.bootstrap(stranger, { withdrawal: 9_000 }), 'DaoCommitmentMismatch', 'another withdrawal share than committed')
  w.refused(await r.bootstrap(stranger, { governance: { ...GOV, proposalLengthMinutes: 10 } }), 'DaoCommitmentMismatch', 'other rules than committed')
  w.refused(await r.bootstrap(stranger, { daoName: 'someone-else' }), 'DaoCommitmentMismatch', 'another name than committed')
  // Nothing is left to choose, so anyone can open it: here a stranger, as LFOwn's keeper would.
  w.must(await r.bootstrap(stranger), 'a stranger settles the raise and opens its DAO and pool, in one instruction')

  const settled = w.decode(raiseP, 'raise', r.raise)
  assert.ok(settled.state.succeeded !== undefined && settled.claimsOpen, 'succeeded, with claims open')
  assert.equal(w.balance(ata(r.coin, r.treasury)), 200n * UNIT, 'the DAO treasury was paid its 20%')
  const daoAccount = w.decode(fut, 'daoAccount', r.dao)
  assert.equal(daoAccount.admin.toBase58(), r.authority.publicKey.toBase58(), 'the raise’s creator is the DAO’s admin, not whoever paid')
  assert.equal(daoAccount.pool.toBase58(), r.pool.toBase58())
  const mintState = MintLayout.decode(Buffer.from(w.svm.getAccount(r.baseMint).data))
  assert.equal(new PublicKey(mintState.mintAuthority).toBase58(), pda(fut, ['mint_authority', r.dao]).toBase58(), 'the DAO holds the mint')
  const nftHolder = AccountLayout.decode(Buffer.from(w.svm.getAccount(derivePositionNftAccount(r.nftMint)).data).subarray(0, AccountLayout.span))
  assert.equal(new PublicKey(nftHolder.owner).toBase58(), r.liquidityAuthority.toBase58(), 'the DAO holds the position NFT')
  const price = Number(BigInt(w.decode(damm, 'pool', r.pool).sqrtPrice.toString())) / 2 ** 64
  assert.ok(Math.abs(price * price / 0.0001 - 1) < 1e-6, `the pool opened at the raise price: ${price * price}`)
  assert.ok(w.balance(r.d.liquidityBase) < 1_000n && w.balance(r.d.liquidityQuote) < 1_000n, 'the whole pool share went in, bar dust')
  w.refused(await r.bootstrap(stranger), null, 'opening it twice')

  w.refused(await r.claim(mallory, alice.publicKey), null, "mallory claiming alice's commitment")
  w.must(await r.claim(alice), 'alice claims')
  w.must(await r.claim(bob), 'bob claims')
  assert.equal(w.balance(ata(r.baseMint, alice.publicKey)), 6_000_000n * UNIT)
  assert.equal(w.balance(ata(r.coin, alice.publicKey)), 600n * UNIT, 'and her share of the excess back')
  assert.equal(w.balance(ata(r.baseMint, bob.publicKey)), 4_000_000n * UNIT)
  assert.equal(w.balance(ata(r.coin, bob.publicKey)), 400n * UNIT)

  // The DAO is live: its first proposal opens at the raise price and takes half the pool.
  const p = await createProposal(w, r.d, 0)
  const opened = w.decode(fut, 'proposalAccount', p.proposal).config
  const startObs = BigInt(opened.startingObservation.toString())
  assert.ok(startObs >= 99_999_999n && startObs <= 100_000_000n, `the markets open at the raise price: ${startObs}`)
  assert.equal(opened.length, GOV.proposalLengthMinutes, 'the length is the DAO’s, not the proposer’s')
  w.must(w.send([await prepare(r.d, p)], [r.authority]), 'the new DAO funds its first proposal from its pool')
})

// ── the audit: each attack, replayed, refused ───────────────────────────────

test('audit 1: nobody can open a DAO under a raise’s name or for its mint, and the raise still becomes its own DAO', async () => {
  const w = world()
  const r = await raiseFor(w, { name: 'victim-dao' })
  const squatter = w.person()
  // The name is no longer an address: a DAO under the same name, over a throwaway mint,
  // lands somewhere else entirely.
  const dummyKp = Keypair.generate()
  const dummyDao = pda(fut, ['dao', dummyKp.publicKey])
  w.must(w.send([
    SystemProgram.createAccount({ fromPubkey: squatter.publicKey, newAccountPubkey: dummyKp.publicKey, lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(dummyKp.publicKey, 6, pda(fut, ['mint_authority', dummyDao]), null),
  ], [squatter, dummyKp]), 'a throwaway mint')
  const initFor = async (mint, dao) => fut.methods.initializeDao('victim-dao', Keypair.generate().publicKey, { damm: {} }, 5_000, GOV).accountsStrict({
    admin: squatter.publicKey, dao, moderator: pda(fut, ['moderator', mint]), treasury: pda(fut, ['treasury', dao]),
    mintAuthority: pda(fut, ['mint_authority', dao]), liquidityAuthority: pda(fut, ['liquidity', dao]),
    baseMint: mint, quoteMint: r.coin, systemProgram: SystemProgram.programId,
  }).instruction()
  w.must(w.send([await initFor(dummyKp.publicKey, dummyDao)], [squatter]), 'a DAO under the victim’s name, over the throwaway mint')
  assert.notEqual(dummyDao.toBase58(), r.dao.toBase58(), 'which is not the victim’s DAO')
  // And the victim's own DAO needs its mint, which only the raise controls.
  w.refused(w.send([await initFor(r.baseMint, r.dao)], [squatter]), 'MintNotControlled', 'opening the DAO of a mint the raise holds')

  const alice = w.person()
  w.fund(r.coin, alice.publicKey, 2_000n * UNIT)
  w.must(await r.commit(alice, 2_000n * UNIT), 'commit')
  w.warp(61)
  w.must(await r.bootstrap(w.payer), 'the raise becomes its own DAO all the same')
  assert.equal(w.balance(ata(r.coin, r.treasury)), 200n * UNIT, 'and pays its own treasury')
})

test('audit 2: the pool opens at the raise price, from the raise’s own accounts only', async () => {
  const w = world()
  const r = await raiseFor(w, { name: 'priced' })
  const alice = w.person()
  w.fund(r.coin, alice.publicKey, 1_100n * UNIT)
  w.must(await r.commit(alice, 1_000n * UNIT), 'commit')
  w.warp(61)
  // No claim before the DAO, so no backer holds tokens to open a pool of their own first.
  w.refused(await r.claim(alice), 'NotSucceeded', 'claiming before the DAO exists')
  // Token accounts of the caller's making, however they are owned, are not the pool share.
  const fake = (mint) => {
    const kp = Keypair.generate()
    w.must(w.send([
      SystemProgram.createAccount({ fromPubkey: alice.publicKey, newAccountPubkey: kp.publicKey, lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE))), space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(kp.publicKey, mint, r.liquidityAuthority),
    ], [alice, kp]), 'a stand-in account owned by the DAO’s liquidity PDA')
    return kp.publicKey
  }
  w.refused(await r.bootstrap(alice, { liquidityQuote: fake(r.coin) }), 'InvalidAccount', 'opening the pool from a stand-in account')
  w.must(await r.bootstrap(alice), 'opening it from the raise’s own accounts')
  const price = Number(BigInt(w.decode(damm, 'pool', r.pool).sqrtPrice.toString())) / 2 ** 64
  assert.ok(Math.abs(price * price / 0.0001 - 1) < 1e-6, `the pool opened at the raise price: ${price * price}`)
})

test('audit 2b: a raise that met its goal but got no DAO by its deadline refunds everyone', async () => {
  const w = world()
  const r = await raiseFor(w, { name: 'late', claimDelay: 600 })
  const alice = w.person()
  w.fund(r.coin, alice.publicKey, 1_500n * UNIT)
  w.must(await r.commit(alice, 1_500n * UNIT), 'commit')
  w.warp(61 + 600)
  w.refused(await r.bootstrap(w.payer), 'RaiseNotSucceeded', 'opening the DAO past the deadline')
  w.must(await r.settle(alice), 'anyone settles it as failed')
  w.must(w.send([await raiseP.methods.refund().accountsStrict({
    raise: r.raise, commitment: r.commitment(alice.publicKey), quoteMint: r.coin, quoteVault: ata(r.coin, r.raise),
    userQuote: ata(r.coin, alice.publicKey), user: alice.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()], [alice]), 'refund')
  assert.equal(w.balance(ata(r.coin, alice.publicKey)), 1_500n * UNIT, 'every coin back')
})

/** A proposal from preparation to decision, nobody trading: the status quo wins. */
async function runToFinal(w, d, p) {
  w.must(w.send([await prepare(d, p)], [d.admin]), 'prepare')
  w.must(await launch(w, d, p), 'launch')
  for (let i = 0; i < 5; i++) { w.warp(61); await crankAll(w, p) }
  w.must(await finalize(w, p), 'finalize')
  return winner(w, p)
}

/** redeem_liquidity with some of its accounts swapped for others. */
const redeemIx = async (d, p, winning, caller, { baseCond, quoteCond } = {}) => {
  const owner = d.liquidityAuthority
  const o = p.options[winning]
  return fut.methods.redeemLiquidity()
    .accountsStrict({ payer: caller.publicKey, proposal: p.proposal, vault: p.vault, moderator: d.moderator, dao: d.dao, liquidityAuthority: owner, pool: o.pool, ...programs })
    .remainingAccounts([
      meta(o.reserveA), meta(o.reserveB), meta(ata(o.condQuote, owner)), meta(ata(o.condBase, owner)),
      meta(d.baseMint, false), meta(ata(d.baseMint, p.vault)), meta(ata(d.baseMint, owner)),
      ...p.options.flatMap((x, i) => [meta(x.condBase), meta(baseCond ? baseCond(x, i) : ata(x.condBase, owner))]),
      meta(d.quoteMint, false), meta(ata(d.quoteMint, p.vault)), meta(ata(d.quoteMint, owner)),
      ...p.options.flatMap((x, i) => [meta(x.condQuote), meta(quoteCond ? quoteCond(x, i) : ata(x.condQuote, owner))]),
    ]).instruction()
}

test('audit 4: nobody can redeem a proposal through stand-in accounts and strand the DAO’s liquidity', async () => {
  const w = world()
  const d = await openDao(w)
  const p = await createProposal(w, d, 0)
  const win = await runToFinal(w, d, p)
  const attacker = w.person()
  const empty = () => Keypair.generate().publicKey
  w.refused(w.send([await redeemIx(d, p, win, attacker, { baseCond: empty, quoteCond: empty })], [attacker]), 'InvalidAccount', 'redeeming through empty stand-ins')
  w.must(await redeem(w, d, p, win, attacker), 'the honest redemption still runs')
  assert.ok(w.balance(d.liquidityBase) > 0n && w.balance(d.liquidityQuote) > 0n, 'and the liquidity comes home')
})

test('audit 5: an escrow account opened ahead of time does not block the next proposal', async () => {
  const w = world()
  const d = await openDao(w)
  const next = proposalAddresses(d, 0)
  const griefer = w.person()
  w.must(w.send([
    createAssociatedTokenAccountIdempotentInstruction(griefer.publicKey, ata(d.baseMint, next.vault), next.vault, d.baseMint),
    createAssociatedTokenAccountIdempotentInstruction(griefer.publicKey, ata(d.quoteMint, next.vault), next.vault, d.quoteMint),
  ], [griefer]), 'someone opens the next proposal’s vault accounts first')
  await createProposal(w, d, 0)
})

test('audit 8: the liquidity comes out only into the DAO’s own accounts', async () => {
  const w = world()
  const d = await openDao(w)
  const p = await createProposal(w, d, 0)
  const standIn = (mint) => {
    const kp = Keypair.generate()
    w.must(w.send([
      SystemProgram.createAccount({ fromPubkey: d.admin.publicKey, newAccountPubkey: kp.publicKey, lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE))), space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(kp.publicKey, mint, d.liquidityAuthority),
    ], [d.admin, kp]), 'a stand-in account owned by the PDA')
    return kp.publicKey
  }
  const ix = await fut.methods.prepareProposalLiquidity().accountsStrict({
    creator: d.admin.publicKey, proposal: p.proposal, moderator: d.moderator, dao: d.dao, liquidityAuthority: d.liquidityAuthority,
    liquidityBase: standIn(d.baseMint), liquidityQuote: standIn(d.quoteMint), poolAuthority: DAMM_POOL_AUTHORITY,
    tokenAMint: d.baseMint, tokenBMint: d.quoteMint, tokenProgram: TOKEN_PROGRAM_ID, ...dammAccounts(d),
  }).instruction()
  w.refused(w.send([ix], [d.admin]), 'InvalidAccount', 'taking the liquidity out into stand-in accounts')
  w.must(w.send([await prepare(d, p)], [d.admin]), 'into the DAO’s own accounts it works')
})

test('audit (medium): no proposal takes liquidity out before the last one’s is back in the pool', async () => {
  const w = world()
  const d = await openDao(w)
  const p = await createProposal(w, d, 0)
  const next = await createProposal(w, d, 1)
  const win = await runToFinal(w, d, p)
  w.must(await redeem(w, d, p, win, w.payer), 'redeem')
  w.refused(w.send([await prepare(d, next)], [d.admin]), 'LiquidityNotReturned', 'preparing while the last liquidity is still outside the pool')
  w.must(w.send([await returnLiquidity(d, w.payer)], [w.payer]), 'return')
  w.must(w.send([await prepare(d, next)], [d.admin]), 'then the next proposal')
})

// DAMM v2 helpers for pushing the pool's price around.
const dammSwapRaw = async (d, trader, inMint, outMint, amountIn) => damm.methods.swap2({ amount0: bn(amountIn), amount1: bn(0), swapMode: 0 }).accountsStrict({
  poolAuthority: DAMM_POOL_AUTHORITY, pool: d.pool, inputTokenAccount: ata(inMint, trader.publicKey), outputTokenAccount: ata(outMint, trader.publicKey),
  tokenAVault: d.tokenAVault, tokenBVault: d.tokenBVault, tokenAMint: d.baseMint, tokenBMint: d.quoteMint, payer: trader.publicKey,
  tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, eventAuthority: DAMM_EVENT_AUTHORITY, program: damm.programId,
}).instruction()
const poolState = (w, d) => { const s = w.decode(damm, 'pool', d.pool); return { sp: BigInt(s.sqrtPrice.toString()), L: BigInt(s.liquidity.toString()) } }
const Q128 = 1n << 128n
const quoteToPush = (L, sp, target) => (L * (target - sp) / Q128) * 10000n / 9900n + 10n
const baseToPull = (L, sp, target) => L * (sp - target) / (sp * target)

test('audit 6: the price guard — no transaction places the checkpoint, and a real move is followed slowly', async () => {
  const w = world()
  const d = await openDao(w)
  const attacker = w.person()
  w.fund(d.quoteMint, attacker.publicKey, 20_000n * UNIT)
  give(w, d, attacker.publicKey, 8_000_000n * UNIT)
  w.must(w.send([await d.record()], [attacker]), 'anyone updates the checkpoint')
  w.refused(w.send([await d.record()], [attacker]), 'CheckpointTooRecent', 'two updates within a minute')

  const p = await createProposal(w, d, 0)
  const win = await runToFinal(w, d, p)
  w.must(await redeem(w, d, p, win, attacker), 'redeem')

  // In one transaction: push the price and make the DAO deposit at it.
  const before = positionLiquidity(w, d)
  w.refused(w.send([...(await dammSwapIxs(d, attacker, 1_000n * UNIT)), await returnLiquidity(d, attacker)], [attacker]), 'PriceMovedTooFar', 'the DAO depositing inside a price push')
  assert.equal(positionLiquidity(w, d), before, 'nothing moved')

  // The audit's two-step attack: push, record, pull; a minute later push, return, pull.
  const { sp: s0 } = poolState(w, d)
  const push = async () => { const { sp, L } = poolState(w, d); return dammSwapRaw(d, attacker, d.quoteMint, d.baseMint, quoteToPush(L, sp, s0 * 2n)) }
  const pull = async () => { const { sp, L } = poolState(w, d); return dammSwapRaw(d, attacker, d.baseMint, d.quoteMint, baseToPull(L, sp, s0)) }
  w.warp(61)
  w.must(w.send([await push()], [attacker]), 'push the price 4x')
  w.must(w.send([await d.record()], [attacker]), 'record it')
  w.must(w.send([await pull()], [attacker]), 'pull it back')
  const moved = Number(BigInt(w.decode(fut, 'daoAccount', d.dao).priceCheckpoint.toString())) / Number(s0)
  assert.ok(moved > 1 && moved < 1.006, `the checkpoint moved half a percent of its square root, not 2x: ${moved}`)
  w.warp(61)
  w.must(w.send([await push()], [attacker]), 'push again')
  w.refused(w.send([await returnLiquidity(d, attacker)], [attacker]), 'PriceMovedTooFar', 'depositing at the pushed price a minute later')
  w.must(w.send([await pull()], [attacker]), 'pull it back')
  w.must(w.send([await returnLiquidity(d, attacker)], [attacker]), 'at the real price the liquidity goes back')

  // A real move: not accepted at once, followed a minute and 1% at a time.
  w.must(await dammSwap(w, d, attacker, 1_000n * UNIT), 'the price really moves')
  w.refused((await tryPropose(w, d, 1)).result, 'PriceMovedTooFar', 'opening markets straight after a move')
  const steps = await followPrice(w, d)
  assert.ok(steps > 3, `it took ${steps} updates`)
  const q = await createProposal(w, d, 1)
  const expected = (() => { const sq = BigInt(w.decode(damm, 'pool', d.pool).sqrtPrice.toString()); return (sq * sq * 1_000_000_000_000n) >> 128n })()
  const opened = BigInt(w.decode(fut, 'proposalAccount', q.proposal).config.startingObservation.toString())
  assert.ok(opened * 1000n > expected * 998n && opened * 1000n < expected * 1002n, 'the markets open at the pool’s price')

  // A checkpoint nobody refreshed for half an hour is not a price.
  w.warp(1_801)
  w.refused(w.send([await prepare(d, q)], [d.admin]), 'NoPriceCheckpoint', 'moving liquidity on a stale checkpoint')
  w.must(w.send([await d.record()], [w.payer]), 'one update')
  w.must(w.send([await prepare(d, q)], [d.admin]), 'lets it through')
})

test('audit 7: a market’s clock starts when it is funded, however long after it was created', async () => {
  const w = world()
  const d = await openDao(w)
  const p = await createProposal(w, d, 0)
  w.must(w.send([await prepare(d, p)], [d.admin]), 'prepare')
  w.warp(2 * 86_400)
  w.must(await launch(w, d, p), 'launched two days later')
  const now = Number(w.svm.getClock().unixTimestamp)
  for (const o of p.options) {
    const oracle = w.decode(amm, 'poolAccount', o.pool).oracle
    assert.equal(Number(oracle.createdAtUnixTime), now, 'the TWAP starts at the launch')
    assert.equal(BigInt(oracle.cumulativeObservations.toString()), 0n)
  }
})

/** A trader buys option 1's side with `amount` of the coin. */
async function backPass(w, d, p, amount) {
  const trader = w.person()
  w.fund(d.quoteMint, trader.publicKey, amount)
  w.must(w.send([await vault.methods.deposit({ quote: {} }, bn(amount))
    .accountsStrict({ signer: trader.publicKey, vault: p.vault, mint: d.quoteMint, vaultAta: ata(d.quoteMint, p.vault), userAta: ata(d.quoteMint, trader.publicKey), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .remainingAccounts(p.options.flatMap((o) => [meta(o.condQuote), meta(ata(o.condQuote, trader.publicKey))])).instruction()], [trader]), 'trader splits quote')
  const o1 = p.options[1]
  w.must(w.send([
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(o1.condBase, trader.publicKey), trader.publicKey, o1.condBase),
    await amm.methods.swap(true, bn(amount * 4n / 5n), bn(0)).accountsStrict({ trader: trader.publicKey, pool: o1.pool, reserveA: o1.reserveA, reserveB: o1.reserveB, feeVault: o1.feeVault, traderAccountA: ata(o1.condQuote, trader.publicKey), traderAccountB: ata(o1.condBase, trader.publicKey), tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
  ], [trader]), 'trader buys option 1')
}

test('audit 9–10: yes or no only, winners wait, run within a window, and within limits', async () => {
  const w = world()
  const d = await openDao(w, { name: 'guarded', gov: { ...GOV, executionDelaySeconds: 3_600, executionWindowSeconds: 3_600, maxTransferBps: 1_000, maxMintBps: 100 } })
  const grantee = Keypair.generate().publicKey
  const p = await createProposal(w, d, 0)

  // A third option, the one nobody would look at, is refused.
  w.refused(w.send([await fut.methods.addOption().accountsStrict({
    creator: d.admin.publicKey, proposal: p.proposal, moderator: d.moderator, dao: d.dao, ...programs,
  }).remainingAccounts(Array.from({ length: 8 }, () => meta(Keypair.generate().publicKey))).instruction()], [d.admin]), 'TooManyOptions', 'a third option')

  w.must(w.send([await setActions(d, p, 1, [
    { transfer: { mint: d.quoteMint, amount: bn(400n * UNIT), recipient: grantee } }, // 40% of the treasury: over the 10% limit
    { mintTo: { amount: bn(100_000n * UNIT), recipient: grantee } }, // 0.5% of supply: under the 1% limit
  ])], [d.admin]), 'actions')
  w.must(w.send([await prepare(d, p)], [d.admin]), 'prepare')
  w.must(await launch(w, d, p), 'launch')
  await backPass(w, d, p, 500n * UNIT)
  for (let i = 0; i < 5; i++) { w.warp(61); await crankAll(w, p) }
  w.must(await finalize(w, p), 'finalize')
  assert.equal(winner(w, p), 1, 'option 1 won')

  w.refused(w.send([await executeMint(w, d, p, 1, 1, grantee)], [w.payer]), 'ExecutionDelay', 'running a winner at once')
  w.warp(3_600)
  w.refused(w.send([await executeTransfer(w, d, p, 1, 0, { mint: d.quoteMint, recipient: grantee })], [w.payer]), 'ActionOverLimit', 'a transfer over the DAO’s limit')
  w.must(w.send([await executeMint(w, d, p, 1, 1, grantee)], [w.payer]), 'a mint within it runs after the delay')
  w.warp(3_600)
  w.refused(w.send([await executeTransfer(w, d, p, 1, 0, { mint: d.quoteMint, recipient: grantee })], [w.payer]), 'ExecutionExpired', 'a winner long after its window')
})

test('anyone may propose against a stake, gets it back once the market decides (less a part if turned down), and anyone launches what is prepared', async () => {
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

  w.refused(w.send([await returnStake(d, p, stranger, proposer.publicKey)], [stranger]), 'ProposalNotResolved', 'taking the stake back mid-vote')
  w.refused(w.send([await setActions(d, p, 1, [{ transfer: { mint: d.quoteMint, amount: bn(UNIT), recipient: stranger.publicKey } }], stranger)], [stranger]), 'Unauthorized', 'a stranger writing someone else’s options')
  w.must(w.send([await setActions(d, p, 1, [{ transfer: { mint: d.quoteMint, amount: bn(UNIT), recipient: proposer.publicKey } }], proposer)], [proposer]), 'the proposer writes option 1')
  w.refused(w.send([await prepare(d, p, stranger)], [stranger]), 'Unauthorized', 'a stranger taking the liquidity out for someone else’s proposal')
  w.must(w.send([await prepare(d, p, proposer)], [proposer]), 'the proposer prepares: the options are final')
  w.refused(w.send([await setActions(d, p, 1, [{ transfer: { mint: d.quoteMint, amount: bn(2n * UNIT), recipient: proposer.publicKey } }], proposer)], [proposer]), 'LiquidityAlreadyPrepared', 'rewriting an option once the liquidity is out')

  w.must(await launch(w, d, p, stranger), 'a stranger launches the prepared proposal')
  for (let i = 0; i < 5; i++) { w.warp(61); await crankAll(w, p) }
  w.must(await finalize(w, p), 'finalize')
  assert.equal(winner(w, p), 0, 'nobody traded: the market turned it down')

  w.refused(w.send([await returnStake(d, p, stranger, stranger.publicKey)], [stranger]), 'Unauthorized', 'returning the stake to someone else')
  const treasuryBefore = w.balance(ata(d.baseMint, d.treasury))
  w.must(w.send([await returnStake(d, p, stranger, proposer.publicKey)], [stranger]), 'anyone returns the stake')
  assert.equal(w.balance(ata(d.baseMint, proposer.publicKey)), 90_000n * UNIT, 'the proposer gets 80% back')
  assert.equal(w.balance(ata(d.baseMint, d.treasury)) - treasuryBefore, 10_000n * UNIT, 'the treasury keeps 20% of a stake the market turned down')
  assert.equal(w.svm.getAccount(pda(fut, ['stake', p.proposal])), null, 'the escrow is closed')
  w.refused(w.send([await returnStake(d, p, stranger, proposer.publicKey)], [stranger]), null, 'returning it twice')
})
