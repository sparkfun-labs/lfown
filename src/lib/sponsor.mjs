// LFOwn — launches LFOwn pays for.
//
// A launch costs its creator about 0.025 SOL: rent for the mint, its metadata (and
// Metaplex's fee for creating it), the pool, two token vaults and the holders' fee
// vault, and the network fees — measured on devnet at 0.0206 for the pool and 0.0040
// for the vault. For a
// limited run of launches LFOwn pays that instead, so someone can launch holding
// nothing at all. The creator still signs: they own the coin and earn its fees.
//
// The browser builds the launch with LFOwn's sponsor key as fee payer and as the
// `payer` of the two account creations, the creator signs, and the Worker adds the
// sponsor's signature and sends it. The sponsor key signs whatever it is handed, so
// everything hangs on what this file lets through. The rule is narrow on purpose:
//
//   - only these programs: compute budget, the bonding curve, the fee-sharing vault,
//     and associated token accounts (the creator's own, for an initial buy);
//   - the sponsor appears as the fee payer, and as the `payer` account of exactly
//     two instructions — opening the pool and opening its fee vault — and nowhere else;
//   - the pool is opened on a config LFOwn itself created;
//   - the vault, when there is one, belongs to that pool's creator and that coin.
//
// No transfer out of the sponsor fits through that, and neither does a token
// account, a close, or any program we did not name. The Worker also simulates each
// transaction and refuses one that would take more from the sponsor than a launch
// can cost, which bounds what a mistake here could spend.

import { PublicKey } from '@solana/web3.js'

/** How many launches LFOwn pays for, in all. */
export const SPONSORED_LAUNCHES = 30

/** The most one transaction may take from the sponsor, rent and fee included. */
export const MAX_SPONSOR_LAMPORTS = 30_000_000 // 0.03 SOL; the pool transaction measures 0.0206

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'

/**
 * The fee payer pays the priority fee, price times units, and wallets write their own:
 * Phantom adds a unit limit and price to what it signs, at whatever the network asks
 * that minute. So neither is capped alone — the product is, at 0.001 SOL a transaction,
 * about ten times a busy day's fee and a twentieth of what a launch costs anyway.
 */
const MAX_PRIORITY_LAMPORTS = 1_000_000n
const MAX_UNIT_LIMIT = 1_400_000 // the runtime's own ceiling
const DEFAULT_UNITS_PER_IX = 200_000 // what the runtime allots when no limit is set
const MAX_SIGNERS = 3 // sponsor, creator, the new coin
const ASSOCIATED_TOKEN = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'

export class SponsorError extends Error {}
const refuse = (message) => { throw new SponsorError(message) }

const norm = (name) => String(name).replace(/_/g, '').toLowerCase()

/** The index of a named account in an instruction, from the program's own IDL. */
function accountIndex(program, instruction, account) {
  const ix = program.idl.instructions.find((i) => norm(i.name) === norm(instruction))
  const index = ix?.accounts.findIndex((a) => norm(a.name) === norm(account)) ?? -1
  if (index < 0) throw new Error(`IDL has no ${account} on ${instruction}`)
  return index
}

function decode(program, ix) {
  try {
    return norm(program.coder.instruction.decode(Buffer.from(ix.data))?.name ?? '')
  } catch {
    return ''
  }
}

/**
 * Whether `key` put a real signature on `tx`. web3 checks every signature present
 * against the message; this adds that `key`'s is one of them.
 */
function signedBy(tx, key) {
  const entry = tx.signatures.find((s) => s.publicKey.equals(key))
  return Boolean(entry?.signature) && tx.verifySignatures(false)
}

/**
 * Checks a launch the sponsor is asked to pay for. Returns what it opens, or throws a
 * SponsorError that says why it was refused.
 *
 * `transactions` are web3 Transactions, in the order they must land: an optional fee
 * vault, then the launch. `programs` are the bonding-curve and fee-sharing Anchor
 * programs, for their IDLs and coders. `configs` is every config LFOwn has opened.
 */
