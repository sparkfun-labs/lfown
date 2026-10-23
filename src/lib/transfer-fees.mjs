// LFOWN — the transfer fee every current coin charges, collected and handed to holders.
//
// A coin from a current config is Token-2022 and withholds FEES.transferFeeBps of every
// transfer in the account that receives it: a buyer's, a seller's pool vault, anyone's.
// Nobody can spend a withheld amount but the withdraw authority, which the config made
// LFOWN's fee claimer. Collecting is two steps — harvest every account's withheld amount
// into the mint (permissionless), then withdraw the mint's to the collector — and the
// hourly run then shares it out in the coin, by FEES.transferFeeSplit: the DAO's part to
// the treasury, the creator's to the creator, and the holders' among the holders through
// the same allocation as the creator-shared fees (`payoutInstructions`).

import { PublicKey, Transaction } from '@solana/web3.js'
import {
  createHarvestWithheldTokensToMintInstruction, createWithdrawWithheldTokensFromMintInstruction,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, createTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'

/** Token-2022 extensions sit after the 165-byte base and a one-byte account type. */
const TLV_START = 166
/** Extension types: TransferFeeConfig on a mint, TransferFeeAmount on an account. */
const TRANSFER_FEE_CONFIG = 1
const TRANSFER_FEE_AMOUNT = 2
/** Accounts harvested per instruction: each is a writable key, and a transaction holds ~35. */
export const HARVEST_BATCH = 20

function extension(bytes, type) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let o = TLV_START; o + 4 <= bytes.length;) {
    const t = view.getUint16(o, true)
    const length = view.getUint16(o + 2, true)
    if (t === type) return new DataView(bytes.buffer, bytes.byteOffset + o + 4, length)
    if (t === 0 && length === 0) break
    o += 4 + length
  }
  return null
}

/** What a Token-2022 token account has withheld and not yet harvested, in base units. */
export function withheldInAccount(bytes) {
  return extension(bytes, TRANSFER_FEE_AMOUNT)?.getBigUint64(0, true) ?? 0n
}

/**
 * What a Token-2022 mint holds harvested and not yet withdrawn, in base units: the
 * TransferFeeConfig's withheld amount, after its two 32-byte authorities.
 */
export function withheldInMint(bytes) {
  return extension(bytes, TRANSFER_FEE_CONFIG)?.getBigUint64(64, true) ?? 0n
}

/**
 * Every token account of `mint`, with its owner and balance, from Helius's
 * `getTokenAccounts` (paged). Empty accounts are kept: a holder who sold everything still
 * carries what was withheld when they bought.
 */
export async function tokenAccounts(rpcUrl, mint) {
  const out = []
  let cursor
  for (let page = 0; page < 50; page++) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccounts', params: { mint, limit: 1000, ...(cursor ? { cursor } : {}) } }),
    })
    const body = await res.json()
    if (body.error) throw new Error(`getTokenAccounts: ${body.error.message ?? body.error}`)
    const accounts = body.result?.token_accounts ?? []
    for (const a of accounts) out.push({ address: a.address, owner: a.owner, amount: BigInt(a.amount) })
    cursor = body.result?.cursor
    if (!cursor || accounts.length === 0) break
  }
  return out
}

/**
 * What a coin has withheld across its accounts and its mint, read in batches. `accounts`
 * come from `tokenAccounts`. Returns the accounts still to harvest and the total, in base
 * units, that a collection would bring in.
 */
export async function withheldOf(connection, mint, accounts) {
  const toHarvest = []
  let inAccounts = 0n
  for (let i = 0; i < accounts.length; i += 100) {
    const slice = accounts.slice(i, i + 100)
    const infos = await connection.getMultipleAccountsInfo(slice.map((a) => new PublicKey(a.address)))
    infos.forEach((info, j) => {
      if (!info) return
      const withheld = withheldInAccount(new Uint8Array(info.data))
      if (withheld > 0n) { toHarvest.push(slice[j].address); inAccounts += withheld }
    })
  }
  const mintInfo = await connection.getAccountInfo(new PublicKey(mint))
  const inMint = mintInfo ? withheldInMint(new Uint8Array(mintInfo.data)) : 0n
  return { toHarvest, inAccounts, inMint, total: inAccounts + inMint }
}

/**
 * The transactions that collect a coin's withheld fee into `collector`'s account of it:
 * the harvests, then one withdrawal, which also opens that account if it is missing.
 * `collector` is the withdraw authority and signs the last one.
 */
export function collectTransactions(mint, toHarvest, collector) {
  const mintKey = new PublicKey(mint)
  const txs = []
  for (let i = 0; i < toHarvest.length; i += HARVEST_BATCH) {
    txs.push(new Transaction().add(createHarvestWithheldTokensToMintInstruction(
      mintKey, toHarvest.slice(i, i + HARVEST_BATCH).map((a) => new PublicKey(a)), TOKEN_2022_PROGRAM_ID)))
  }
  const owner = new PublicKey(collector)
  const destination = getAssociatedTokenAddressSync(mintKey, owner, false, TOKEN_2022_PROGRAM_ID)
  txs.push(new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(owner, destination, owner, mintKey, TOKEN_2022_PROGRAM_ID))
    .add(createWithdrawWithheldTokensFromMintInstruction(mintKey, destination, owner, [], TOKEN_2022_PROGRAM_ID)))
  return { txs, destination }
}

/**
 * A collected amount cut by `split` (percents): the DAO's and the creator's parts rounded
 * down, the holders' whatever is left, so the three always add up to the whole.
 */
export function splitCollected(amount, split) {
  const dao = (amount * BigInt(split.dao)) / 100n
  const creator = (amount * BigInt(split.creator)) / 100n
  return { dao, creator, holders: amount - dao - creator }
}

/**
 * Sends `amount` of the coin from `owner`'s account to `recipient`'s, opening the
 * recipient's account if it is missing (an off-curve owner, such as the DAO treasury, is
 * allowed). `payer` rents it. The coin charges its own transfer fee on the way.
 */
export function sendInstructions(mint, owner, recipient, amount, payer, decimals = 6) {
  const mintKey = new PublicKey(mint)
  const from = getAssociatedTokenAddressSync(mintKey, new PublicKey(owner), true, TOKEN_2022_PROGRAM_ID)
  const to = getAssociatedTokenAddressSync(mintKey, new PublicKey(recipient), true, TOKEN_2022_PROGRAM_ID)
  return [
    createAssociatedTokenAccountIdempotentInstruction(new PublicKey(payer), to, new PublicKey(recipient), mintKey, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(from, mintKey, to, new PublicKey(owner), amount, decimals, [], TOKEN_2022_PROGRAM_ID),
  ]
}
