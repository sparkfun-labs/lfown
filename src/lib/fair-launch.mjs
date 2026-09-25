// LFOwn — fair launches: a raise at one price for everyone, then a DAO governed by
// futarchy that owns its token's pool.
//
// The other way to launch. A bonding-curve meme is priced by whoever buys first; a fair
// launch sells its tokens at a single price to everyone who commits during the raise,
// refunds whatever is over the goal, and then:
//
//   - 80% of the raise and 8M tokens open a Meteora DAMM v2 pool at exactly that price,
//     owned by the token's DAO, not by anyone's wallet;
//   - 20% goes to the DAO's treasury;
//   - the DAO holds the token's mint, its treasury and its liquidity, and moves them only
//     when a proposal wins its market (see onchain/programs/futarchy);
//   - the pool's fees are split on-chain, half to the DAO, half to LFOwn.
//
// The raise is priced in the ownership coin the launch pairs with, like every coin here:
// a $5,000 goal is that many dollars of META (or AVICI…) at the price of the day it opens.
//
// Everything in this file builds instructions or reads accounts; nothing signs. The
// launch page, the keeper and the scripts share it, so an account list is written once.
//
// The programs are not on mainnet: they need an audit first. Until then a fair launch runs
// on whatever cluster FAIR_RPC names — a local validator (npm run localnet in onchain/) or
// devnet — and the site says so.

import {
  PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, AuthorityType, MINT_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createSetAuthorityInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import * as anchorModule from '@coral-xyz/anchor'
import {
  deriveCustomizablePoolAddress, derivePositionAddress, derivePositionNftAccount, deriveTokenVaultAddress,
} from '@meteora-ag/cp-amm-sdk'
import raiseIdl from './idl/lfown_raise.json' with { type: 'json' }
import futarchyIdl from './idl/futarchy.json' with { type: 'json' }
import ammIdl from './idl/amm.json' with { type: 'json' }
import vaultIdl from './idl/vault.json' with { type: 'json' }
import cpAmmIdl from './idl/cp_amm.json' with { type: 'json' }

// Anchor ships CommonJS: Node only offers it as a default export, a bundler as named ones.
const anchor = Reflect.get(anchorModule, 'default') ?? anchorModule
const { AnchorProvider, BN, Program } = anchor

// ── the terms ────────────────────────────────────────────────────────────────

const UNIT = 1_000_000n // every token here has 6 decimals, ownership coins included

/** What every fair launch sells, and how the raise is split. */
export const TERMS = {
  goalUsd: 5_000,
  tokensForInvestors: 10_000_000n * UNIT,
  tokensForPool: 8_000_000n * UNIT,
  /** Share of the raise that opens the pool; the rest is the DAO's treasury. */
  poolShareBps: 8_000,
  durationSeconds: 24 * 60 * 60,
  /**
   * How long after the raise ends its DAO may still be opened. Past it, a raise that met
   * its goal is refunded like one that did not: nobody's money waits on a DAO forever.
   */
  claimDelaySeconds: 3 * 24 * 60 * 60,
  /** Share of the pool's liquidity each proposal's markets are seeded with. */
  withdrawalBps: 5_000,
}

/**
 * The rules every proposal of a fair-launched DAO runs under, committed to by the raise
 * before anyone joins it. MetaDAO's defaults, near enough: three days of trading, the
 * first day not counted, an option must beat the status quo by 3%.
 */
export const GOVERNANCE = {
  proposalLengthMinutes: 3 * 24 * 60,
  warmupSeconds: 24 * 60 * 60,
  marketBiasBps: 300,
  maxObservationChangeBps: 500,
  marketFeeBps: 30,
  /** 100,000 of the 18M tokens: proposing costs something while the liquidity is away. */
  proposalStake: 100_000n * UNIT,
  /** A winning transfer moves at most 20% of what the treasury holds of that coin… */
  maxTransferBps: 2_000,
  /** …and a winning mint adds at most 5% to the supply. */
  maxMintBps: 500,
  /** A winner runs a day after the decision, so holders can leave first if they want to… */
  executionDelaySeconds: 24 * 60 * 60,
  /** …and within a week of it, or never. */
  executionWindowSeconds: 7 * 24 * 60 * 60,
  /** Share of the stake the treasury keeps when the market turns a proposal down. */
  failedStakeSlashBps: 2_000,
}

// ── programs ─────────────────────────────────────────────────────────────────

export const PROGRAM_IDS = {
  raise: new PublicKey(raiseIdl.address),
  futarchy: new PublicKey(futarchyIdl.address),
  amm: new PublicKey(ammIdl.address),
  vault: new PublicKey(vaultIdl.address),
  cpAmm: new PublicKey(cpAmmIdl.address),
}
export const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
export const DAMM_POOL_AUTHORITY = new PublicKey('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC')
/** LFOwn's half of every fair-launched pool's fees, and the conditional markets' fees. */
export const FEE_AUTHORITY = new PublicKey(ammIdl.constants.find((c) => c.name === 'FEE_AUTHORITY').value)

const readOnly = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t }

