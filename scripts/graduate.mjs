// Crank the graduation of any curve that has filled.
//
//   node scripts/graduate.mjs                  # list what is ready
//   LFOWN_ARM=yes node scripts/graduate.mjs    # migrate them

import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { buildRegistry } from '../src/lib/registry.mjs'
import { listLaunches } from '../src/lib/launches.mjs'
import { readyToGraduate, graduate } from '../src/lib/graduate.mjs'
import { TIERS } from '../src/lib/config.mjs'

const ARMED = process.env.LFOWN_ARM === 'yes'
const RPC = readFileSync('.dev.vars', 'utf8').match(/https:\/\/[^\s"]+/)[0]
const KEYPAIR_PATH = process.env.LFOWN_KEYPAIR
  ?? (existsSync('.keys/lfown-deployer.json') ? '.keys/lfown-deployer.json' : `${homedir()}/.config/solana/id.json`)
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))))

const connection = new Connection(RPC, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')

const wrangler = (...a) => execFileSync('npx', ['wrangler', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const keys = JSON.parse(wrangler('kv', 'key', 'list', '--binding', 'REGISTRY', '--remote')).map((k) => k.name)

const { coins } = await buildRegistry()
const configs = []
for (const key of keys) {
  if (!key.startsWith('config:') && !key.startsWith('retired:')) continue
  const [, mint, tier] = key.split(':')
  const coin = coins.find((c) => c.mint === mint)
  if (!coin || !TIERS.some((t) => t.id === tier)) continue
  const { config } = JSON.parse(wrangler('kv', 'key', 'get', '--binding', 'REGISTRY', key, '--remote'))
  configs.push({ config, mint, symbol: coin.symbol, usdPrice: coin.usdPrice, tier })
}

const launches = await listLaunches(client, connection, PublicKey, configs)
const ready = await readyToGraduate(client, launches)

console.log(ARMED ? '*** ARMED ***' : 'dry run — set LFOWN_ARM=yes to migrate')
console.log('payer   :', payer.publicKey.toBase58())
console.log('launches:', launches.length, '| ready to graduate:', ready.length, '\n')

for (const p of ready) {
  console.log(`  ${p.symbol ?? p.baseMint} — curve full at ${Number(p.poolState.quoteReserve.toString()) / 1e6} ${p.quoteSymbol}`)
  if (!ARMED) continue
  try {
    console.log('    migrated:', await graduate(client, connection, p.pool, payer))
  } catch (e) {
    console.error('    failed:', e.message.split('\n')[0])
  }
}

if (!ready.length) console.log('  nothing to do — no curve has filled yet.')
