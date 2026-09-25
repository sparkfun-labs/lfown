// LFOwn fair launch — the keeper, in a loop, for a local or devnet run.
//
//   node scripts/fair-keeper.mjs            one pass every 15 seconds, until Ctrl-C
//   node scripts/fair-keeper.mjs --once     one pass
//
// Reads the FAIR_* settings from .dev.vars (onchain's `npm run localnet` writes them) and
// runs the same pass the Worker's minute cron runs where those settings exist. See
// src/lib/fair-keeper.mjs for what a pass does.

import { readFileSync } from 'node:fs'
import { fairConfig } from '../src/fair-api.mjs'
import { runFairKeeper } from '../src/lib/fair-keeper.mjs'

const env = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
  .split('\n').map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]))
const config = fairConfig(env)
if (!config || !env.FAIR_KEEPER_KEY) throw new Error('No FAIR_RPC / FAIR_KEEPER_KEY in .dev.vars: run `npm run localnet` in onchain/ first.')

const memory = new Map()
const stamp = () => new Date().toISOString().slice(11, 19)
const pass = () => runFairKeeper({ config, keeperSecret: env.FAIR_KEEPER_KEY, memory, log: (m) => console.log(`${stamp()} ${m}`) })
  .catch((e) => console.error(`${stamp()} pass failed: ${e.message}`))

// The host only: the URL may carry an API key.
console.log(`${stamp()} keeper on ${config.cluster} (${new URL(config.rpc).host})`)
await pass()
if (!process.argv.includes('--once')) setInterval(pass, 15_000)
