// Building the launch transaction in the browser.
//
// The DBC config is not created per launch: LFOwn creates one config per ownership
// coin, once, with itself as fee claimer and the 50/50 split baked in. A creator
// only opens a pool on the config that already exists for the coin they picked.
// That is what makes the catalogue a catalogue.

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { FEES } from '../lib/config.mjs'
import * as builder from '../lib/launch-builder.mjs'

/** All RPC goes through our own Worker, so the upstream key stays server-side. */
export const connection = new Connection(`${location.origin}/api/rpc`, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')

/**
 * What a dev buy of `percent` of supply would cost, priced on the curve this config
 * opens with. The pool does not exist yet, so the SDK simulates it from the config.
 */
export async function devBuyCost({ config, percent }) {
  return builder.devBuyCost(client, { config, percent })
}

export async function configFor(mint, tier) {
  const res = await fetch(`/api/config/${mint}`)
  if (!res.ok) return null
  const { configs } = await res.json()
  const open = configs?.[tier]
  return open ? new PublicKey(open.config) : null
}

/** Whether this deployment can offer a creator the choice at all. */
export const canShareWithHolders = () => Boolean(FEES.holderPot)

/**
 * The launch, built by the same code the agent API and the devnet suite use — see
 * src/lib/launch-builder.mjs for what it contains and why it is shaped that way.
 */
export async function buildLaunch({ config, owner, token, devBuyQuote, seed, quoteMint, holderPct = 0 }) {
  // A seed means the address was ground to end in `own`; without one the mint is
  // just random, which is what a browser that could not run the search falls back to.
  const mint = seed ? Keypair.fromSeed(seed) : Keypair.generate()
  const built = await builder.buildLaunchTransactions({
    client, connection, config, creator: owner, token, devBuyQuote, mint, quoteMint, holderPct,
  })
  // Deliberately not signed here. Phantom will not simulate a transaction it is not
  // the only signer of, and warns on the approval screen; its guidance is to take
  // the wallet's signature first and attach the rest after. sendWithMint does that.
  return { ...built, mint }
}

/**
 * Attaches the new mint's signature to what the wallet just signed, and broadcasts.
 *
 * The mint keypair is generated in this browser and thrown away the moment the pool
 * exists: the config makes the mint authority immutable, so it can never sign
 * anything again.
 */
export async function sendWithMint(signedBytes, mint) {
  const tx = Transaction.from(signedBytes)
  tx.partialSign(mint)
  return connection.sendRawTransaction(tx.serialize())
}

/**
 * The same for a launch that came as more than one transaction, in order.
 *
 * Each is confirmed before the next is sent, because the next one depends on it: the
 * pool is handed to a vault that has to exist, and the hand-over rides with the
 * launch. Both were signed in a single approval, so waiting here costs the creator
 * nothing but the seconds the chain takes.
 */
export async function sendAllWithMint(signedList, mint, { say } = {}) {
  const { confirm } = await import('./funding.js')
  const signatures = []
  for (const [i, bytes] of signedList.entries()) {
    const last = i === signedList.length - 1
    const signature = await sendWithMint(bytes, mint)
    say?.(last
      ? `Sent — waiting for the network to confirm (signature ${signature.slice(0, 12)}…)`
      : 'Opening the fee vault — waiting for it to confirm before the launch goes out…')
    // Polled, never `connection.confirmTransaction`: that one subscribes over a
    // WebSocket, and /api/rpc only speaks HTTP. It gave up after 30 seconds with the
    // vault opened and the launch never sent. The first wait is kept well inside the
    // life of the blockhash both transactions were signed against, so the launch
    // behind it is still valid when it goes out.
    await confirm(connection, signature, {
      what: last ? 'The launch' : 'Opening the fee vault',
      timeoutMs: last ? 90_000 : 45_000,
    })
    signatures.push(signature)
  }
  return signatures
}
