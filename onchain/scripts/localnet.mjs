// LFOwn fair launch — a whole local chain to run it on.
//
//   anchor build && npm run fixtures   (once)
//   npm run localnet                    (keeps running; Ctrl-C stops the chain)
//
// Starts solana-test-validator with the four LFOwn programs as built, and Meteora's DAMM
// v2 and Metaplex's token metadata as deployed (dumped into tests/fixtures), then:
//
//   - a keeper key and a faucet key, kept in .keys/localnet/ (never committed, never printed)
//   - tMETA, a stand-in ownership coin whose mint authority is the faucet key
//   - the FAIR_* settings written into the site's .dev.vars, so `npm run dev` at the root
//     serves fair launches against this chain, and scripts/fair-keeper.mjs cranks them
//
// The raise lasts three minutes here and proposals five, so a whole launch — raise, DAO,
// proposal, decision — fits in a quarter of an hour.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { MINT_SIZE, TOKEN_PROGRAM_ID, createInitializeMint2Instruction } from '@solana/spl-token'

const here = (p) => new URL(p, import.meta.url).pathname
const RPC = 'http://127.0.0.1:8899'
const ids = (name) => JSON.parse(readFileSync(here(`../target/idl/${name}.json`), 'utf8')).address
const PROGRAMS = [
  [ids('lfown_raise'), here('../target/deploy/lfown_raise.so')],
  [ids('futarchy'), here('../target/deploy/futarchy.so')],
  [ids('amm'), here('../target/deploy/amm.so')],
  [ids('vault'), here('../target/deploy/vault.so')],
  ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', here('../tests/fixtures/cp_amm.so')],
  ['metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', here('../tests/fixtures/mpl_token_metadata.so')],
]
for (const [, file] of PROGRAMS) {
  if (!existsSync(file)) throw new Error(`${file} is missing: run \`anchor build\` and \`npm run fixtures\` first`)
}

const KEYS = here('../.keys/localnet/')
mkdirSync(KEYS, { recursive: true })
const key = (name) => {
  const file = `${KEYS}${name}.json`
  if (!existsSync(file)) writeFileSync(file, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 })
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))))
}
const keeper = key('keeper')
const faucet = key('faucet')

// Mainnet's runtime features, not the validator's own defaults: those switch on features
// no public cluster runs yet, and DAMM v2's position NFT fails under one of them
// ("Failed to reallocate account data"). What passes here should pass where it will run.
const args = ['--reset', '--quiet', '--ledger', here('../test-ledger'), '--rpc-port', '8899',
  '--url', 'https://api.mainnet-beta.solana.com', '--clone-feature-set']
for (const [id, file] of PROGRAMS) args.push('--bpf-program', id, file)
const validator = spawn('solana-test-validator', args, { stdio: 'inherit' })
const stop = () => { validator.kill('SIGINT'); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
validator.on('exit', (code) => { console.log(`validator exited (${code})`); process.exit(code ?? 0) })

const connection = new Connection(RPC, 'confirmed')
for (let i = 0; ; i++) {
  try { await connection.getLatestBlockhash(); break } catch {
    if (i > 60) throw new Error('the validator did not come up')
    await new Promise((r) => setTimeout(r, 1000))
  }
}

for (const who of [keeper, faucet]) {
  const sig = await connection.requestAirdrop(who.publicKey, 1_000 * LAMPORTS_PER_SOL)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
}

// The stand-in ownership coin. Its price is META's, near enough, so a $5,000 goal reads
// like the real thing: about 836 tMETA.
const coin = Keypair.generate()
await sendAndConfirmTransaction(connection, new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: faucet.publicKey, newAccountPubkey: coin.publicKey, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
  }),
  createInitializeMint2Instruction(coin.publicKey, 6, faucet.publicKey, null),
), [faucet, coin], { commitment: 'confirmed' })

const settings = {
  FAIR_CLUSTER: 'localnet',
  FAIR_RPC: RPC,
  FAIR_QUOTES: JSON.stringify([{ mint: coin.publicKey.toBase58(), symbol: 'tMETA', name: 'Test META', usdPrice: 5.98 }]),
  FAIR_TERMS: JSON.stringify({ durationSeconds: 180, claimDelaySeconds: 900 }),
  FAIR_GOVERNANCE: JSON.stringify({ proposalLengthMinutes: 5, warmupSeconds: 60, maxObservationChangeBps: 1_000, executionDelaySeconds: 60, executionWindowSeconds: 3_600 }),
  FAIR_KEEPER_KEY: JSON.stringify([...keeper.secretKey]),
  FAIR_FAUCET_KEY: JSON.stringify([...faucet.secretKey]),
}

// Written into the site's .dev.vars in place of any earlier FAIR_* lines; nothing else in
// the file is touched.
const devVars = here('../../.dev.vars')
const kept = existsSync(devVars) ? readFileSync(devVars, 'utf8').split('\n').filter((l) => !/^FAIR_[A-Z_]+=/.test(l)) : []
while (kept.length && kept[kept.length - 1] === '') kept.pop()
writeFileSync(devVars, [...kept, '', ...Object.entries(settings).map(([k, v]) => `${k}=${v}`), ''].join('\n'))

console.log(`
localnet ready at ${RPC}
  tMETA   ${coin.publicKey.toBase58()}
  keeper  ${keeper.publicKey.toBase58()}
  FAIR_* settings written to .dev.vars

At the repo root, in two more terminals:
  npm run dev                     the site, with /raise on this chain
  node scripts/fair-keeper.mjs    the keeper
`)