/** The four programs and Meteora's, bound to `connection`, for building and decoding. */
export function programs(connection) {
  const provider = new AnchorProvider(connection, readOnly, { commitment: 'confirmed' })
  return {
    raise: new Program(raiseIdl, provider),
    futarchy: new Program(futarchyIdl, provider),
    amm: new Program(ammIdl, provider),
    vault: new Program(vaultIdl, provider),
    cpAmm: new Program(cpAmmIdl, provider),
  }
}

// ── addresses ────────────────────────────────────────────────────────────────

const seed = (s) => (typeof s === 'string' ? new TextEncoder().encode(s) : s instanceof PublicKey ? s.toBuffer() : s)
const pda = (programId, seeds) => PublicKey.findProgramAddressSync(seeds.map(seed), programId)[0]
const u16le = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff])
export const ata = (mint, owner, program = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, program)

/**
 * A DAO's name is its token's mint, cut to the 32 bytes a name may hold. Its address is
 * the mint's, not the name's, so nobody can take a name ahead of the raise that owns it.
 */
export const daoNameFor = (mint) => new PublicKey(mint).toBase58().slice(0, 32)

export function raiseAddresses(mint, quoteMint) {
  const baseMint = new PublicKey(mint)
  const raise = pda(PROGRAM_IDS.raise, ['raise', baseMint])
  return {
    baseMint, quoteMint: new PublicKey(quoteMint), raise,
    baseVault: ata(baseMint, raise), quoteVault: ata(quoteMint, raise),
    commitment: (user) => pda(PROGRAM_IDS.raise, ['commitment', raise, new PublicKey(user)]),
  }
}

/** Every address a fair-launched DAO has, known before it exists. */
export function daoAddresses(mint, quoteMint) {
  const baseMint = new PublicKey(mint)
  const quote = new PublicKey(quoteMint)
  const name = daoNameFor(baseMint)
  const f = PROGRAM_IDS.futarchy
  const dao = pda(f, ['dao', baseMint])
  const liquidityAuthority = pda(f, ['liquidity', dao])
  const positionNftMint = pda(f, ['position_nft', dao])
  const pool = deriveCustomizablePoolAddress(baseMint, quote)
  return {
    name, baseMint, quoteMint: quote, dao,
    moderator: pda(f, ['moderator', baseMint]),
    treasury: pda(f, ['treasury', dao]),
    mintAuthority: pda(f, ['mint_authority', dao]),
    liquidityAuthority,
    liquidityBase: ata(baseMint, liquidityAuthority),
    liquidityQuote: ata(quote, liquidityAuthority),
    positionNftMint,
    positionNftAccount: derivePositionNftAccount(positionNftMint),
    position: derivePositionAddress(positionNftMint),
    pool,
    tokenAVault: deriveTokenVaultAddress(baseMint, pool),
    tokenBVault: deriveTokenVaultAddress(quote, pool),
  }
}

const DAMM_EVENT_AUTHORITY = pda(PROGRAM_IDS.cpAmm, ['__event_authority'])

export function proposalAddresses(d, id) {
  const f = PROGRAM_IDS.futarchy
  const proposal = pda(f, ['proposal', d.moderator, u16le(id)])
  const vault = pda(PROGRAM_IDS.vault, ['vault', proposal, u16le(id)])
  const cmint = (type, i) => pda(PROGRAM_IDS.vault, ['cmint', vault, new Uint8Array([type]), new Uint8Array([i])])
  const option = (i) => {
    const condBase = cmint(0, i)
    const condQuote = cmint(1, i)
    const pool = pda(PROGRAM_IDS.amm, ['pool', proposal, condQuote, condBase])
    return {
      index: i, condBase, condQuote, pool,
      reserveA: pda(PROGRAM_IDS.amm, ['reserve', pool, condQuote]),
      reserveB: pda(PROGRAM_IDS.amm, ['reserve', pool, condBase]),
      feeVault: pda(PROGRAM_IDS.amm, ['fee_vault', pool]),
    }
  }
  return {
    id, proposal, vault, options: [option(0), option(1)],
    stakeEscrow: pda(f, ['stake', proposal]),
    actions: (i) => pda(f, ['actions', proposal, new Uint8Array([i])]),
  }
}

// ── which chain ──────────────────────────────────────────────────────────────

const GENESIS = {
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
}
const checkedClusters = new Map()

/**
 * Refuses to work on any chain but the one named: a devnet setting pointed at a mainnet
 * RPC would otherwise sign real transactions with test keys. Checked once per RPC.
 */
