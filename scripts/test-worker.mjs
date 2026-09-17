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
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [...kv.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name }))
    return { keys, list_complete: true }
  },
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
kv.set('catalogue:v5:t10', JSON.stringify({ updatedAt: new Date().toISOString(), count: 1, coins: [{ mint: COIN, symbol: 'TEST', name: 'Test', usdPrice: 2, treasury: 100, liquidity: 10, holders: 1, icon: null }] }))
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

// ── agents ─────────────────────────────────────────────────────────────────
console.log('\nLFOwn agent launches\n')

const pool = await import(new URL('../src/lib/mint-pool.mjs', import.meta.url).href)
const { Keypair } = await import('@solana/web3.js')

await test('mint pool: a ground address ends in own and its seed rebuilds the same key', async () => {
  const [hit] = await pool.grind({ budgetMs: 30_000, max: 1 })
  assert.ok(hit, 'found nothing in 30 s')
  assert.match(hit.address, /own$/)
  assert.equal(hit.seed.length, 32)
  assert.equal(Keypair.fromSeed(hit.seed).publicKey.toBase58(), hit.address)
})

await test('mint pool: refill tops up to the target, take hands one out and removes it', async () => {
  const store = new Map()
  const fakeKv = {
    async get(k) { return store.get(k) ?? null },
    async put(k, v) { store.set(k, v) },
    async delete(k) { store.delete(k) },
    async list({ prefix = '', limit = 1000 } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name })), list_complete: true }
    },
  }
  assert.equal(await pool.take(fakeKv), null)
  const first = await pool.refill(fakeKv, { target: 2, budgetMs: 60_000 })
  assert.deepEqual(first, { had: 0, added: 2 })
  assert.deepEqual(await pool.refill(fakeKv, { target: 2 }), { had: 2, added: 0 })
  const got = await pool.take(fakeKv)
  assert.match(got.address, /own$/)
  assert.equal(Keypair.fromSeed(got.seed).publicKey.toBase58(), got.address)
  assert.equal(await pool.poolSize(fakeKv), 1)
})

await test('agent: options list the open coin, its tier priced in usd, and the fee split', async () => {
  const r = await call('/api/agent/options')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  assert.equal(r.body.coins.length, 1)
  assert.equal(r.body.coins[0].symbol, 'TEST')
  assert.deepEqual(r.body.coins[0].tiers.map((t) => [t.id, t.thresholdUsd]), [['starter', 5000]])
  assert.equal(r.body.holders.default, 37.5)
})

await test('agent: a launch with no creator is kept as a draft and answered with a link', async () => {
  const r = await post('/api/agent/launch', { name: 'Agent Coin', symbol: '$AGNT', quote: 'test', description: 'made by a bot', website: 'javascript:x', holderPct: 99 })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.mode, 'link')
  assert.match(r.body.launchUrl, /^https:\/\/example\.test\/launch\?draft=[0-9a-f-]{36}$/)
  assert.deepEqual([r.body.feeShares.creator, r.body.feeShares.holders, r.body.feeShares.lfownDao], [0, 50, 50])
  assert.deepEqual(r.body.feeShares.perTradeBps, { fee: 250, meteora: 50, creator: 0, holders: 100, lfownDao: 100 })
  const meta = JSON.parse(r2.get(r.body.token.uri.split('/i/')[1]))
  assert.equal(meta.symbol, 'AGNT')
  assert.equal(meta.external_url, '')
  const d = await call(`/api/agent/draft/${r.body.id}`)
  assert.equal(d.status, 200)
  assert.equal(d.body.quoteMint, COIN)
  assert.equal(d.body.tier, 'starter')
  assert.equal(d.body.holderPct, 50)

  // A retry with the id reuses the draft: same id, not one new file in the bucket.
  const files = r2.size
  const again = await post('/api/agent/launch', { id: r.body.id })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal(again.body.id, r.body.id)
  assert.equal(again.body.token.uri, r.body.token.uri)
  assert.equal(r2.size, files)
})

await test('agent: validate stores nothing and turns bad input into problems', async () => {
  const files = r2.size
  const drafts = [...kv.keys()].filter((k) => k.startsWith('agentdraft:')).length
  const good = await post('/api/agent/validate', { name: 'Fine', symbol: 'FINE', quote: 'TEST', holderPct: 10 })
  assert.equal(good.status, 200)
  assert.equal(good.body.ok, true)
  assert.deepEqual(good.body.problems, [])
  assert.equal(good.body.feeShares.holders, 10)
  const bad = await post('/api/agent/validate', { name: 'Fine', symbol: 'WAYTOOLONGSYM', quote: 'TEST' })
  assert.equal(bad.status, 200)
  assert.equal(bad.body.ok, false)
  assert.match(bad.body.problems[0], /symbol/)
  assert.equal(r2.size, files)
  assert.equal([...kv.keys()].filter((k) => k.startsWith('agentdraft:')).length, drafts)
})

