// LFOwn — a creator's fees, paid to a wallet other than the one that launched.
//
// The vault a launch opens pays its creator slot to whatever address is written into
// it, and nothing requires that address to be the wallet signing the launch. So a fan
// can launch a coin whose creator fees belong to the person it is about, from the
// first trade and for good: that wallet claims them itself, with its own signature,
// and the launcher never touches them.
//
// For good is the point and the danger. The vault's shareholders cannot be edited
// once it exists, so a mistyped address is a share nobody will ever claim. Everything
// here is about refusing an address before it is written, rather than after.

import { PublicKey } from '@solana/web3.js'

/** Solana Name Service: the program, and the parent every `.sol` name hangs under. */
const SNS_PROGRAM = new PublicKey('namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX')
const SOL_TLD = new PublicKey('58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx')
const HASH_PREFIX = 'SPL Name Service'

/** A name as a person types it, reduced to what SNS hashes: `SrMessi.sol` → `srmessi`. */
export function solName(input) {
  const s = String(input ?? '').trim().toLowerCase()
  if (!s.endsWith('.sol')) return null
  const label = s.slice(0, -'.sol'.length)
  // One level only: a subdomain hangs under its parent name, not under `.sol`, and
  // resolving it as if it did would find a different account — or someone else's.
  if (!label || label.includes('.')) return null
  return label
}

/** The account that records who owns `label`.sol. */
export async function solNameAccount(label) {
  const bytes = new TextEncoder().encode(HASH_PREFIX + label)
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const [account] = PublicKey.findProgramAddressSync([hashed, new Uint8Array(32), SOL_TLD.toBytes()], SNS_PROGRAM)
  return account
}

/**
 * Who owns a `.sol` name, or null if nobody registered it.
 *
 * The owner, not the name's SOL record: the record is a second address its owner can
 * point anywhere, and a share written from it would follow whatever it said the day of
 * the launch. The owner is what the name service itself answers to. The caller shows
 * the address it resolved to, so nobody signs for a name without seeing where it goes.
 */
export async function resolveSolName(connection, input) {
  const label = solName(input)
  if (!label) return null
  const info = await connection.getAccountInfo(await solNameAccount(label))
  if (!info || info.data.length < 64) return null
  return new PublicKey(info.data.subarray(32, 64)).toBase58()
}

export class FeeWalletError extends Error {}

/**
 * The fee wallet a launch will write, or null for "the launcher keeps them".
 *
 * Refused, with a reason a person can act on:
 *   - anything that is not an address;
 *   - an address off the ed25519 curve. Those are program accounts — a vault, an
 *     escrow, a tokenized name — which cannot sign, and a claim needs a signature, so
 *     the share would sit there forever;
 *   - the holder pot, which already has its own slot: two slots for one address would
 *     hand holders the creator's part too.
 * The launcher's own address is not an error, just the ordinary case.
 */
export function checkFeeWallet(address, { owner, pot } = {}) {
  const s = String(address ?? '').trim()
  if (!s) return null
  let key
  try {
    key = new PublicKey(s)
  } catch {
    throw new FeeWalletError('That is not a Solana address.')
  }
  if (!PublicKey.isOnCurve(key.toBytes())) {
    throw new FeeWalletError('That address belongs to a program, not a wallet, and could never claim.')
  }
  const base58 = key.toBase58()
  if (pot && base58 === String(pot)) throw new FeeWalletError('That is the holders’ pot, which already has its share.')
  if (owner && base58 === String(owner)) return null
  return base58
}

// The FeeVault account, as Meteora lays it out (programs/dynamic-fee-sharing/src/state/
// fee_vault.rs): an 8-byte discriminator, then owner, token mint and token vault (32
// each), 16 bytes of flags, total share and padding (8), funded total (8), fee per share
// (16), base (32) and 64 bytes of padding — 248 bytes — then five 80-byte user slots,
// each an address followed by a u32 share.
const OWNER = 8
const USERS = 248
const USER_SIZE = 80
const MAX_USERS = 5

/**
 * Who a vault pays the creator's part to, when that is not the wallet that opened it.
 *
 * The creator's slot is the one shareholder that is not the holder pot. A vault with
 * any other shape — two such slots, none, the owner holding one of them — was not made
 * by the launch page's fee-wallet field, and is reported as nothing rather than guessed
 * at: a wrong answer here would put a claim button in front of the wrong person.
 */
export function feeWalletOf(data, { pot }) {
  if (!data || data.length < USERS + USER_SIZE * MAX_USERS) return null
  const owner = new PublicKey(data.subarray(OWNER, OWNER + 32)).toBase58()
  const holders = []
  for (let i = 0; i < MAX_USERS; i++) {
    const at = USERS + i * USER_SIZE
    const share = new DataView(data.buffer, data.byteOffset + at + 32, 4).getUint32(0, true)
    if (!share) continue
    holders.push(new PublicKey(data.subarray(at, at + 32)).toBase58())
  }
  const others = holders.filter((a) => a !== String(pot))
  if (others.length !== 1 || others[0] === owner) return null
  return others[0]
}