export async function assertCluster(connection, cluster) {
  const key = `${connection.rpcEndpoint} ${cluster}`
  if (!checkedClusters.has(key)) {
    checkedClusters.set(key, connection.getGenesisHash().then((genesis) => {
      const ok = cluster === 'devnet' ? genesis === GENESIS.devnet
        : cluster === 'localnet' ? !Object.values(GENESIS).includes(genesis)
        : false
      if (!ok) throw new Error(`the fair-launch RPC is not on ${cluster}`)
    }))
    checkedClusters.get(key).catch(() => checkedClusters.delete(key))
  }
  return checkedClusters.get(key)
}

// ── the DAO a raise commits to ──────────────────────────────────────────────

const bnOf = (g) => ({ ...g, proposalStake: new BN(g.proposalStake.toString()) })

/**
 * sha256(name ‖ withdrawal bps, u16 LE ‖ governance, borsh): what the raise stores and
 * `bootstrap_dao` checks, so the DAO it opens is exactly this one.
 */
export async function daoCommitment(p, name, withdrawalBps, governance) {
  const config = p.futarchy.coder.types.encode('governanceConfig', bnOf(governance))
  const bytes = new Uint8Array([...new TextEncoder().encode(name), ...u16le(withdrawalBps), ...config])
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
}

// ── opening a raise ──────────────────────────────────────────────────────────

/** The goal in coin base units, from a dollar goal and the coin's price that day. */
export function goalInCoin(usdPrice, goalUsd = TERMS.goalUsd) {
  if (!(usdPrice > 0)) throw new Error('This coin has no price to set a goal in.')
  return BigInt(Math.round((goalUsd / usdPrice) * Number(UNIT)))
}

/**
 * Metaplex `CreateMetadataAccountV3`, written out rather than pulled in with Metaplex's
 * SDK for one instruction. The update authority is the DAO's mint authority, a PDA that
 * signs nothing but winning proposals: nobody can rename the token or swap its picture.
 */