await test('agent: bad requests say what is wrong', async () => {
  const noQuote = await post('/api/agent/launch', { name: 'A', symbol: 'A', quote: 'NOPE' })
  assert.equal(noQuote.status, 400)
  assert.deepEqual(noQuote.body.details.available, ['TEST'])
  assert.equal((await post('/api/agent/launch', { name: 'A', symbol: 'TOOLONGSYMBOL', quote: 'TEST' })).status, 400)
  assert.equal((await post('/api/agent/launch', { name: 'A', symbol: 'A', quote: 'TEST', creator: 'not-a-wallet' })).status, 400)
  assert.equal((await post('/api/agent/launch', { name: 'A', symbol: 'A', quote: 'TEST', tier: 'serious' })).status, 400)
  const gone = await post('/api/agent/submit', { id: 'nope', transactions: [{ base64: 'AA==' }] })
  assert.equal(gone.status, 410)
  assert.match(gone.body.error, /prepare_launch again/)
  assert.equal((await call('/api/agent/draft/nope')).status, 404)
  const pre = await call('/api/agent/launch', { method: 'OPTIONS' })
  assert.equal(pre.status, 204)
})

await test('agent: the index and OpenAPI describe the same three endpoints', async () => {
  const index = await call('/api/agent')
  assert.equal(index.body.mcp, 'https://example.test/mcp')
  const spec = await call('/api/agent/openapi.json')
  assert.deepEqual(Object.keys(spec.body.paths), ['/api/agent/options', '/api/agent/validate', '/api/agent/launch', '/api/agent/submit'])
})

const MODERN = '2026-07-28'
const mcp = (body, headers = {}) => post('/mcp', body, headers)
const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN }

await test('mcp: a legacy client initialises, lists tools and gets 202 for a notification', async () => {
  const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  assert.equal(init.status, 200)
  assert.equal(init.body.result.protocolVersion, '2025-06-18')
  assert.ok(init.body.result.capabilities.tools)
  assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' })
  assert.deepEqual(list.body.result.tools.map((t) => t.name), ['list_launch_options', 'validate_launch', 'prepare_launch', 'submit_launch'])
  for (const tool of list.body.result.tools) assert.equal(tool.outputSchema?.type, 'object', `${tool.name} declares its output`)
  assert.equal(list.body.result.resultType, undefined)
})

await test('mcp: a modern client discovers the server and calls a tool with no handshake', async () => {
  const h = { 'mcp-protocol-version': MODERN }
  const disc = await mcp({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: meta } }, { ...h, 'mcp-method': 'server/discover' })
  assert.equal(disc.status, 200)
  assert.deepEqual(disc.body.result.supportedVersions, [MODERN])
  assert.equal(disc.body.result.resultType, 'complete')
  const tool = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { _meta: meta, name: 'prepare_launch', arguments: { name: 'Mcp', symbol: 'MCP', quote: 'TEST' } } }, { ...h, 'mcp-method': 'tools/call', 'mcp-name': 'prepare_launch' })
  assert.equal(tool.status, 200)
  assert.equal(tool.body.result.structuredContent.mode, 'link')
  for (const key of ['id', 'mode', 'launchUrl', 'feeShares', 'next']) assert.ok(key in tool.body.result.structuredContent, `prepare_launch output has ${key}`)
  const refused = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { _meta: meta, name: 'prepare_launch', arguments: { name: 'x', symbol: 'x', quote: 'NOPE' } } }, h)
  assert.equal(refused.body.result.isError, true)
})

