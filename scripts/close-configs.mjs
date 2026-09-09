// Remove published configs so a tier can be reopened.
//
// A DBC config is immutable: to change the fee, the fee claimer or the graduation
// threshold you open a new one. This retires the KV pointers so `create-config.mjs`
// stops skipping those coins. The old configs stay on chain and coins already
// launched keep trading on them.
//
// Retired configs are kept under `retired:` so their coins stay listed on the site.
// Without that they would still trade but vanish from /coins, which is a silent
// disappearance rather than a decision. Pass --forget to drop them for good.
//
//   node scripts/close-configs.mjs                            # list what would go
//   LFOWN_ARM=yes node scripts/close-configs.mjs              # retire, keep listed
//   LFOWN_ARM=yes node scripts/close-configs.mjs --forget     # retire and unlist
//   ... [starter|standard|serious]                            # one tier only

import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const forget = args.includes('--forget')
const tier = args.find((a) => !a.startsWith('--'))
const ARMED = process.env.LFOWN_ARM === 'yes'

const wrangler = (...args) =>
  execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

const keys = JSON.parse(wrangler('kv', 'key', 'list', '--binding', 'REGISTRY', '--remote'))
  .map((k) => k.name)
  .filter((name) => name.startsWith('config:'))
  .filter((name) => !tier || name.endsWith(`:${tier}`))

if (!keys.length) { console.log('nothing published', tier ? `on ${tier}` : ''); process.exit(0) }

console.log(ARMED ? '*** ARMED ***' : 'dry run — set LFOWN_ARM=yes to delete')
console.log(forget ? 'their coins will be unlisted' : 'their coins stay listed (retired, not forgotten)')
for (const key of keys) console.log(' ', key)
console.log(`\n${keys.length} config pointer(s)`)

if (!ARMED) process.exit(0)

for (const key of keys) {
  if (!forget) {
    const value = wrangler('kv', 'key', 'get', '--binding', 'REGISTRY', key, '--remote')
    wrangler('kv', 'key', 'put', '--binding', 'REGISTRY', `retired:${key.slice('config:'.length)}`, value.trim(), '--remote')
  }
  wrangler('kv', 'key', 'delete', '--binding', 'REGISTRY', key, '--remote')
  console.log(forget ? 'forgot' : 'retired', key)
}
console.log('\nReopen them with: LFOWN_ARM=yes node scripts/create-config.mjs all starter')
