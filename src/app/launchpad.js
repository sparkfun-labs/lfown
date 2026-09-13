// Building the launch transaction in the browser.
//
// The DBC config is not created per launch: LFOwn creates one config per ownership
// coin, once, with itself as fee claimer and the 50/50 split baked in. A creator
// only opens a pool on the config that already exists for the coin they picked.
// That is what makes the catalogue a catalogue.

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { DynamicBondingCurveClient, deriveDbcPoolAddress, deriveDbcEventAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DynamicFeeSharingClient } from '@meteora-ag/dynamic-fee-sharing-sdk'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import BN from 'bn.js'
import { FEES } from '../lib/config.mjs'
import { clampHolderPct, deriveVault, vaultShares } from '../lib/fee-split.mjs'

/** All RPC goes through our own Worker, so the upstream key stays server-side. */
export const connection = new Connection(`${location.origin}/api/rpc`, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')

/**
 * What a dev buy of `percent` of supply would cost, priced on the curve this config
 * opens with. The pool does not exist yet, so the SDK simulates it from the config.
 */
export async function devBuyCost({ config, percent }) {
  const state = await client.state.getPoolConfig(new PublicKey(config))
  const supply = Number(state.postMigrationTokenSupply?.toString() ?? 0)
    || Number(state.preMigrationTokenSupply?.toString() ?? 0)
  if (!supply) throw new Error('this config does not declare a supply')

  const baseOut = Math.floor((supply * percent) / 100)
  const quote = await client.pool.getQuoteFromOutputAmount({
    config: state,
    swapBaseForQuote: false,
    amountOut: new BN(baseOut.toString()),
    slippageBps: 0,
  })
  // The exact-out quote reports what goes in fee-inclusive; that is what the buyer
  // actually parts with.
  const input = quote.includedFeeInputAmount ?? quote.maximumAmountIn ?? quote.amountIn
  return {
    baseOut: baseOut / 1e6,
    quoteIn: Number((input ?? 0).toString()) / 1e6,
  }
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
 * Opens the pool, and buys into it in the same transaction when a dev buy is set —
 * atomically, so the launch cannot be sniped between the two instructions.
 *
 * A creator sharing part of their fees with holders gets a second transaction, and
 * it goes first: fees are paid to whoever the pool calls its creator, so that has to
 * be the vault from the very first trade. Opening the vault before the pool also
 * decides what a half-finished launch leaves behind — an empty vault nobody will
 * look at, rather than a coin promising a share it has no way to pay.
 */
export async function buildLaunch({ config, owner, token, devBuyQuote, seed, quoteMint, holderPct = 0 }) {
  // A seed means the address was ground to end in `own`; without one the mint is
  // just random, which is what a browser that could not run the search falls back to.
  const baseMint = seed ? Keypair.fromSeed(seed) : Keypair.generate()
  const payer = new PublicKey(owner)

  const createPoolParam = {
    baseMint: baseMint.publicKey,
    config,
    name: token.name,
    symbol: token.symbol,
    uri: token.uri ?? '',
    payer,
    poolCreator: payer,
  }

  // The pool does not exist until this transaction lands, so the buy cannot be
  // built from its on-chain state. createPoolWithFirstBuy assembles both against
  // the config instead, and lands them together — the launch cannot be sniped
  // between creation and the creator's own buy.
  const tx = devBuyQuote > 0
    ? await client.creator.createPoolWithFirstBuy({
        createPoolParam,
        firstBuyParam: {
          buyer: payer,
          receiver: payer,
          buyAmount: new BN(devBuyQuote),
          minimumAmountOut: new BN(0),
          referralTokenAccount: null,
        },
      })
    : await client.creator.createPool(createPoolParam)

  const transaction = tx.transaction ?? tx // createPool returns a Transaction, not a wrapper

  const share = clampHolderPct(holderPct)
  let vault = null
  const before = []
  if (share > 0 && FEES.holderPot && quoteMint) {
    const quote = new PublicKey(quoteMint)
    vault = deriveVault(baseMint.publicKey, quote)
    const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
    const open = await dfs.createFeeVaultPda({
      base: baseMint.publicKey,
      tokenMint: quote,
      tokenProgram: TOKEN_PROGRAM_ID,
      owner: payer,
      payer,
      userShare: vaultShares(share, { creator: payer, holders: FEES.holderPot }),
    })
    before.push(new Transaction().add(...open.instructions))

    // Built by hand rather than through `client.creator.transferPoolCreator`, which
    // reads the pool from chain to find its config — and the pool does not exist
    // until the instruction above it in this same transaction has run.
    const program = client.state.program ?? client.program
    transaction.add(await program.methods
      .transferPoolCreator()
      .accountsPartial({
        virtualPool: deriveDbcPoolAddress(quote, baseMint.publicKey, config),
        config,
        creator: payer,
        newCreator: vault,
        eventAuthority: deriveDbcEventAuthority(),
        program: program.programId,
      })
      .instruction())
  }

  const transactions = [...before, transaction]
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  for (const t of transactions) {
    t.recentBlockhash = blockhash
    t.feePayer = payer
  }

  // Deliberately not signed here. Phantom will not simulate a transaction it is not
  // the only signer of, and warns on the approval screen; its guidance is to take
  // the wallet's signature first and attach the rest after. sendWithMint does that.
  return {
    transactions,
    transaction, // the launch itself, for callers that only ever have the one
    mint: baseMint,
    baseMint: baseMint.publicKey.toBase58(),
    vault: vault?.toBase58() ?? null,
    holderPct: vault ? share : 0,
  }
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
export async function sendAllWithMint(signedList, mint) {
  const signatures = []
  for (const bytes of signedList) {
    const signature = await sendWithMint(bytes, mint)
    await connection.confirmTransaction(signature, 'confirmed')
    signatures.push(signature)
  }
  return signatures
}