await test('mcp: mismatches, unknown versions and methods, other verbs and foreign origins are refused', async () => {
  const mismatch = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, { 'mcp-protocol-version': '2025-06-18' })
  assert.equal(mismatch.status, 400)
  assert.equal(mismatch.body.error.code, -32020)
  const method = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, { 'mcp-method': 'tools/call' })
  assert.equal(method.body.error.code, -32020)
  const version = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } } })
  assert.equal(version.status, 400)
  assert.equal(version.body.error.code, -32022)
  assert.ok(version.body.error.data.supported.includes(MODERN))
  const unknown = await mcp({ jsonrpc: '2.0', id: 1, method: 'prompts/list', params: { _meta: meta } })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, -32601)
  assert.equal((await call('/mcp')).status, 405)
  assert.equal((await call('/mcp', { headers: { accept: 'text/event-stream' } })).status, 405)
  const page = await call('/mcp', { headers: { accept: 'text/html,application/xhtml+xml' } })
  assert.equal(page.status, 200)
  assert.match(page.body, /https:\/\/example\.test\/mcp/)
  assert.equal((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://evil.example' })).status, 403)
})

await test('catalogue: 01Resolved figures join by mint, never by symbol, and replace the treasury only when real', async () => {
  const { withFinancials } = await import(new URL('../src/lib/registry.mjs', import.meta.url).href)
  const coins = [
    { mint: 'MINT_A', symbol: 'AAA', treasury: 100 },
    { mint: 'MINT_B', symbol: 'BBB', treasury: 200 },
    { mint: 'MINT_C', symbol: 'CCC', treasury: 300 },
  ]
  const launches = [
    { baseMint: 'MINT_A', organizationSlug: 'alpha' },
    { baseMint: 'MINT_C', organizationSlug: 'gamma' },
    { baseMint: 'OTHER', organizationSlug: 'bbb-impostor' },
  ]
  const projects = [
    { organizationSlug: 'alpha', tokenSymbol: 'AAA', treasuryValue: 1500.5, netAssetValue: '0.25', monthsOfRunway: 12, marketCap: '9000' },
    { organizationSlug: 'bbb-impostor', tokenSymbol: 'BBB', treasuryValue: 999999 },
    { organizationSlug: 'gamma', tokenSymbol: 'CCC', treasuryValue: 0, netAssetValue: 'n/a' },
  ]
  const [a, b, c] = withFinancials(coins, projects, launches)
  assert.equal(a.treasury, 1500.5)
  assert.equal(a.treasuryMetadao, 100)
  assert.equal(a.financials.navPerToken, 0.25)
  assert.equal(a.financials.url, 'https://www.01resolved.com/alpha/financials')
  assert.equal(b.treasury, 200, 'a matching symbol under another mint is not the same coin')
  assert.equal(b.financials, null)
  assert.equal(c.treasury, 300, 'a zero treasury from 01Resolved does not replace a real one')
  assert.equal(c.financials.navPerToken, null)
})

await test('dinosaurs: TRCH1 is 9 decimals everywhere, priced by its raise until it trades, and says what backs it', async () => {
  const config = await import(new URL('../src/lib/config.mjs', import.meta.url).href)
  const { extraCoin } = await import(new URL('../src/lib/registry.mjs', import.meta.url).href)
  const { PublicKey } = await import('@solana/web3.js')
  const TRCH1 = 'DeatoN4UYU2B658Lh4ZV1VXy1u2ros32UEwnAtCRv4nB'
  assert.equal(config.tokenDecimals(TRCH1), 9)
  assert.equal(config.tokenDecimals(new PublicKey(TRCH1)), 9, 'a PublicKey reads the same as its string')
  assert.equal(config.tokenUnit(TRCH1), 1e9)
  assert.equal(config.tokenUnit('METAwkXcqyXKy1AtsSgJ8JiUHwGCafnZL38n3vYmeta'), 1e6, 'ownership coins and memecoins stay 6')
  assert.equal(config.tokenUnit(undefined), 1e6)

  const q = config.EXTRA_QUOTES.find((e) => e.mint === TRCH1)
  const unlisted = extraCoin(q, { holders: 27, usdPrice: 0 })
  assert.equal(unlisted.usdPrice, q.referencePrice)
  assert.equal(unlisted.priceSource, 'reference')
  assert.equal(unlisted.decimals, 9)
  assert.equal(unlisted.holders, 27)
  assert.equal(unlisted.backing.kind, 'dinosaur')
  assert.equal(unlisted.treasury, q.backing.usd, 'what backs it sorts like a treasury')
  const trading = extraCoin(q, { usdPrice: 0.81, liquidity: 12_000 })
  assert.equal(trading.usdPrice, 0.81)
  assert.equal(trading.priceSource, 'market')

  // A graduated position's fees, in whole tokens on each side.
  const tele = await import(new URL('../src/lib/telegram.mjs', import.meta.url).href)
  assert.match(tele.graduatedMessage({ symbol: 'RAWR', quoteSymbol: 'TRCH1', quoteMint: TRCH1, quoteReserve: '7197000000000', baseMint: 'X' }, 'https://x.test'), /raised 7,197 TRCH1/)
})

