// LFOwn fair launch — the site and the keeper against devnet, with a real Phantom.
//
//   node scripts/devnet-setup.mjs
//
// The programs themselves are deployed separately (anchor build, then `solana program
// deploy` with the upgrade authority in ~/.config/solana/id.json). This prepares the rest:
//
//   - a keeper key and a faucet key in .keys/devnet-fair/ (never committed, never
//     printed), funded from ~/.config/solana/id.json: the keeper pays for opening DAOs
//     and for every crank, the faucet for the token accounts it opens
//   - dMETA, a stand-in ownership coin (ownership coins do not exist on devnet), minted by
//     the faucet key; made once and kept, so reruns do not scatter coins
//   - the FAIR_* settings in the site's .dev.vars, pointing at Solana's public devnet RPC
//     (or FAIR_DEVNET_RPC, a devnet-only endpoint of your own), with three-minute raises
//     and five-minute proposals for testing. Never the production RPC key: a test setting
//     that leaks, or a keeper that loops, must not spend the site's quota
//
// Run it again to top the keeper up. `npm run localnet` writes localnet settings over
// these, and this writes devnet ones over those.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js'
import { MINT_SIZE, TOKEN_PROGRAM_ID, createInitializeMint2Instruction } from '@solana/spl-token'

const here = (p) => new URL(p, import.meta.url).pathname
const devVars = here('../../.dev.vars')
const RPC = process.env.FAIR_DEVNET_RPC || 'https://api.devnet.solana.com'
const connection = new Connection(RPC, 'confirmed')
if (await connection.getGenesisHash() !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('That RPC is not devnet.')

const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))))
const KEYS = here('../.keys/devnet-fair/')
mkdirSync(KEYS, { recursive: true })
const key = (name) => {
  const file = `${KEYS}${name}.json`
  if (!existsSync(file)) writeFileSync(file, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 })
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))))
}
const keeper = key('keeper')
const faucet = key('faucet')
const coin = key('coin')
const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })

// Topped up to a floor rather than sent a fixed amount, so reruns cost only what was spent.
async function topUp(who, sol) {
  const have = await connection.getBalance(who.publicKey)
  const want = Math.round(sol * LAMPORTS_PER_SOL)
  if (have >= want) return 0
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: who.publicKey, lamports: want - have })), [funder])
  return (want - have) / LAMPORTS_PER_SOL
}
const toKeeper = await topUp(keeper, 2)
const toFaucet = await topUp(faucet, 0.5)

if (!(await connection.getAccountInfo(coin.publicKey))) {
  await send(new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: faucet.publicKey, newAccountPubkey: coin.publicKey, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
      lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
    }),
    createInitializeMint2Instruction(coin.publicKey, 6, faucet.publicKey, null),
  ), [faucet, coin])
}

const settings = {
  FAIR_CLUSTER: 'devnet',
  FAIR_RPC: RPC,
  FAIR_QUOTES: JSON.stringify([{ mint: coin.publicKey.toBase58(), symbol: 'dMETA', name: 'Devnet META', usdPrice: 5.98 }]),
  FAIR_TERMS: JSON.stringify({ durationSeconds: 180, claimDelaySeconds: 900 }),
  FAIR_GOVERNANCE: JSON.stringify({ proposalLengthMinutes: 5, warmupSeconds: 60, maxObservationChangeBps: 1_000, executionDelaySeconds: 60, executionWindowSeconds: 3_600 }),
  FAIR_KEEPER_KEY: JSON.stringify([...keeper.secretKey]),
  FAIR_FAUCET_KEY: JSON.stringify([...faucet.secretKey]),
}
const kept = readFileSync(devVars, 'utf8').split('\n').filter((l) => !/^FAIR_[A-Z_]+=/.test(l))
while (kept.length && kept[kept.length - 1] === '') kept.pop()
writeFileSync(devVars, [...kept, '', ...Object.entries(settings).map(([k, v]) => `${k}=${v}`), ''].join('\n'))

console.log(`
devnet ready
  dMETA   ${coin.publicKey.toBase58()}
  keeper  ${keeper.publicKey.toBase58()} (+${toKeeper} SOL)
  faucet  ${faucet.publicKey.toBase58()} (+${toFaucet} SOL)
  FAIR_* settings written to .dev.vars

At the repo root:
  npm run dev                     /raise against devnet — Phantom in Testnet mode, Solana Devnet
  node scripts/fair-keeper.mjs    the keeper
`)