function createMetadataIx({ mint, mintAuthority, payer, updateAuthority, name, symbol, uri }) {
  const str = (s) => { const b = new TextEncoder().encode(s); return [...new Uint8Array(new Uint32Array([b.length]).buffer), ...b] }
  const data = new Uint8Array([
    33, // CreateMetadataAccountV3
    ...str(name), ...str(symbol), ...str(uri),
    0, 0, // seller fee basis points
    0, 0, 0, // creators, collection, uses: none
    1, // mutable, through the DAO
    0, // collection details: none
  ])
  const metadata = pda(METADATA_PROGRAM, ['metadata', METADATA_PROGRAM, mint])
  return new TransactionInstruction({
    programId: METADATA_PROGRAM,
    keys: [
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: mintAuthority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: updateAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

/**
 * The two transactions that open a fair launch, in order: the token (mint, name and
 * picture, then its mint authority handed to the raise), then the raise itself.
 *
 * `mint` is a Keypair the caller keeps until both land; it signs both, so only whoever
 * created the token can open its raise, and on nothing but this DAO's addresses. The
 * creator signs both too. The goal, supply split and DAO rules are this file's TERMS and GOVERNANCE,
 * so every fair launch is the same deal.
 */
export async function buildOpenRaise(connection, { creator, mint, quoteMint, usdPrice, name, symbol, uri, terms = TERMS, governance = GOVERNANCE }) {
  const p = programs(connection)
  const owner = new PublicKey(creator)
  const r = raiseAddresses(mint.publicKey, quoteMint)
  const d = daoAddresses(mint.publicKey, quoteMint)
  const goal = goalInCoin(usdPrice, terms.goalUsd)
  const quoteToPool = (goal * BigInt(terms.poolShareBps)) / 10_000n
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE)

  const token = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, 6, owner, null),
    createMetadataIx({ mint: mint.publicKey, mintAuthority: owner, payer: owner, updateAuthority: d.mintAuthority, name, symbol, uri }),
    createSetAuthorityInstruction(mint.publicKey, owner, AuthorityType.MintTokens, r.raise),
  )
  const open = new Transaction().add(await p.raise.methods.initializeRaise({
    goal: new BN(goal.toString()),
    tokensForInvestors: new BN(terms.tokensForInvestors.toString()),
    tokensForPool: new BN(terms.tokensForPool.toString()),
    quoteToPool: new BN(quoteToPool.toString()),
    durationSeconds: new BN(terms.durationSeconds),
    claimDelaySeconds: new BN(terms.claimDelaySeconds),
    daoCommitment: await daoCommitment(p, d.name, terms.withdrawalBps, governance),
  }).accountsStrict({
    baseMint: mint.publicKey, quoteMint: r.quoteMint, raise: r.raise, baseVault: r.baseVault, quoteVault: r.quoteVault,
    treasury: d.treasury, poolOperator: d.liquidityAuthority, authority: owner,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction())
  return { transactions: [token, open], raise: r.raise, dao: d.dao, goal, quoteToPool }
}

// ── backing a raise ──────────────────────────────────────────────────────────

export async function commitIx(connection, raise, user, amount) {
  const p = programs(connection)
  const r = raiseAddresses(raise.baseMint, raise.quoteMint)
  return p.raise.methods.commit(new BN(amount.toString())).accountsStrict({
    raise: r.raise, commitment: r.commitment(user), userQuote: ata(r.quoteMint, user), quoteVault: r.quoteVault,
    user: new PublicKey(user), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()
}

export async function claimIx(connection, raise, user) {
  const p = programs(connection)
  const r = raiseAddresses(raise.baseMint, raise.quoteMint)
  return p.raise.methods.claim().accountsStrict({
    raise: r.raise, commitment: r.commitment(user), baseMint: r.baseMint, quoteMint: r.quoteMint,
    baseVault: r.baseVault, quoteVault: r.quoteVault, userBase: ata(r.baseMint, user), userQuote: ata(r.quoteMint, user),
    user: new PublicKey(user), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()
}

export async function refundIx(connection, raise, user) {
  const p = programs(connection)
  const r = raiseAddresses(raise.baseMint, raise.quoteMint)
  return p.raise.methods.refund().accountsStrict({
    raise: r.raise, commitment: r.commitment(user), quoteMint: r.quoteMint, quoteVault: r.quoteVault,
    userQuote: ata(r.quoteMint, user), user: new PublicKey(user),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()
}

/**
 * Anyone, once a raise has failed: below its goal at the end, or past its deadline without
 * a DAO. A raise that met its goal settles only inside `bootstrapIx`.
 */
export async function settleIx(connection, raise, cranker) {
  const p = programs(connection)
  const r = raiseAddresses(raise.baseMint, raise.quoteMint)
  const d = daoAddresses(raise.baseMint, raise.quoteMint)
  return p.raise.methods.settle().accountsStrict({
    raise: r.raise, baseMint: r.baseMint, quoteMint: r.quoteMint, baseVault: r.baseVault, quoteVault: r.quoteVault,
    treasury: d.treasury, treasuryQuote: ata(r.quoteMint, d.treasury), poolOperator: d.liquidityAuthority,
    operatorQuote: d.liquidityQuote, operatorBase: d.liquidityBase, cranker: new PublicKey(cranker),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()
}

/**
 * Anyone, once a raise has ended above its goal and before its deadline: settles it and
 * opens exactly the DAO and the pool it committed to, in one instruction.
 */
export async function bootstrapIx(connection, raise, payer, { terms = TERMS, governance = GOVERNANCE } = {}) {
  const p = programs(connection)
  const r = raiseAddresses(raise.baseMint, raise.quoteMint)
  const d = daoAddresses(raise.baseMint, raise.quoteMint)
  return p.futarchy.methods.bootstrapDao(d.name, terms.withdrawalBps, bnOf(governance)).accountsStrict({
    payer: new PublicKey(payer), raise: r.raise,
    dao: d.dao, moderator: d.moderator, treasury: d.treasury, mintAuthority: d.mintAuthority, liquidityAuthority: d.liquidityAuthority,
    baseMint: d.baseMint, quoteMint: d.quoteMint, baseVault: r.baseVault, quoteVault: r.quoteVault, treasuryQuote: ata(d.quoteMint, d.treasury),
    liquidityBase: d.liquidityBase, liquidityQuote: d.liquidityQuote,
    positionNftMint: d.positionNftMint, positionNftAccount: d.positionNftAccount, poolAuthority: DAMM_POOL_AUTHORITY, pool: d.pool,
    position: d.position, tokenAVault: d.tokenAVault, tokenBVault: d.tokenBVault,
    eventAuthority: DAMM_EVENT_AUTHORITY, cpAmmProgram: PROGRAM_IDS.cpAmm, raiseProgram: PROGRAM_IDS.raise,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).instruction()
}

// ── the DAO ──────────────────────────────────────────────────────────────────

const dammAccounts = (d) => ({
  pool: d.pool, position: d.position, tokenAVault: d.tokenAVault, tokenBVault: d.tokenBVault,
  positionNftAccount: d.positionNftAccount, eventAuthority: DAMM_EVENT_AUTHORITY, cpAmmProgram: PROGRAM_IDS.cpAmm,
})
const cpiPrograms = {
  systemProgram: SystemProgram.programId, vaultProgram: PROGRAM_IDS.vault, ammProgram: PROGRAM_IDS.amm,
  tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
}
const meta = (pubkey, isWritable = true) => ({ pubkey, isSigner: false, isWritable })

export async function recordPriceIx(connection, d) {
  return programs(connection).futarchy.methods.recordPrice().accountsStrict({ dao: d.dao, pool: d.pool }).instruction()
}

/**
 * Opening a proposal: the creator's stake account, then the proposal and its two markets.
 * Its options' actions, and taking the liquidity out, come after (`setActionsIx`,
 * `prepareIx`); anyone launches it once prepared.
 */
export async function proposeIxs(connection, d, id, creator, metadata = null) {
  const p = programs(connection)
  const q = proposalAddresses(d, id)
  const [o0, o1] = q.options
  const who = new PublicKey(creator)
  return [
    createAssociatedTokenAccountIdempotentInstruction(who, ata(d.baseMint, who), who, d.baseMint),
    await p.futarchy.methods.initializeProposal(metadata).accountsStrict({
      creator: who, moderator: d.moderator, dao: d.dao, proposal: q.proposal,
      pool: d.pool, tokenMint: d.baseMint, creatorToken: ata(d.baseMint, who), stakeEscrow: q.stakeEscrow,
      ...cpiPrograms,
    }).remainingAccounts([
      meta(d.baseMint, false), meta(d.quoteMint, false), meta(q.vault), meta(ata(d.baseMint, q.vault)), meta(ata(d.quoteMint, q.vault)),
      meta(o0.condBase), meta(o1.condBase), meta(o0.condQuote), meta(o1.condQuote),
      meta(o0.pool), meta(o0.reserveA), meta(o0.reserveB), meta(FEE_AUTHORITY, false), meta(o0.feeVault),
      meta(o1.pool), meta(o1.reserveA), meta(o1.reserveB), meta(o1.feeVault),
    ]).instruction(),
  ]
}

/** `actions`: [{ transfer: { mint, amount, recipient } } | { mintTo: { amount, recipient } }] */
export async function setActionsIx(connection, d, id, creator, optionIndex, actions) {
  const q = proposalAddresses(d, id)
  const norm = actions.map((a) => (a.transfer
    ? { transfer: { mint: new PublicKey(a.transfer.mint), amount: new BN(a.transfer.amount.toString()), recipient: new PublicKey(a.transfer.recipient) } }
    : { mintTo: { amount: new BN(a.mintTo.amount.toString()), recipient: new PublicKey(a.mintTo.recipient) } }))
  return programs(connection).futarchy.methods.setOptionActions(optionIndex, norm).accountsStrict({
    creator: new PublicKey(creator), proposal: q.proposal, optionActions: q.actions(optionIndex), systemProgram: SystemProgram.programId,
  }).instruction()
}

export async function prepareIx(connection, d, id, creator) {
  const q = proposalAddresses(d, id)
  return programs(connection).futarchy.methods.prepareProposalLiquidity().accountsStrict({
    creator: new PublicKey(creator), proposal: q.proposal, moderator: d.moderator, dao: d.dao, liquidityAuthority: d.liquidityAuthority,
    liquidityBase: d.liquidityBase, liquidityQuote: d.liquidityQuote, poolAuthority: DAMM_POOL_AUTHORITY,
    tokenAMint: d.baseMint, tokenBMint: d.quoteMint, tokenProgram: TOKEN_PROGRAM_ID, ...dammAccounts(d),
  }).instruction()
}

/**
 * Anyone, once prepared. The liquidity authority is a PDA with no lamports, so its
 * conditional token accounts are opened first, by the payer: that is `accountIxs`.
 */
export async function launchIxs(connection, d, id, payer) {
  const q = proposalAddresses(d, id)
  const owner = d.liquidityAuthority
  const who = new PublicKey(payer)
  const opts = q.options
  const accountIxs = opts.flatMap((o) => [
    createAssociatedTokenAccountIdempotentInstruction(who, ata(o.condBase, owner), owner, o.condBase),
    createAssociatedTokenAccountIdempotentInstruction(who, ata(o.condQuote, owner), owner, o.condQuote),
  ])
  const launch = await programs(connection).futarchy.methods.launchProposal().accountsStrict({
    payer: who, proposal: q.proposal, vault: q.vault, moderator: d.moderator, dao: d.dao, liquidityAuthority: owner, ...cpiPrograms,
  }).remainingAccounts([
    meta(d.baseMint, false), meta(d.quoteMint, false), meta(ata(d.baseMint, q.vault)), meta(ata(d.quoteMint, q.vault)),
    meta(ata(d.baseMint, owner)), meta(ata(d.quoteMint, owner)),
    ...opts.map((o) => meta(o.condBase)), ...opts.map((o) => meta(o.condQuote)),
    ...opts.map((o) => meta(ata(o.condBase, owner))), ...opts.map((o) => meta(ata(o.condQuote, owner))),
    ...opts.map((o) => meta(o.pool)), ...opts.map((o) => meta(o.reserveA)), ...opts.map((o) => meta(o.reserveB)),
  ]).instruction()
  return { accountIxs, launch }
}

export async function crankIxs(connection, d, id) {
  const p = programs(connection)
  return Promise.all(proposalAddresses(d, id).options.map((o) =>
    p.amm.methods.crankTwap().accountsStrict({ pool: o.pool, reserveA: o.reserveA, reserveB: o.reserveB }).instruction()))
}

export async function finalizeIx(connection, d, id, signer) {
  const q = proposalAddresses(d, id)
  return programs(connection).futarchy.methods.finalizeProposal().accountsStrict({
    signer: new PublicKey(signer), proposal: q.proposal, vault: q.vault, vaultProgram: PROGRAM_IDS.vault, ammProgram: PROGRAM_IDS.amm,
  }).remainingAccounts(q.options.flatMap((o) => [meta(o.pool), meta(o.reserveA, false), meta(o.reserveB, false)])).instruction()
}

/** Anyone: the winning market's liquidity comes back to the DAO's liquidity authority. */
export async function redeemLiquidityIx(connection, d, id, winning, payer) {
  const q = proposalAddresses(d, id)
  const owner = d.liquidityAuthority
  const o = q.options[winning]
  return programs(connection).futarchy.methods.redeemLiquidity().accountsStrict({
    payer: new PublicKey(payer), proposal: q.proposal, vault: q.vault, moderator: d.moderator, dao: d.dao, liquidityAuthority: owner,
    pool: o.pool, ...cpiPrograms,
  }).remainingAccounts([
    meta(o.reserveA), meta(o.reserveB), meta(ata(o.condQuote, owner)), meta(ata(o.condBase, owner)),
    meta(d.baseMint, false), meta(ata(d.baseMint, q.vault)), meta(ata(d.baseMint, owner)),
    ...q.options.flatMap((x) => [meta(x.condBase), meta(ata(x.condBase, owner))]),
    meta(d.quoteMint, false), meta(ata(d.quoteMint, q.vault)), meta(ata(d.quoteMint, owner)),
    ...q.options.flatMap((x) => [meta(x.condQuote), meta(ata(x.condQuote, owner))]),
  ]).instruction()
}

export async function returnLiquidityIx(connection, d, payer) {
  return programs(connection).futarchy.methods.returnLiquidity().accountsStrict({
    payer: new PublicKey(payer), dao: d.dao, liquidityAuthority: d.liquidityAuthority, liquidityBase: d.liquidityBase, liquidityQuote: d.liquidityQuote,
    tokenAMint: d.baseMint, tokenBMint: d.quoteMint, tokenProgram: TOKEN_PROGRAM_ID, ...dammAccounts(d),
  }).instruction()
}

export async function returnStakeIx(connection, d, id, payer, creator) {
  const q = proposalAddresses(d, id)
  return programs(connection).futarchy.methods.returnStake().accountsStrict({
    payer: new PublicKey(payer), proposal: q.proposal, stakeEscrow: q.stakeEscrow,
    dao: d.dao, treasury: d.treasury, treasuryToken: ata(d.baseMint, d.treasury), creator: new PublicKey(creator),
    tokenMint: d.baseMint, creatorToken: ata(d.baseMint, creator),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()
}

export async function claimPoolFeesIx(connection, d, payer) {
  return programs(connection).futarchy.methods.claimPoolFees().accountsStrict({
    payer: new PublicKey(payer), dao: d.dao, liquidityAuthority: d.liquidityAuthority, treasury: d.treasury, protocol: FEE_AUTHORITY,
    baseMint: d.baseMint, quoteMint: d.quoteMint, liquidityBase: d.liquidityBase, liquidityQuote: d.liquidityQuote,
    treasuryBase: ata(d.baseMint, d.treasury), treasuryQuote: ata(d.quoteMint, d.treasury),
    protocolBase: ata(d.baseMint, FEE_AUTHORITY), protocolQuote: ata(d.quoteMint, FEE_AUTHORITY),
    poolAuthority: DAMM_POOL_AUTHORITY, ...dammAccounts(d),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()
}

/** Anyone, once `optionIndex` has won: runs its action number `actionIndex`, once. */
export async function executeIx(connection, d, id, optionIndex, actionIndex, action, payer) {
  const p = programs(connection)
  const q = proposalAddresses(d, id)
  const common = { payer: new PublicKey(payer), proposal: q.proposal, moderator: d.moderator, dao: d.dao, optionActions: q.actions(optionIndex),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }
  return action.transfer
    ? p.futarchy.methods.executeTransfer(actionIndex).accountsStrict({
        ...common, treasury: d.treasury, mint: action.transfer.mint, treasuryToken: ata(action.transfer.mint, d.treasury),
        recipient: action.transfer.recipient, recipientToken: ata(action.transfer.mint, action.transfer.recipient),
      }).instruction()
    : p.futarchy.methods.executeMint(actionIndex).accountsStrict({
        ...common, mintAuthority: d.mintAuthority, mint: d.baseMint,
        recipient: action.mintTo.recipient, recipientToken: ata(d.baseMint, action.mintTo.recipient),
      }).instruction()
}

// ── trading a proposal's markets ─────────────────────────────────────────────

/** What a swap of `amountIn` coin into the market's token yields, as the amm computes it. */
export function swapOutput(amountIn, reserveIn, reserveOut, feeBps) {
  let fee = (amountIn * BigInt(feeBps)) / 10_000n
  if (feeBps > 0 && fee === 0n) fee = 1n
  const taxed = amountIn - fee
  return (taxed * reserveOut) / (reserveIn + taxed)
}

/**
 * Backing an option: `amount` of the coin is split into one conditional coin per option
 * (a claim on the coin if that option wins), and this option's is swapped into its
 * conditional token. Whatever option wins, the trader keeps that option's side. The swap
 * refuses to fill more than `slippageBps` below the market as it is read here.
 */
export async function backOptionIxs(connection, d, id, trader, optionIndex, amount, { slippageBps = 200 } = {}) {
  const p = programs(connection)
  const q = proposalAddresses(d, id)
  const who = new PublicKey(trader)
  const o = q.options[optionIndex]
  const [market, reserveIn, reserveOut] = await Promise.all([
    p.amm.account.poolAccount.fetch(o.pool),
    connection.getTokenAccountBalance(o.reserveA).then((b) => BigInt(b.value.amount)),
    connection.getTokenAccountBalance(o.reserveB).then((b) => BigInt(b.value.amount)),
  ])
  const expected = swapOutput(BigInt(amount), reserveIn, reserveOut, market.fee)
  const minOut = (expected * BigInt(10_000 - slippageBps)) / 10_000n
  const opens = q.options.flatMap((x) => [
    createAssociatedTokenAccountIdempotentInstruction(who, ata(x.condQuote, who), who, x.condQuote),
    createAssociatedTokenAccountIdempotentInstruction(who, ata(x.condBase, who), who, x.condBase),
  ])
  const split = await p.vault.methods.deposit({ quote: {} }, new BN(amount.toString())).accountsStrict({
    signer: who, vault: q.vault, mint: d.quoteMint, vaultAta: ata(d.quoteMint, q.vault), userAta: ata(d.quoteMint, who),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).remainingAccounts(q.options.flatMap((x) => [meta(x.condQuote), meta(ata(x.condQuote, who))])).instruction()
  const buy = await p.amm.methods.swap(true, new BN(amount.toString()), new BN(minOut.toString())).accountsStrict({
    trader: who, pool: o.pool, reserveA: o.reserveA, reserveB: o.reserveB, feeVault: o.feeVault,
    traderAccountA: ata(o.condQuote, who), traderAccountB: ata(o.condBase, who), tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction()
  return [...opens, split, buy]
}

/** After the decision: the winning option's conditional coin and token, back into the real ones. */
export async function redeemWinningsIxs(connection, d, id, trader) {
  const p = programs(connection)
  const q = proposalAddresses(d, id)
  const who = new PublicKey(trader)
  const leg = async (type, mint, cond) => p.vault.methods.redeemWinnings({ [type]: {} }).accountsStrict({
    signer: who, vault: q.vault, mint, vaultAta: ata(mint, q.vault), userAta: ata(mint, who),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).remainingAccounts(q.options.flatMap((x) => [meta(x[cond]), meta(ata(x[cond], who))])).instruction()
  return [
    createAssociatedTokenAccountIdempotentInstruction(who, ata(d.baseMint, who), who, d.baseMint),
    createAssociatedTokenAccountIdempotentInstruction(who, ata(d.quoteMint, who), who, d.quoteMint),
    await leg('quote', d.quoteMint, 'condQuote'),
    await leg('base', d.baseMint, 'condBase'),
  ]
}

// ── reading ──────────────────────────────────────────────────────────────────

const RAISE_STATES = ['live', 'succeeded', 'failed']
const stateName = (s) => Object.keys(s ?? {})[0] ?? 'unknown'
const num = (b) => BigInt(b?.toString?.() ?? 0)
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** A raise account as plain values. */
const toRaise = (publicKey, a) => ({
  raise: publicKey.toBase58(), authority: a.authority.toBase58(), baseMint: a.baseMint.toBase58(), quoteMint: a.quoteMint.toBase58(),
  goal: num(a.goal), quoteToPool: num(a.quoteToPool), totalCommitted: num(a.totalCommitted),
  tokensForInvestors: num(a.tokensForInvestors), tokensForPool: num(a.tokensForPool),
  startsAt: Number(a.startsAt), endsAt: Number(a.endsAt), settledAt: Number(a.settledAt),
  claimDelaySeconds: Number(a.claimDelaySeconds), state: stateName(a.state), claimsOpen: a.claimsOpen,
  daoCommitment: hex(a.daoCommitment),
})

/** Every raise the program holds, newest first. */
export async function listRaises(connection) {
  // Raises of today's layout only: a test cluster keeps accounts from older versions of
  // the program, and one of those would fail the whole listing.
  const raise = programs(connection).raise.account.raise
  const all = await raise.all([{ dataSize: raise.size }])
  return all.map(({ publicKey, account }) => toRaise(publicKey, account)).sort((x, y) => y.startsAt - x.startsAt)
}

export async function readRaise(connection, mint) {
  const address = pda(PROGRAM_IDS.raise, ['raise', new PublicKey(mint)])
  const a = await programs(connection).raise.account.raise.fetchNullable(address)
  return a ? toRaise(address, a) : null
}

export async function readCommitment(connection, raise, user) {
  const p = programs(connection)
  const c = await p.raise.account.commitment.fetchNullable(raiseAddresses(raise.baseMint, raise.quoteMint).commitment(user))
  return c ? { amount: num(c.amount), settled: c.settled } : null
}

/**
 * What a backer gets from a raise that succeeds, exactly as onchain/programs/lfown_raise's
 * math.rs computes it: tokens pro rata of everything committed (rounded down), the goal
 * kept pro rata (rounded up), the rest refunded.
 */
export function allocation(raise, committed) {
  const c = BigInt(committed)
  const total = raise.totalCommitted
  if (!total || !c) return { tokens: 0n, refund: 0n, kept: 0n }
  const tokens = (c * raise.tokensForInvestors) / total
  const kept = total <= raise.goal ? c : (c * raise.goal + total - 1n) / total
  return { tokens, kept: kept < c ? kept : c, refund: c - (kept < c ? kept : c) }
}

export async function readDao(connection, mint, quoteMint) {
  const p = programs(connection)
  const d = daoAddresses(mint, quoteMint)
  const a = await p.futarchy.account.daoAccount.fetchNullable(d.dao)
  if (!a) return null
  const moderator = await p.futarchy.account.moderatorAccount.fetch(d.moderator)
  return {
    ...d,
    account: a,
    proposalCount: moderator.proposalIdCounter,
    activeProposal: a.activeProposal.equals(PublicKey.default) ? null : a.activeProposal.toBase58(),
    checkpoint: { sqrtPrice: num(a.priceCheckpoint), at: Number(a.priceCheckpointAt) },
    /** Liquidity redeemed from a proposal's market and not yet back in the pool. */
    pendingReturn: a.pendingReturn,
    governance: a.governance,
  }
}

export async function readProposals(connection, d, count) {
  const p = programs(connection)
  const out = []
  for (let id = count - 1; id >= 0; id--) {
    const q = proposalAddresses(d, id)
    const a = await p.futarchy.account.proposalAccount.fetchNullable(q.proposal)
    if (!a) continue
    const state = stateName(a.state)
    const markets = await Promise.all(q.options.map((o) => p.amm.account.poolAccount.fetchNullable(o.pool)))
    const actions = await Promise.all(q.options.map((_, i) => (i ? p.futarchy.account.optionActions.fetchNullable(q.actions(i)) : null)))
    out.push({
      id, address: q.proposal.toBase58(), creator: a.creator.toBase58(), state,
      winner: state === 'resolved' ? Number(Object.values(a.state.resolved)[0]) : null,
      createdAt: Number(a.createdAt), resolvedAt: Number(a.resolvedAt), lengthMinutes: a.config.length, warmupSeconds: a.config.warmupDuration,
      marketBiasBps: a.config.marketBias, startingObservation: num(a.config.startingObservation),
      prepared: num(a.baseLiquidity) > 0n, stake: num(a.stake),
      metadata: a.metadata,
      markets: markets.map((m, i) => (m ? {
        index: i, twap: twapOf(m.oracle), lastPrice: num(m.oracle.lastPrice), lastUpdate: Number(m.oracle.lastUpdateUnixTime),
      } : null)),
      actions: actions.map((x) => x?.actions ?? []),
      executed: actions.map((x) => x?.executed ?? 0),
    })
  }
  return out
}

/** The market's TWAP so far, in the amm's 10¹² scale, or its opening value before warmup. */
function twapOf(o) {
  const warmupEnd = Number(o.createdAtUnixTime) + o.warmupDuration
  const elapsed = Number(o.lastUpdateUnixTime) - warmupEnd
  if (elapsed <= 0) return num(o.startingObservation)
  return num(o.cumulativeObservations) / BigInt(elapsed)
}

/** An amm observation as a price in coins per token: quote/base · 10¹². */
export const observationPrice = (obs) => Number(obs) / 1e12

export { RAISE_STATES, UNIT }