await test('fee split: holders take three quarters of the creator half, as whole vault shares', async () => {
  const { clampHolderPct, vaultShares, splitFor } = await import(new URL('../src/lib/fee-split.mjs', import.meta.url).href)
  const { DEFAULT_HOLDER_PCT } = await import(new URL('../src/agent.mjs', import.meta.url).href)
  assert.equal(DEFAULT_HOLDER_PCT, 37.5)
  assert.equal(clampHolderPct(37.5), 37.5)
  assert.equal(clampHolderPct(37.3), 37.5)
  assert.equal(clampHolderPct(99), 50)
  const who = { creator: 'So11111111111111111111111111111111111111112', holders: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }
  assert.deepEqual(vaultShares(37.5, who).map((s) => s.share), [25, 75])
  assert.ok(vaultShares(37.5, who).every((s) => Number.isInteger(s.share)))
  assert.deepEqual(vaultShares(50, who).map((s) => s.share), [100])
  assert.deepEqual(splitFor(37.5), { holderPct: 37.5, creator: 12.5, holders: 37.5, partner: 50 })
})

await test('sponsor: signs a real launch, and nothing that spends its SOL any other way', async () => {
  const web3 = await import('@solana/web3.js')
  const { Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } = web3
  const { DynamicBondingCurveClient, deriveDbcPoolAddress, deriveDbcTokenVaultAddress, deriveMintMetadata, deriveDbcPoolAuthority, deriveDbcEventAuthority } = await import('@meteora-ag/dynamic-bonding-curve-sdk')
  const { DynamicFeeSharingClient, deriveFeeVaultPdaAddress } = await import('@meteora-ag/dynamic-fee-sharing-sdk')
  const { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } = await import('@solana/spl-token')
  const { checkSponsored } = await import(new URL('../src/lib/sponsor.mjs', import.meta.url).href)
  const { vaultShares } = await import(new URL('../src/lib/fee-split.mjs', import.meta.url).href)

  const offline = new web3.Connection('http://127.0.0.1:1')
  const dbcClient = new DynamicBondingCurveClient(offline, 'confirmed')
  const programs = { dbc: dbcClient.pool.program, dfs: new DynamicFeeSharingClient(offline, 'confirmed').program }
  const sponsor = Keypair.generate(), creator = Keypair.generate(), mint = Keypair.generate(), stranger = Keypair.generate()
  const quote = Keypair.generate().publicKey, config = Keypair.generate().publicKey, pot = Keypair.generate().publicKey
  const configs = [{ config: config.toBase58(), mint: quote.toBase58() }]
  const blockhash = PublicKey.default.toBase58()

  const poolIx = (payer = sponsor.publicKey, cfg = config) => {
    const pool = deriveDbcPoolAddress(quote, mint.publicKey, cfg)
    return programs.dbc.methods.initializeVirtualPoolWithSplToken({ name: 'Free', symbol: 'FREE', uri: 'https://x.test/a.json' }).accountsStrict({
      config: cfg, poolAuthority: deriveDbcPoolAuthority(), creator: creator.publicKey, baseMint: mint.publicKey, quoteMint: quote,
      pool, baseVault: deriveDbcTokenVaultAddress(pool, mint.publicKey), quoteVault: deriveDbcTokenVaultAddress(pool, quote),
      mintMetadata: deriveMintMetadata(mint.publicKey), metadataProgram: new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
      payer, tokenQuoteProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      eventAuthority: deriveDbcEventAuthority(), program: programs.dbc.programId,
    }).instruction()
  }
  const vault = deriveFeeVaultPdaAddress(mint.publicKey, quote)
  const vaultIx = (owner = creator.publicKey) => programs.dfs.methods.initializeFeeVaultPda({ padding: [], users: vaultShares(37.5, { creator: creator.publicKey, holders: pot }) }).accountsPartial({
    feeVault: vault, base: mint.publicKey, tokenMint: quote, owner, payer: sponsor.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction()
  const handoverIx = () => programs.dbc.methods.transferPoolCreator().accountsStrict({
    virtualPool: deriveDbcPoolAddress(quote, mint.publicKey, config), config, creator: creator.publicKey, newCreator: vault,
    eventAuthority: deriveDbcEventAuthority(), program: programs.dbc.programId,
  }).instruction()

  const build = async ({ vaultExtra = [], launchExtra = [], launchFirst = [], feePayer = sponsor.publicKey, pool, owner, creatorSigns = true } = {}) => {
    const v = new Transaction().add(await vaultIx(owner), ...vaultExtra)
    const l = new Transaction().add(...launchFirst, pool ?? await poolIx(), await handoverIx(), ...launchExtra)
    for (const t of [v, l]) { t.feePayer = feePayer; t.recentBlockhash = blockhash }
    v.partialSign(mint)
    l.partialSign(...(creatorSigns ? [creator, mint] : [mint]))
    return [v, l]
  }
  const ok = (txs) => checkSponsored(txs, { sponsor: sponsor.publicKey, programs, configs })
  const refused = async (txs, pattern) => assert.throws(() => ok(txs), pattern)

  const good = ok(await build())
  assert.equal(good.creator, creator.publicKey.toBase58())
  assert.equal(good.baseMint, mint.publicKey.toBase58())
  assert.equal(good.vault, vault.toBase58())

  await refused(await build({ launchExtra: [SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: stranger.publicKey, lamports: 1e9 })] }), /program a launch does not use/)
  await refused(await build({ launchExtra: [createAssociatedTokenAccountIdempotentInstruction(sponsor.publicKey, Keypair.generate().publicKey, stranger.publicKey, quote)] }), /spend the sponsor/)
  await refused(await build({ launchFirst: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 })] }), /compute budget/)
  assert.ok(ok(await build({ launchFirst: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })] })), 'a normal priority fee is fine')
  await refused(await build({ pool: await poolIx(sponsor.publicKey, Keypair.generate().publicKey) }), /(not on a config LFOwn opened|hand the pool)/)
  await refused(await build({ creatorSigns: false }), /creator has not signed/)
  await refused(await build({ owner: stranger.publicKey }), /someone other than the creator/)
  await refused(await build({ feePayer: creator.publicKey }), /fee payer/)
  // The sponsor as the pool's creator instead of its payer would make LFOwn the owner of a stranger's coin.
  const selfCreated = await build()
  selfCreated[1].instructions[0].keys[2] = { pubkey: sponsor.publicKey, isSigner: true, isWritable: false }
  await refused(selfCreated, /more than the payer/)
})

