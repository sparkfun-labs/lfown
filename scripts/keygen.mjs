// LFOwn — making a keypair without it ever leaving this machine.
//
//   npm run keygen                 → .keys/lfown-deployer.json
//   node scripts/keygen.mjs NAME   → .keys/NAME.json
//
// The secret is written to the file and nowhere else. It is never printed, never
// logged and never returned: everything this prints is public. `.keys/` is
// gitignored and each file is created 0600, readable only by the user who made it.
//
// It refuses to overwrite. A key that already exists is one something already
// depends on — a config's immutable fee claimer, a vault's shareholder — and
// replacing the file would not replace it on chain, it would only lose it.

import { Keypair } from '@solana/web3.js'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const name = (process.argv[2] ?? 'lfown-deployer').replace(/[^a-zA-Z0-9_-]/g, '')
if (!name) {
  console.error('usage: node scripts/keygen.mjs [name]')
  process.exit(1)
}

const path = `.keys/${name}.json`
if (existsSync(path)) {
  console.error(`${path} already exists — delete it yourself if you really mean to replace it`)
  process.exit(1)
}

mkdirSync('.keys', { recursive: true })
const keypair = Keypair.generate()
writeFileSync(path, JSON.stringify([...keypair.secretKey]), { mode: 0o600 })

console.log(`wrote ${path} (mode 600, gitignored)`)
console.log(keypair.publicKey.toBase58())
