// LFOwn — the Worker's abuse limits, exercised offline.
//
// A fake RPC counts program scans, KV and R2 live in memory, Jupiter answers
// instantly. Nothing here touches the network or production data, so it runs
// anywhere:  node scripts/test-worker.mjs
//
// It covers what the security audit changed: the JSON-RPC batch and body caps, the
// exit-size cap, the launches and fee report locks, the metadata route no longer
// dropping the cache, and the misses remembered for chart, graduate and launch.
import http from 'node:http'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const WORKER = new URL('../src/worker.mjs', import.meta.url).href

// The cache keys carry a version, and bumping one is how a record's shape changes.
// These assertions used to spell the version out, so a bump turned a healthy worker
// into a failing test that pointed at the wrong thing. Read them from the source
// instead: the test then checks that a key is written, which is what it means.
const KEYS = Object.fromEntries(
  [...readFileSync(new URL(WORKER), 'utf8')
    .matchAll(/^const (LAUNCHES_KEY|FEES_KEY) = '([^']+)'/gm)]
    .map(([, name, key]) => [name, key]),
)
for (const name of ['LAUNCHES_KEY', 'FEES_KEY']) {
  if (!KEYS[name]) throw new Error(`could not read ${name} out of the worker`)
}

// ── a JSON-RPC server that counts what it is asked ─────────────────────────
const rpcCalls = {}
const rpc = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', async () => {
    const parsed = JSON.parse(body)
    const calls = Array.isArray(parsed) ? parsed : [parsed]
    const answers = []
    for (const c of calls) {
      rpcCalls[c.method] = (rpcCalls[c.method] ?? 0) + 1
      let result
      switch (c.method) {
        case 'getProgramAccounts': await new Promise((r) => setTimeout(r, 300)); result = []; break
        case 'getAccountInfo': result = { context: { slot: 1 }, value: null }; break
        case 'getMultipleAccounts': result = { context: { slot: 1 }, value: (c.params?.[0] ?? []).map(() => null) }; break
        case 'getSlot': result = 1; break
        case 'getVersion': result = { 'solana-core': '2.0.0', 'feature-set': 1 }; break
        default: answers.push({ jsonrpc: '2.0', id: c.id, error: { code: -32601, message: `unexpected ${c.method}` } }); continue
      }
      answers.push({ jsonrpc: '2.0', id: c.id, result })
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]))
  })
})
await new Promise((r) => rpc.listen(0, '127.0.0.1', r))
const RPC_URL = `http://127.0.0.1:${rpc.address().port}/?api-key=test`

// ── Jupiter, answered locally ──────────────────────────────────────────────
let jupCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const u = typeof input === 'string' ? input : input.url
  if (u.startsWith('https://lite-api.jup.ag/')) {
    jupCalls++
    return new Response(JSON.stringify({ outAmount: '990000', routePlan: [{ swapInfo: { label: 'Fake' } }] }), { headers: { 'content-type': 'application/json' } })
  }
  return realFetch(input, init)
}

// ── KV, R2 and the edge cache, in memory ───────────────────────────────────
const kv = new Map()
const REGISTRY = {
  async get(key, type) { const v = kv.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v },
  async put(key, value) { kv.set(key, String(value)) },
  async delete(key) { kv.delete(key) },
}
const r2 = new Map()
const IMAGES = {
  async put(key, body) { r2.set(key, typeof body === 'string' ? body : Buffer.from(body).toString()) },
  async get(key) { return r2.has(key) ? { text: async () => r2.get(key) } : null },
}
const edge = new Map()
globalThis.caches = { default: {
  async match(req) { return edge.get(req.url)?.clone() ?? undefined },
  async put(req, res) { edge.set(req.url, res) },
} }