await test('pumps: only big moves on liquid coins qualify, biggest first, and a missing figure never does', async () => {
  const { pumpCandidates, launchUrl } = await import(new URL('../src/lib/pumps.mjs', import.meta.url).href)
  const coin = (symbol, change, liquidity = 50_000) => ({ symbol, mint: `M_${symbol}`, liquidity, financials: change === undefined ? null : { priceChange24h: change } })
  const picked = pumpCandidates([
    coin('AVICI', 31.2), coin('META', 19.9), coin('CARS', 64), coin('THIN', 90, 900),
    coin('NONE'), coin('NAN', 'n/a'), coin('DOWN', -40),
  ])
  assert.deepEqual(picked.map((p) => p.coin.symbol), ['CARS', 'AVICI'])
  assert.equal(launchUrl({ symbol: 'AVICI' }, 'https://x.test'), 'https://x.test/launch?quote=AVICI')
})

await test('pumps: the X post fits, keeps its headline, and the Telegram one is escaped', async () => {
  const xlib = await import(new URL('../src/lib/x.mjs', import.meta.url).href)
  const tg = await import(new URL('../src/lib/telegram.mjs', import.meta.url).href)
  const url = 'https://letsfuckingown.fun/launch?quote=AVICI'
  const post = xlib.pumpMessage({ symbol: 'AVICI' }, 31.4, url)
  assert.match(post, /^📈 \$AVICI \+31% today — launch a meme against AVICI/)
  assert.ok(post.endsWith(url))
  const counted = post.replace(url, 'x'.repeat(23)).length
  assert.ok(counted <= 280, `X would count ${counted}`)
  const long = xlib.pumpMessage({ symbol: 'A'.repeat(120) }, 250, url)
  assert.ok(long.replace(url, 'x'.repeat(23)).length <= 280, 'even an absurd symbol cannot push the post over the limit')
  const html = tg.pumpMessage({ symbol: '<b>X</b>' }, 20.4, url)
  assert.ok(!html.includes('<b>X</b>'), 'the symbol is escaped')
  assert.match(html, /\+20%<\/b> today/)
})

console.log(`\n${passed} passed`)
console.log('rpc calls seen:', JSON.stringify(rpcCalls))
rpc.close()
process.exit(process.exitCode ?? 0)
