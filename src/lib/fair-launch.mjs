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

import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
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
const { AnchorProvider, BN, BorshCoder, Program } = anchor

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
  /**
   * 500,000 of the 18M tokens, about $250 at the raise price: proposing costs something
   * while the liquidity is away, and a turned-down proposal costs half of it.
   */
  proposalStake: 500_000n * UNIT,
  /** A winning transfer moves at most 20% of what the treasury holds of that coin… */
  maxTransferBps: 2_000,
  /** …and a winning mint adds at most 5% to the supply. */
  maxMintBps: 500,
  /** A winner runs a day after the decision, so holders can leave first if they want to… */
  executionDelaySeconds: 24 * 60 * 60,
  /** …and within a week of it, or never. */
  executionWindowSeconds: 7 * 24 * 60 * 60,
  /** Share of the stake the treasury keeps when the market turns a proposal down. */
  failedStakeSlashBps: 5_000,
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
// Built once per connection: a Program parses its whole IDL, and a page builds dozens of
// instructions and reads.
const bound = new WeakMap()
export function programs(connection) {
  if (bound.has(connection)) return bound.get(connection)
  const provider = new AnchorProvider(connection, readOnly, { commitment: 'confirmed' })
  const p = {
    raise: new Program(raiseIdl, provider),
    futarchy: new Program(futarchyIdl, provider),
    amm: new Program(ammIdl, provider),
    vault: new Program(vaultIdl, provider),
    cpAmm: new Program(cpAmmIdl, provider),
  }
  bound.set(connection, p)
  return p
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

/**
 * Whether a raise is on LFOwn's terms: priced in one of `config.quotes`, selling the
 * standard supply, for at least half the standard goal at the coin's configured price,
 * and committed to the standard DAO. The programs let anyone open a raise on any terms;
 * the page asks nobody to back another, and the keeper pays for no other.
 */
export async function isStandardRaise(connection, config, raise) {
  const quote = config.quotes.find((q) => q.mint === raise.quoteMint)
  if (!quote) return false
  if (raise.tokensForInvestors !== BigInt(config.terms.tokensForInvestors) || raise.tokensForPool !== BigInt(config.terms.tokensForPool)) return false
  if (raise.goal * 2n < goalInCoin(quote.usdPrice || 1, config.terms.goalUsd)) return false
  const expected = await daoCommitment(programs(connection), daoNameFor(raise.baseMint), config.terms.withdrawalBps, config.governance)
  return raise.daoCommitment === hex(expected)
}

// ── opening a raise ──────────────────────────────────────────────────────────

/** The goal in coin base units, from a dollar goal and the coin's price that day. */
export function goalInCoin(usdPrice, goalUsd = TERMS.goalUsd) {
  if (!(usdPrice > 0)) throw new Error('This coin has no price to set a goal in.')
  return BigInt(Math.round((goalUsd / usdPrice) * Number(UNIT)))
}

/**
 * The transaction that opens a fair launch. `initialize_raise` creates the token itself —
 * its mint, with the raise as mint authority and no freeze authority, and its name and
 * picture, under the DAO — so the creator never holds anything a DAO depends on.
 *
 * `mint` is a fresh Keypair; it signs, with the creator. The goal, supply split and DAO
 * rules are this file's TERMS and GOVERNANCE, so every fair launch is the same deal.
 */
export async function buildOpenRaise(connection, { creator, mint, quoteMint, usdPrice, name, symbol, uri, terms = TERMS, governance = GOVERNANCE }) {
  const p = programs(connection)
  const owner = new PublicKey(creator)
  const r = raiseAddresses(mint.publicKey, quoteMint)
  const d = daoAddresses(mint.publicKey, quoteMint)
  const goal = goalInCoin(usdPrice, terms.goalUsd)
  const quoteToPool = (goal * BigInt(terms.poolShareBps)) / 10_000n
  const open = new Transaction().add(await p.raise.methods.initializeRaise({
    goal: new BN(goal.toString()),
    tokensForInvestors: new BN(terms.tokensForInvestors.toString()),
    tokensForPool: new BN(terms.tokensForPool.toString()),
    quoteToPool: new BN(quoteToPool.toString()),
    durationSeconds: new BN(terms.durationSeconds),
    claimDelaySeconds: new BN(terms.claimDelaySeconds),
    daoCommitment: await daoCommitment(p, d.name, terms.withdrawalBps, governance),
    name, symbol, uri,
  }).accountsStrict({
    baseMint: mint.publicKey, quoteMint: r.quoteMint, raise: r.raise, baseVault: r.baseVault, quoteVault: r.quoteVault,
    treasury: d.treasury, poolOperator: d.liquidityAuthority,
    metadata: pda(METADATA_PROGRAM, ['metadata', METADATA_PROGRAM, mint.publicKey]), updateAuthority: d.mintAuthority,
    authority: owner,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    tokenMetadataProgram: METADATA_PROGRAM, rent: SYSVAR_RENT_PUBKEY,
  }).instruction())
  return { transactions: [open], raise: r.raise, dao: d.dao, goal, quoteToPool }
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
 * The three associated accounts the settlement pays, opened ahead of `bootstrapIx`, in a
 * transaction of their own. Anyone may; it also works on an address someone funded, which
 * would otherwise run the bootstrap past Solana's 64-instruction trace (4th audit M2).
 */
export function bootstrapAccountIxs(raise, payer) {
  const d = daoAddresses(raise.baseMint, raise.quoteMint)
  const who = new PublicKey(payer)
  return [
    createAssociatedTokenAccountIdempotentInstruction(who, ata(d.quoteMint, d.treasury), d.treasury, d.quoteMint),
    createAssociatedTokenAccountIdempotentInstruction(who, d.liquidityQuote, d.liquidityAuthority, d.quoteMint),
    createAssociatedTokenAccountIdempotentInstruction(who, d.liquidityBase, d.liquidityAuthority, d.baseMint),
  ]
}

/**
 * Anyone, once a raise has ended above its goal and before its deadline: settles it and
 * opens exactly the DAO and the pool it committed to, in one instruction. Send
 * `bootstrapAccountIxs` first.
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

/**
 * Whether the DAO pool's price is within the price guard's band (5%) of the DAO's
 * checkpoint: what moving its liquidity needs. Compared squared, as the program does.
 */
export async function withinPriceBand(connection, d) {
  const pool = await programs(connection).cpAmm.account.pool.fetch(d.pool)
  const spot = num(pool.sqrtPrice)
  const check = d.checkpoint.sqrtPrice
  if (!check) return false
  const ratio = (spot * spot * 10_000n) / (check * check)
  return ratio >= 9_500n && ratio <= 10_500n
}

export async function recordPriceIx(connection, d) {
  return programs(connection).futarchy.methods.recordPrice().accountsStrict({ dao: d.dao, pool: d.pool }).instruction()
}

/**
 * Opening a proposal: the proposal, its stake and its vault. Its two markets come next, in
 * a transaction of their own (`marketsIx`): together they ran past Solana's 64-instruction
 * trace once someone funded their addresses beforehand (4th audit M3). Then its option's
 * actions and taking the liquidity out (`setActionsIx`, `prepareIx`); anyone launches it.
 */
export async function proposeIxs(connection, d, id, creator, metadata = null) {
  const p = programs(connection)
  const q = proposalAddresses(d, id)
  const [o0, o1] = q.options
  const who = new PublicKey(creator)
  // No instruction opening the proposer's token account: whoever can stake already has one.
  return [
    await p.futarchy.methods.initializeProposal(metadata).accountsStrict({
      creator: who, moderator: d.moderator, dao: d.dao, proposal: q.proposal,
      pool: d.pool, tokenMint: d.baseMint, creatorToken: ata(d.baseMint, who), stakeEscrow: q.stakeEscrow,
      ...cpiPrograms,
    }).remainingAccounts([
      meta(d.baseMint, false), meta(d.quoteMint, false), meta(q.vault), meta(ata(d.baseMint, q.vault)), meta(ata(d.quoteMint, q.vault)),
      meta(o0.condBase), meta(o1.condBase), meta(o0.condQuote), meta(o1.condQuote),
    ]).instruction(),
  ]
}

/** Anyone: a proposal's two markets, once it is open and before its liquidity comes out. */
export async function marketsIx(connection, d, id, payer) {
  const q = proposalAddresses(d, id)
  return programs(connection).futarchy.methods.createProposalMarkets().accountsStrict({
    payer: new PublicKey(payer), proposal: q.proposal, dao: d.dao,
    systemProgram: SystemProgram.programId, ammProgram: PROGRAM_IDS.amm, tokenProgram: TOKEN_PROGRAM_ID,
  }).remainingAccounts([
    ...q.options.flatMap((o) => [meta(o.condQuote), meta(o.condBase), meta(o.pool), meta(o.reserveA), meta(o.reserveB), meta(o.feeVault)]),
    meta(FEE_AUTHORITY, false),
  ]).instruction()
}

/**
 * Withdraws a proposal whose liquidity never came out, its stake back whole to its creator:
 * the creator any time, anyone after a day (4th audit M9).
 */
export async function cancelProposalIx(connection, d, id, signer, creator) {
  const q = proposalAddresses(d, id)
  return programs(connection).futarchy.methods.cancelProposal().accountsStrict({
    signer: new PublicKey(signer), proposal: q.proposal, stakeEscrow: q.stakeEscrow, creator: new PublicKey(creator),
    tokenMint: d.baseMint, creatorToken: ata(d.baseMint, creator),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction()
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
    payer: new PublicKey(payer), dao: d.dao, liquidityAuthority: d.liquidityAuthority, treasury: d.treasury,
    // LFOwn's half waits in escrows of the program until the fee wallet withdraws it.
    protocol: pda(PROGRAM_IDS.futarchy, ['protocol_fees']),
    baseMint: d.baseMint, quoteMint: d.quoteMint, liquidityBase: d.liquidityBase, liquidityQuote: d.liquidityQuote,
    treasuryBase: ata(d.baseMint, d.treasury), treasuryQuote: ata(d.quoteMint, d.treasury),
    protocolBase: pda(PROGRAM_IDS.futarchy, ['protocol_fees', d.baseMint]), protocolQuote: pda(PROGRAM_IDS.futarchy, ['protocol_fees', d.quoteMint]),
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

/** A token account's balance, or 0 when it does not exist. */
async function balanceOf(connection, address) {
  const info = await connection.getAccountInfo(address)
  return info ? new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true) : 0n
}

/**
 * Splits `amount` of the coin (`side: 'quote'`) or of the token (`'base'`) into one
 * conditional unit per option — each a claim on it if that option wins — with the
 * trader's conditional accounts opened first.
 */
async function splitIxs(p, d, q, who, side, amount) {
  const mint = side === 'quote' ? d.quoteMint : d.baseMint
  const cond = side === 'quote' ? 'condQuote' : 'condBase'
  const opens = q.options.flatMap((x) => [
    createAssociatedTokenAccountIdempotentInstruction(who, ata(x.condQuote, who), who, x.condQuote),
    createAssociatedTokenAccountIdempotentInstruction(who, ata(x.condBase, who), who, x.condBase),
  ])
  if (amount <= 0n) return opens
  const split = await p.vault.methods.deposit({ [side]: {} }, new BN(amount.toString())).accountsStrict({
    signer: who, vault: q.vault, mint, vaultAta: ata(mint, q.vault), userAta: ata(mint, who),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).remainingAccounts(q.options.flatMap((x) => [meta(x[cond]), meta(ata(x[cond], who))])).instruction()
  return [...opens, split]
}

/**
 * Buying an option, as on MetaDAO: `amount` of the coin (META…) goes in. What the trader
 * already holds of that option's conditional coin is used first; the rest of the coin is
 * split into one conditional coin per option, and that option's is swapped into its
 * conditional token. If the option wins the trader keeps the token; if not, the other
 * options' conditional coins redeem for the coin. Bounded by `slippageBps`.
 */
export async function backOptionIxs(connection, d, id, trader, optionIndex, amount, { slippageBps = 200 } = {}) {
  const p = programs(connection)
  const q = proposalAddresses(d, id)
  const who = new PublicKey(trader)
  const o = q.options[optionIndex]
  const units = BigInt(amount)
  // The pool's own count of its reserves, which is what it prices with.
  const [market, held] = await Promise.all([p.amm.account.poolAccount.fetch(o.pool), balanceOf(connection, ata(o.condQuote, who))])
  const expected = swapOutput(units, num(market.reserveA), num(market.reserveB), market.fee)
  const minOut = (expected * BigInt(10_000 - slippageBps)) / 10_000n
  const buy = await p.amm.methods.swap(true, new BN(units.toString()), new BN(minOut.toString())).accountsStrict({
    trader: who, pool: o.pool, reserveA: o.reserveA, reserveB: o.reserveB, feeVault: o.feeVault,
    traderAccountA: ata(o.condQuote, who), traderAccountB: ata(o.condBase, who), tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction()
  return [...(await splitIxs(p, d, q, who, 'quote', units > held ? units - held : 0n)), buy]
}

/** What selling `amountIn` of a market's token yields in its coin, as the amm computes it. */
export function sellOutput(amountIn, reserveBase, reserveQuote, feeBps) {
  const gross = (amountIn * reserveQuote) / (reserveBase + amountIn)
  let fee = (gross * BigInt(feeBps)) / 10_000n
  if (feeBps > 0 && fee === 0n) fee = 1n
  return gross > fee ? gross - fee : 0n
}

/**
 * Selling an option, as on MetaDAO: `amount` of the DAO's token goes in. What the trader
 * already holds of that option's conditional token is used first; the rest of the token is
 * split into one conditional token per option, and that option's is swapped into its
 * conditional coin. If the option wins the trader has the coin instead of the token; if
 * not, the other options' conditional tokens redeem for the token. Bounded by `slippageBps`.
 */
export async function sellOptionIxs(connection, d, id, trader, optionIndex, amount, { slippageBps = 200 } = {}) {
  const p = programs(connection)
  const q = proposalAddresses(d, id)
  const o = q.options[optionIndex]
  const who = new PublicKey(trader)
  const units = BigInt(amount)
  const [market, held] = await Promise.all([p.amm.account.poolAccount.fetch(o.pool), balanceOf(connection, ata(o.condBase, who))])
  const expected = sellOutput(units, num(market.reserveB), num(market.reserveA), market.fee)
  const minOut = (expected * BigInt(10_000 - slippageBps)) / 10_000n
  const sell = await p.amm.methods.swap(false, new BN(units.toString()), new BN(minOut.toString())).accountsStrict({
    trader: who, pool: o.pool, reserveA: o.reserveA, reserveB: o.reserveB, feeVault: o.feeVault,
    traderAccountA: ata(o.condQuote, who), traderAccountB: ata(o.condBase, who), tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction()
  return [...(await splitIxs(p, d, q, who, 'base', units > held ? units - held : 0n)), sell]
}

/** A trader's conditional coins and tokens in each of a proposal's markets. */
export async function readPosition(connection, d, id, trader) {
  const who = new PublicKey(trader)
  const q = proposalAddresses(d, id)
  const addresses = q.options.flatMap((o) => [ata(o.condQuote, who), ata(o.condBase, who)])
  const infos = await connection.getMultipleAccountsInfo(addresses)
  const amount = (info) => (info ? new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true) : 0n)
  return q.options.map((_, i) => ({ coin: amount(infos[2 * i]), token: amount(infos[2 * i + 1]) }))
}

/**
 * A proposal's markets as their transactions tell it, the newest `limit` of each: every
 * TWAP update (the chart) and every trade. Read from the amm's events in the logs, since
 * a pool keeps only its latest state. One transaction often touches both markets — a
 * crank does — and an amm event does not name its pool, so each event is matched to the
 * amm instruction that logged it, and that instruction to its pool.
 */
export async function marketHistory(connection, d, id, { limit = 60 } = {}) {
  const coder = new BorshCoder(ammIdl)
  const amm = PROGRAM_IDS.amm.toBase58()
  const q = proposalAddresses(d, id)
  const pools = q.options.map((o) => o.pool.toBase58())
  const lists = await Promise.all(q.options.map((o) => connection.getSignaturesForAddress(o.pool, { limit }, 'confirmed')))
  const seen = new Map()
  for (const x of lists.flat()) if (!x.err) seen.set(x.signature, x)
  const sigs = [...seen.values()]
  const points = q.options.map(() => [])
  const trades = []
  // An RPC takes twenty calls per request through the site's proxy.
  for (let i = 0; i < sigs.length; i += 20) {
    const batch = sigs.slice(i, i + 20)
    const txs = await connection.getTransactions(batch.map((x) => x.signature), { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    txs.forEach((tx, j) => {
      if (!tx?.meta?.logMessages) return
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
      const key = (index) => keys.get(index)?.toBase58()
      // The amm's instructions in the order they ran: each top-level one, then its inner ones.
      const calls = []
      tx.transaction.message.compiledInstructions.forEach((ix, top) => {
        const all = [{ program: ix.programIdIndex, accounts: ix.accountKeyIndexes }]
        for (const group of tx.meta.innerInstructions ?? []) {
          if (group.index === top) for (const inner of group.instructions) all.push({ program: inner.programIdIndex, accounts: inner.accounts })
        }
        for (const call of all) {
          if (key(call.program) !== amm) continue
          const touched = call.accounts.map(key)
          calls.push(pools.findIndex((pool) => touched.includes(pool)))
        }
      })
      let next = 0
      let option = -1
      for (const line of tx.meta.logMessages) {
        if (line.startsWith(`Program ${amm} invoke`)) { option = calls[next++] ?? -1; continue }
        if (line.startsWith(`Program ${amm} success`) || line.startsWith(`Program ${amm} failed`)) { option = -1; continue }
        if (option < 0 || !line.startsWith('Program data: ')) continue
        let event = null
        try { event = coder.events.decode(line.slice('Program data: '.length)) } catch {}
        if (!event) continue
        const f = (snake, camel) => event.data[camel] ?? event.data[snake]
        if (event.name === 'TWAPUpdate' || event.name === 'TwapUpdate') {
          points[option].push({ t: Number(f('unix_time', 'unixTime')), price: num(event.data.price), observation: num(event.data.observation) })
        } else if (event.name === 'CondSwap') {
          trades.push({
            option, t: batch[j].blockTime ?? 0, signature: batch[j].signature, trader: event.data.trader.toBase58(),
            buy: Boolean(f('swap_a_to_b', 'swapAToB')), input: num(f('input_amount', 'inputAmount')), output: num(f('output_amount', 'outputAmount')),
          })
        }
      }
    })
  }
  return { points: points.map((series) => series.sort((a, b) => a.t - b.t)), trades: trades.sort((a, b) => b.t - a.t) }
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
  const [a, moderator] = await Promise.all([
    p.futarchy.account.daoAccount.fetchNullable(d.dao),
    p.futarchy.account.moderatorAccount.fetchNullable(d.moderator),
  ])
  if (!a || !moderator) return null
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

/** Accounts of `name`, decoded one by one: null where missing or not that account. */
async function decodeEach(connection, program, name, addresses) {
  const wanted = addresses.map((a, i) => [a, i]).filter(([a]) => a)
  const out = addresses.map(() => null)
  for (let k = 0; k < wanted.length; k += 100) {
    const slice = wanted.slice(k, k + 100)
    const infos = await connection.getMultipleAccountsInfo(slice.map(([a]) => a))
    infos.forEach((info, j) => {
      if (!info || !info.owner.equals(program.programId)) return
      try { out[slice[j][1]] = program.coder.accounts.decode(name, info.data) } catch { /* not that account */ }
    })
  }
  return out
}

/**
 * A DAO's proposals, newest first — every one below `count`, or only `ids`. Read in three
 * requests whatever their number: the proposals, their markets, their options' actions.
 */
export async function readProposals(connection, d, count, { ids } = {}) {
  const p = programs(connection)
  const wanted = (ids ?? Array.from({ length: count }, (_, i) => i)).filter((id) => id >= 0 && id < count).sort((x, y) => y - x)
  const qs = wanted.map((id) => proposalAddresses(d, id))
  // Decoded one by one, and only option 1's actions: anyone can send lamports to any
  // address, and one account that is not what it should be must not break the whole read
  // (4th audit M5: an empty account at option 0's actions address broke every page).
  const [accounts, markets, actions] = await Promise.all([
    decodeEach(connection, p.futarchy, 'proposalAccount', qs.map((q) => q.proposal)),
    decodeEach(connection, p.amm, 'poolAccount', qs.flatMap((q) => q.options.map((o) => o.pool))),
    decodeEach(connection, p.futarchy, 'optionActions', qs.flatMap((q) => q.options.map((_, i) => (i ? q.actions(i) : null)))),
  ])
  const out = []
  qs.forEach((q, k) => {
    const a = accounts[k]
    if (!a) return
    const id = wanted[k]
    const state = stateName(a.state)
    const n = q.options.length
    const mine = markets.slice(k * n, (k + 1) * n)
    const acts = actions.slice(k * n, (k + 1) * n).map((x, i) => (i ? x : null))
    out.push({
      id, address: q.proposal.toBase58(), creator: a.creator.toBase58(), state,
      winner: state === 'resolved' ? Number(Object.values(a.state.resolved)[0]) : null,
      createdAt: Number(a.createdAt), resolvedAt: Number(a.resolvedAt), lengthMinutes: a.config.length, warmupSeconds: a.config.warmupDuration,
      marketBiasBps: a.config.marketBias, startingObservation: num(a.config.startingObservation),
      prepared: num(a.baseLiquidity) > 0n, stake: num(a.stake), marketsOpen: a.marketsOpen, openedAt: Number(a.openedAt),
      metadata: a.metadata,
      markets: mine.map((m, i) => (m ? {
        index: i, twap: twapOf(m.oracle), lastPrice: num(m.oracle.lastPrice), lastUpdate: Number(m.oracle.lastUpdateUnixTime),
        // Its spot price, coin per token, from the pool's own count of its reserves.
        reserveCoin: num(m.reserveA), reserveToken: num(m.reserveB), fee: m.fee,
        spot: num(m.reserveB) ? Number(num(m.reserveA)) / Number(num(m.reserveB)) : 0,
        startedAt: Number(m.oracle.createdAtUnixTime), endsAt: Number(m.oracle.endUnixTime), starting: num(m.oracle.startingObservation),
      } : null)),
      actions: acts.map((x) => x?.actions ?? []),
      executed: acts.map((x) => x?.executed ?? 0),
    })
  })
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