export function checkSponsored(transactions, { sponsor, programs, configs }) {
  const sponsorKey = new PublicKey(sponsor)
  const { dbc, dfs } = programs
  if (!Array.isArray(transactions) || transactions.length < 1 || transactions.length > 2) {
    refuse('a sponsored launch is one or two transactions')
  }

  const allowed = new Set([COMPUTE_BUDGET, ASSOCIATED_TOKEN, dbc.programId.toBase58(), dfs.programId.toBase58()])
  const POOL_PAYER = accountIndex(dbc, 'initializeVirtualPoolWithSplToken', 'payer')
  const POOL_CREATOR = accountIndex(dbc, 'initializeVirtualPoolWithSplToken', 'creator')
  const POOL_CONFIG = accountIndex(dbc, 'initializeVirtualPoolWithSplToken', 'config')
  const POOL_MINT = accountIndex(dbc, 'initializeVirtualPoolWithSplToken', 'baseMint')
  const POOL_QUOTE = accountIndex(dbc, 'initializeVirtualPoolWithSplToken', 'quoteMint')
  const HANDOVER_CREATOR = accountIndex(dbc, 'transferPoolCreator', 'creator')
  const HANDOVER_TO = accountIndex(dbc, 'transferPoolCreator', 'newCreator')
  const VAULT_PAYER = accountIndex(dfs, 'initializeFeeVaultPda', 'payer')
  const VAULT_OWNER = accountIndex(dfs, 'initializeFeeVaultPda', 'owner')
  const VAULT_BASE = accountIndex(dfs, 'initializeFeeVaultPda', 'base')
  const VAULT = accountIndex(dfs, 'initializeFeeVaultPda', 'feeVault')
  const VAULT_MINT = accountIndex(dfs, 'initializeFeeVaultPda', 'tokenMint')

  const ours = new Map(configs.map((c) => [c.config, c]))
  const found = { pools: [], handovers: [], vaults: [] }

  for (const [t, tx] of transactions.entries()) {
    if (!tx.feePayer?.equals(sponsorKey)) refuse(`transaction ${t} must name the sponsor as its fee payer`)
    if (tx.instructions.length > 10) refuse(`transaction ${t} carries too many instructions`)
    // Each signature costs its fee payer 5,000 lamports.
    if (tx.compileMessage().header.numRequiredSignatures > MAX_SIGNERS) refuse(`transaction ${t} asks for too many signatures`)

    const budget = { limit: null, price: 0n, seen: new Set() }
    for (const [i, ix] of tx.instructions.entries()) {
      const program = ix.programId.toBase58()
      if (!allowed.has(program)) refuse(`instruction ${t}.${i} calls a program a launch does not use (${program})`)
      const keys = ix.keys.map((k) => k.pubkey)
      const at = (n) => keys[n]
      const sponsorAt = keys.flatMap((k, n) => (k.equals(sponsorKey) ? [n] : []))

      if (program === COMPUTE_BUDGET) {
        // 1 heap frame, 2 unit limit, 3 unit price, 4 loaded-data limit: the four a wallet
        // or the SDK may set. Only the price costs lamports, and it is capped below.
        const data = Buffer.from(ix.data)
        const kind = data[0]
        if (budget.seen.has(kind)) refuse(`instruction ${t}.${i} sets the same compute budget twice`)
        budget.seen.add(kind)
        if (kind === 1 && data.length >= 5 && data.readUInt32LE(1) <= 256 * 1024) continue
        if (kind === 2 && data.length >= 5 && data.readUInt32LE(1) <= MAX_UNIT_LIMIT) { budget.limit = data.readUInt32LE(1); continue }
        if (kind === 3 && data.length >= 9) { budget.price = data.readBigUInt64LE(1); continue }
        if (kind === 4 && data.length >= 5) continue
        refuse(`instruction ${t}.${i} sets a compute budget the sponsor will not pay for`)
      }

      let name = ''
      if (program === dbc.programId.toBase58()) name = decode(dbc, ix)
      if (program === dfs.programId.toBase58()) name = decode(dfs, ix)

      if (name === norm('initializeVirtualPoolWithSplToken') && program === dbc.programId.toBase58()) {
        if (sponsorAt.some((n) => n !== POOL_PAYER)) refuse(`instruction ${t}.${i} uses the sponsor as more than the payer`)
        found.pools.push({ t, creator: at(POOL_CREATOR), config: at(POOL_CONFIG), mint: at(POOL_MINT), quote: at(POOL_QUOTE) })
        continue
      }
      if (name === norm('initializeFeeVaultPda') && program === dfs.programId.toBase58()) {
        if (sponsorAt.some((n) => n !== VAULT_PAYER)) refuse(`instruction ${t}.${i} uses the sponsor as more than the payer`)
        found.vaults.push({ t, owner: at(VAULT_OWNER), base: at(VAULT_BASE), vault: at(VAULT), mint: at(VAULT_MINT) })
        continue
      }
      if (name === norm('transferPoolCreator') && program === dbc.programId.toBase58()) {
        found.handovers.push({ t, creator: at(HANDOVER_CREATOR), to: at(HANDOVER_TO) })
      }
      // Every other instruction — a buy, an account, a budget — pays its own way.
      if (sponsorAt.length) refuse(`instruction ${t}.${i} would spend the sponsor's SOL`)
      // Whitelisted programs, but only these of their instructions.
      if (program === dbc.programId.toBase58() && !['swap', norm('transferPoolCreator')].includes(name)) {
        refuse(`instruction ${t}.${i} is not part of a launch (${name || 'unknown'})`)
      }
      if (program === dfs.programId.toBase58()) refuse(`instruction ${t}.${i} is not part of a launch (${name || 'unknown'})`)
    }

    // Price is in micro-lamports per unit; with no limit set the runtime allots 200k per
    // instruction, so that is what the price is charged on.
    const others = tx.instructions.filter((ix) => ix.programId.toBase58() !== COMPUTE_BUDGET).length
    const units = BigInt(budget.limit ?? Math.min(MAX_UNIT_LIMIT, others * DEFAULT_UNITS_PER_IX))
    const priority = (budget.price * units + 999_999n) / 1_000_000n
    if (priority > MAX_PRIORITY_LAMPORTS) {
      refuse(`transaction ${t} asks for a priority fee of ${Number(priority) / 1e9} SOL, more than the sponsor pays`)
    }
  }

  // One pool, in the last transaction, on a config LFOwn opened.
  if (found.pools.length !== 1) refuse('a sponsored launch opens exactly one pool')
  const pool = found.pools[0]
  const last = transactions.length - 1
  if (pool.t !== last) refuse('the pool is opened by the last transaction')
  const config = ours.get(pool.config.toBase58())
  if (!config) refuse('that pool is not on a config LFOwn opened')
  if (config.mint !== pool.quote.toBase58()) refuse('the pool pairs with a different coin than its config')

  // The creator and the new coin both signed the launch; the coin signed the vault too.
  const launch = transactions[last]
  if (!signedBy(launch, pool.creator)) refuse('the creator has not signed the launch')
  if (!signedBy(launch, pool.mint)) refuse('the new coin has not signed the launch')

  // A vault, when there is one, is this coin's and this creator's, opened first, and
  // the pool is handed to it in the launch.
  if (transactions.length === 2) {
    if (found.vaults.length !== 1 || found.vaults[0].t !== 0) refuse('the first transaction opens exactly one fee vault')
    const v = found.vaults[0]
    if (!v.base.equals(pool.mint)) refuse('the fee vault belongs to a different coin')
    if (!v.owner.equals(pool.creator)) refuse('the fee vault belongs to someone other than the creator')
    if (!v.mint.equals(pool.quote)) refuse('the fee vault collects a different coin than the pool pays')
    if (!signedBy(transactions[0], pool.mint)) refuse('the new coin has not signed the fee vault')
    if (found.handovers.length !== 1 || !found.handovers[0].to.equals(v.vault) || !found.handovers[0].creator.equals(pool.creator)) {
      refuse('the launch must hand the pool to its fee vault')
    }
  } else if (found.vaults.length || found.handovers.length) {
    refuse('a fee vault is opened in its own transaction, before the launch')
  }

  return {
    creator: pool.creator.toBase58(),
    baseMint: pool.mint.toBase58(),
    quoteMint: pool.quote.toBase58(),
    config: pool.config.toBase58(),
    vault: found.vaults[0]?.vault.toBase58() ?? null,
  }
}
