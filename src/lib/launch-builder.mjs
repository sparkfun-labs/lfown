// LFOwn — the transactions that open a coin, for anyone who launches one.
//
// The launch page, the agent API and the devnet suite all build the same launch, so
// they all build it here. It used to live in the browser bundle alone, and a second
// copy for the server would have been a second place for a change to be forgotten.
//
// Nothing here signs. The caller holds the mint keypair — ground in the browser, or
// taken from the server's reserve — and the creator signs with their own wallet.
//
// The DBC config is not created per launch: LFOwn creates one config per ownership
// coin, once, with itself as fee claimer and the 50/50 split baked in. A creator only
// opens a pool on the config that already exists for the coin they picked.

import { PublicKey, Transaction } from '@solana/web3.js'
import { deriveDbcPoolAddress, deriveDbcEventAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DynamicFeeSharingClient } from '@meteora-ag/dynamic-fee-sharing-sdk'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import BN from 'bn.js'
import { FEES } from './config.mjs'
import { clampHolderPct, deriveVault, vaultShares } from './fee-split.mjs'

/**
 * What a dev buy of `percent` of supply would cost, priced on the curve this config
 * opens with. The pool does not exist yet, so the SDK simulates it from the config.
 */
export async function devBuyCost(client, { config, percent }) {
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

/**
 * Opens the pool, and buys into it in the same transaction when a dev buy is set —
 * atomically, so the launch cannot be sniped between the two instructions.
 *
 * A creator sharing part of their fees with holders gets a second transaction, and it
 * goes first: fees are paid to whoever the pool calls its creator, so that has to be
 * the vault from the very first trade. Opening the vault before the pool also decides
 * what a half-finished launch leaves behind — an empty vault nobody will look at,
 * rather than a coin promising a share it has no way to pay.
 *
 * Returns the transactions in the order they must land, each with its blockhash and
 * fee payer set and nobody's signature on it.
 */
export async function buildLaunchTransactions({
  client, connection, config, creator, token, devBuyQuote = 0, mint, quoteMint,
  holderPct = 0, holderPot = FEES.holderPot,
}) {
  const payer = new PublicKey(creator)
  const configKey = new PublicKey(config)

  const createPoolParam = {
    baseMint: mint.publicKey,
    config: configKey,
    name: token.name,
    symbol: token.symbol,
    uri: token.uri ?? '',
    payer,
    poolCreator: payer,
  }

  // The pool does not exist until this transaction lands, so the buy cannot be built
  // from its on-chain state. createPoolWithFirstBuy assembles both against the config
  // instead, and lands them together.
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
  if (share > 0 && holderPot && quoteMint) {
    const quote = new PublicKey(quoteMint)
    vault = deriveVault(mint.publicKey, quote)
    const dfs = new DynamicFeeSharingClient(connection, 'confirmed')
    const wanted = vaultShares(share, { creator: payer, holders: holderPot })

    // A retry after a launch that opened its vault and then failed. The same mint means
    // the same vault address, and opening it again would fail on an account that
    // already exists. If it is exactly the vault this launch wants, it is used as it
    // is, and its rent is not paid twice. If the split differs, it cannot be changed,
    // so the only way on is a new address.
    const existing = await connection.getAccountInfo(vault)
    if (existing) {
      const found = await dfs.getFeeVault(vault)
      const live = found.users.filter((u) => u.share > 0)
      const same = found.owner.equals(payer)
        && live.length === wanted.length
        && wanted.every((w) => live.some((u) => u.share === w.share && u.address.equals(w.address)))
      if (!same) {
        throw new Error('A fee vault already exists for this coin address with a different split, and a vault cannot be changed. Launch under a new address.')
      }
    } else {
      const open = await dfs.createFeeVaultPda({
        base: mint.publicKey,
        tokenMint: quote,
        tokenProgram: TOKEN_PROGRAM_ID,
        owner: payer,
        payer,
        userShare: wanted,
      })
      before.push(new Transaction().add(...open.instructions))
    }

    // Built by hand rather than through `client.creator.transferPoolCreator`, which
    // reads the pool from chain to find its config — and the pool does not exist
    // until the instruction above it in this same transaction has run.
    const program = client.state.program ?? client.program
    transaction.add(await program.methods
      .transferPoolCreator()
      .accountsPartial({
        virtualPool: deriveDbcPoolAddress(quote, mint.publicKey, configKey),
        config: configKey,
        creator: payer,
        newCreator: vault,
        eventAuthority: deriveDbcEventAuthority(),
        program: program.programId,
      })
      .instruction())
  }

  const transactions = [...before, transaction]
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  for (const t of transactions) {
    t.recentBlockhash = blockhash
    t.feePayer = payer
  }

  return {
    transactions,
    transaction, // the launch itself, for callers that only ever have the one
    lastValidBlockHeight,
    baseMint: mint.publicKey.toBase58(),
    pool: quoteMint ? deriveDbcPoolAddress(new PublicKey(quoteMint), mint.publicKey, configKey).toBase58() : null,
    vault: vault?.toBase58() ?? null,
    holderPct: vault ? share : 0,
  }
}
