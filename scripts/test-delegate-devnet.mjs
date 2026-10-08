// LFOwn — handing a vault coin's creator fees to another wallet, on devnet.
//
// A coin whose creator is a fee vault can never change hands: the vault's shareholders
// are fixed, and the vault cannot sign anything that would move the pool away from it.
// What stays free is *when* the creator's signature is used. A claim built on a durable
// nonce never expires, so the creator signs a stack of claims once, each paying their
// share to the delegate's account, and the delegate sends them whenever it likes.
//
// Proven here, against Meteora's fee-sharing program itself:
//   - the creator's wallet holds no SOL and signs once, up front;
//   - each pre-signed claim pays whatever is owed *when it is sent*, not when signed;
//   - a claim cannot be replayed, and the delegate cannot claim on its own;
//   - compute-budget instructions after the nonce, as a wallet would want, change nothing.
//
//   node scripts/test-delegate-devnet.mjs
//
// Spends devnet SOL from .keys/devnet.json only.

import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, NONCE_ACCOUNT_LENGTH,
  SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { DynamicFeeSharingClient, deriveFeeVaultPdaAddress } from '@meteora-ag/dynamic-fee-sharing-sdk'
import BN from 'bn.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const KEY = readFileSync('.dev.vars', 'utf8').match(/api-key=([a-f0-9-]+)/)[1]
const connection = new Connection(`https://devnet.helius-rpc.com/?api-key=${KEY}`, 'confirmed')
const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.keys/devnet.json', 'utf8'))))
const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`)
const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })

const creator = Keypair.generate() // the launcher's wallet: never funded
const delegate = Keypair.generate() // who the fees should go to
const pot = Keypair.generate() // stands in for LFOwn's holder pot

// A quote coin, and a vault on it split as LFOwn splits: creator 25, holders 75.
const quoteMint = await createMint(connection, funder, funder.publicKey, null, 6)
const base = Keypair.generate()
const feeVault = deriveFeeVaultPdaAddress(base.publicKey, quoteMint)
await send(await dfs.createFeeVaultPda({
  base: base.publicKey, tokenMint: quoteMint, tokenProgram: TOKEN_PROGRAM_ID,
  owner: creator.publicKey, payer: funder.publicKey,
  userShare: [{ address: creator.publicKey, share: 25 }, { address: pot.publicKey, share: 75 }],
}), [funder, base])
const funderAta = await getOrCreateAssociatedTokenAccount(connection, funder, quoteMint, funder.publicKey)
await mintTo(connection, funder, quoteMint, funderAta.address, funder, 10_000_000_000)
say(`vault ${feeVault.toBase58()} · creator 25 / pot 75`)

// The delegate funds itself, opens its token account, and opens one nonce account per
// claim it wants to be able to make — with itself as the nonce authority.
await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: delegate.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [funder])
const delegateAta = await getOrCreateAssociatedTokenAccount(connection, delegate, quoteMint, delegate.publicKey)
const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)
const nonces = [Keypair.generate(), Keypair.generate()]
for (const n of nonces) {
  await send(new Transaction().add(...SystemProgram.createNonceAccount({
    fromPubkey: delegate.publicKey, noncePubkey: n.publicKey, authorizedPubkey: delegate.publicKey, lamports: rent,
  }).instructions), [delegate, n])
}
say(`delegate ready: 2 nonce accounts at ${(rent / LAMPORTS_PER_SOL).toFixed(6)} SOL each`)

// The creator's one and only act: sign every claim, now. Each one says "pay my share
// to the delegate", nothing else. The delegate pays the network fee.
const state = await dfs.getFeeVault(feeVault)
const index = state.users.findIndex((u) => u.address.equals(creator.publicKey))
const claimIx = await dfs.program.methods.claimFee(index).accountsPartial({
  feeVault, tokenVault: state.tokenVault, tokenMint: quoteMint,
  userTokenVault: delegateAta.address, user: creator.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
}).instruction()

const signed = []
for (const n of nonces) {
  const { nonce } = await connection.getNonce(n.publicKey)
  const tx = new Transaction({ feePayer: delegate.publicKey, recentBlockhash: nonce }).add(
    SystemProgram.nonceAdvance({ noncePubkey: n.publicKey, authorizedPubkey: delegate.publicKey }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    claimIx,
  )
  tx.partialSign(creator)
  signed.push(tx.serialize({ requireAllSignatures: false }))
}
say(`creator signed ${signed.length} claims; creator SOL = ${await connection.getBalance(creator.publicKey)}`)

// Fees arrive after the creator has signed.
const fund = async (amount) => send(await dfs.fundFeeVault({ fundAmount: new BN(amount), funder: funder.publicKey, feeVault }), [funder])
const balance = async () => (await getAccount(connection, delegateAta.address)).amount

async function sendSigned(bytes) {
  const tx = Transaction.from(bytes)
  tx.partialSign(delegate)
  const sig = await connection.sendRawTransaction(tx.serialize())
  for (let i = 0; i < 40; i++) {
    const { value: [st] } = await connection.getSignatureStatuses([sig])
    if (st?.err) throw new Error(`claim failed: ${JSON.stringify(st.err)}`)
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('claim not confirmed')
}

// Long past a blockhash's life (~150 slots, about a minute): an ordinary transaction
// signed back then would now be refused.
say('waiting 90 s, past any blockhash expiry…')
await new Promise((r) => setTimeout(r, 90_000))

await fund(1_000_000_000) // 1000 tokens → creator's quarter is 250
await sendSigned(signed[0])
const first = await balance()
assert.equal(first, 250_000_000n)
say(`claim 1 sent by the delegate: +${Number(first) / 1e6} tokens`)

await fund(400_000_000) // 400 more → 100 owed now
await sendSigned(signed[1])
const second = await balance()
assert.equal(second - first, 100_000_000n)
say(`claim 2: +${Number(second - first) / 1e6} tokens — what was owed at sending time`)

// A used claim is dead: its nonce has moved on.
await assert.rejects(sendSigned(signed[0]))
say('replaying claim 1: refused')

// And the delegate has no power of its own over the creator's share.
const own = await dfs.program.methods.claimFee(index).accountsPartial({
  feeVault, tokenVault: state.tokenVault, tokenMint: quoteMint,
  userTokenVault: delegateAta.address, user: delegate.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
}).transaction()
await assert.rejects(send(own, [delegate]))
say('delegate claiming without a signed claim: refused')

assert.equal(await connection.getBalance(creator.publicKey), 0)
say('creator wallet still holds 0 SOL. All good.')