const env = { HELIUS_RPC: RPC_URL, REGISTRY, IMAGES, PUBLIC_ORIGIN: 'https://example.test' }
// Two valid 32-byte base58 strings that are certainly not LFOwn coins.
const COIN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const CONFIG = 'So11111111111111111111111111111111111111112'
const UNKNOWN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const UNKNOWN2 = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
kv.set('catalogue:v3:t10', JSON.stringify({ updatedAt: new Date().toISOString(), count: 1, coins: [{ mint: COIN, symbol: 'TEST', name: 'Test', usdPrice: 2, treasury: 100, liquidity: 10, holders: 1, icon: null }] }))
kv.set(`config:${COIN}:starter`, JSON.stringify({ config: CONFIG, threshold: 2500, feeBps: 250, creatorSharePct: 50 }))

const { default: worker } = await import(WORKER)

const pending = []
const ctx = { waitUntil: (p) => pending.push(p.catch?.(() => {}) ?? p) }
const settle = async () => { await Promise.allSettled(pending.splice(0)) }
async function call(path, init = {}) {
  const res = await worker.fetch(new Request(`https://example.test${path}`, init), env, ctx)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  await settle()
  return { status: res.status, body, headers: res.headers }
}
const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.test', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

let passed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`) ; process.exitCode = 1 }
}
const scans = () => rpcCalls.getProgramAccounts ?? 0
// The SDK looks at two account types per search, so one lookup is more than one
// scan. Measured once, then every test speaks in lookups rather than scans.
let UNIT = 1

console.log('LFOwn worker hardening\n')

await test('rpc: a batch of 11 calls is refused before it reaches the RPC', async () => {
  const before = scans()
  const batch = Array.from({ length: 11 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'getSlot', params: [] }))
  const r = await post('/api/rpc', batch)
  assert.equal(r.status, 413)
  assert.equal(rpcCalls.getSlot ?? 0, 0)
  assert.equal(scans(), before)
})

await test('rpc: a body over 64 KB is refused', async () => {
  const r = await post('/api/rpc', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: ['x'.repeat(70_000)] }))
  assert.equal(r.status, 413)
})

await test('rpc: a method off the allowlist is refused', async () => {
  const r = await post('/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [] })
  assert.equal(r.status, 403)
  assert.equal(scans(), 0)
})

await test('rpc: an ordinary call still goes through', async () => {
  const r = await post('/api/rpc', { jsonrpc: '2.0', id: 7, method: 'getSlot', params: [] })
  assert.equal(r.status, 200)
  assert.equal(r.body.result, 1)
  assert.equal(rpcCalls.getSlot, 1)
})

await test('exit: the usd list is capped at three sizes, deduplicated and whole', async () => {
  const r = await call(`/api/exit/${COIN}?usd=5,5,5.4,1,2,3,4,999999999999,-3,abc`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.exits.map((e) => e.usd), [5, 1, 2])
  assert.equal(jupCalls, 3)
})

await test('exit: a second spelling of the same request is served from the edge', async () => {
  const r = await call(`/api/exit/${COIN}?usd=5,1,2,2,2,2`)
  assert.equal(r.status, 200)
  assert.equal(jupCalls, 3)
})

await test('launches: one cold request builds the list (measures the cost of one lookup)', async () => {
  assert.equal(kv.has(KEYS.LAUNCHES_KEY), false)
  const before = scans()
  const r = await call('/api/launches')
  assert.equal(r.status, 200)
  assert.equal(r.body.count, 0)
  UNIT = scans() - before
  assert.ok(UNIT >= 1, 'a cold list costs at least one scan')
  assert.equal(kv.has('rebuilding:launches'), false)
})

await test('launches: six concurrent cold requests cost one lookup, not six', async () => {
  kv.delete(KEYS.LAUNCHES_KEY)
  const before = scans()
  const all = await Promise.all(Array.from({ length: 6 }, () => call('/api/launches')))
  for (const r of all) { assert.equal(r.status, 200); assert.equal(r.body.count, 0); assert.equal(r.body.pending, undefined) }
  assert.equal(scans() - before, UNIT)
  assert.equal(kv.has(KEYS.LAUNCHES_KEY), true)
  assert.equal(kv.has('rebuilding:launches'), false)
})

await test('launches: an old list is served at once and rebuilt behind the response', async () => {
  const stored = JSON.parse(kv.get(KEYS.LAUNCHES_KEY))
  stored.updatedAt = new Date(Date.now() - 3_600_000).toISOString()
  kv.set(KEYS.LAUNCHES_KEY, JSON.stringify(stored))
  const before = scans()
  const r = await call('/api/launches')
  assert.equal(r.status, 200)
  assert.equal(scans() - before, UNIT)
  assert.ok(Date.now() - Date.parse(JSON.parse(kv.get(KEYS.LAUNCHES_KEY)).updatedAt) < 5_000)
})

await test('metadata: a post no longer drops the launches list, and links are http(s) or nothing', async () => {
  const r = await post('/api/metadata', { name: 'X', symbol: 'X', image: 'javascript:alert(1)', website: 'https://ok.example/', twitter: '@x' })
  assert.equal(r.status, 200)
  assert.equal(kv.has(KEYS.LAUNCHES_KEY), true)
  const stored = JSON.parse([...r2.values()][0])
  assert.equal(stored.image, '')
  assert.equal(stored.external_url, 'https://ok.example/')
})

await test('chart: a mint with no pool costs one lookup, then none', async () => {
  const before = scans()
  const r1 = await call(`/api/chart/${UNKNOWN}`)
  assert.equal(r1.status, 404)
  assert.equal(r1.body.denied, true)
  assert.equal(scans() - before, UNIT)
  const r2 = await call(`/api/chart/${UNKNOWN}`)
  assert.equal(r2.status, 404)
  assert.equal(scans() - before, UNIT)
  edge.clear() // even without the edge, KV remembers the miss
  const r3 = await call(`/api/chart/${UNKNOWN}`)
  assert.equal(r3.body.denied, true)
  assert.equal(scans() - before, UNIT)
})

await test('graduate: a mint with no pool costs one lookup, then none', async () => {
  const before = scans()
  const r1 = await post('/api/graduate', { mint: UNKNOWN2 })
  assert.equal(r1.body.reason, 'no pool for that mint')
  assert.equal(scans() - before, UNIT)
  const r2 = await post('/api/graduate', { mint: UNKNOWN2 })
  assert.equal(r2.body.reason, 'no pool for that mint')
  assert.equal(scans() - before, UNIT)
})

await test('launch/:mint: a miss is kept at the edge', async () => {
  const before = scans()
  const r1 = await call(`/api/launch/${UNKNOWN}`)
  assert.equal(r1.status, 404)
  assert.match(r1.headers.get('cache-control'), /max-age=300/)
  assert.equal(scans() - before, UNIT)
  const r2 = await call(`/api/launch/${UNKNOWN}`)
  assert.equal(r2.status, 404)
  assert.equal(scans() - before, UNIT)
})

await test('fees: four concurrent cold requests all answer, one build is stored', async () => {
  assert.equal(kv.has(KEYS.FEES_KEY), false)
  kv.delete(KEYS.LAUNCHES_KEY) // so the report has to rebuild the list too, once
  const before = scans()
  const all = await Promise.all(Array.from({ length: 4 }, () => call('/api/fees')))
  for (const r of all) { assert.equal(r.status, 200); assert.deepEqual(r.body.coins, []) }
  assert.equal(scans() - before, UNIT)
  assert.equal(kv.has(KEYS.FEES_KEY), true)
  assert.equal(kv.has('rebuilding:fees'), false)
})

await test('rate limiter: a binding that says no turns into a 429', async () => {
  const denied = { limit: async () => ({ success: false }) }
  const r = await worker.fetch(new Request(`https://example.test/api/chart/${UNKNOWN}`, { headers: { 'cf-connecting-ip': '1.2.3.4' } }), { ...env, HEAVY_LIMITER: denied }, ctx)
  assert.equal(r.status, 429)
  assert.equal(r.headers.get('retry-after'), '60')
  const r2 = await worker.fetch(new Request(`https://example.test/api/quote-assets`), { ...env, HEAVY_LIMITER: denied }, ctx)
  assert.equal(r2.status, 200) // the cheap routes are not behind it
})

console.log(`\n${passed} passed`)
console.log('rpc calls seen:', JSON.stringify(rpcCalls))
rpc.close()
process.exit(process.exitCode ?? 0)
