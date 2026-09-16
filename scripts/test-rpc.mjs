// LFOwn — the browser's RPC transport, exercised offline.
//
//   node scripts/test-rpc.mjs
//
// What it has to prove is what the WAF's 1015 taught us: a screen that asks two
// hundred questions must not send two hundred requests, must not send the same one
// twice at once, and must survive being told to slow down.

import assert from 'node:assert/strict'

globalThis.location = { origin: 'https://example.test' }

let posts = []
let behaviour = () => null
globalThis.fetch = async (url, init) => {
  // Whatever reaches the network, including the bodies rpc.js passes through untouched.
  let body
  try { body = JSON.parse(init.body) } catch { posts.push({ url, calls: [], raw: init.body }); return new Response('{}', { status: 200 }) }
  const calls = Array.isArray(body) ? body : [body]
  posts.push({ url, calls })
  const forced = behaviour(posts.length, calls)
  if (forced) return forced
  const answer = calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: `${c.method}:${JSON.stringify(c.params ?? null)}` }))
  return new Response(JSON.stringify(Array.isArray(body) ? answer : answer[0]), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

const { rpcFetch, pacing } = await import(new URL('../src/app/rpc.js', import.meta.url).href)
const PACING = { ...pacing }

const ask = (method, params, init = {}) =>
  rpcFetch('https://example.test/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
    ...init,
  }).then((r) => r.json())

let passed = 0
async function test(name, fn) {
  posts = []
  behaviour = () => null
  Object.assign(pacing, PACING)
  try { await fn(); passed++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack?.split('\n').slice(0, 3).join('\n       ')}`); process.exitCode = 1 }
}

console.log('LFOwn browser RPC transport\n')

await test('twenty-five calls in one tick leave as three requests, ten at most each', async () => {
  const answers = await Promise.all(
    Array.from({ length: 25 }, (_, i) => ask('getAccountInfo', [`account-${i}`])),
  )
  assert.equal(posts.length, 3)
  for (const p of posts) assert.ok(p.calls.length <= 10, `a request carried ${p.calls.length} calls`)
  assert.equal(posts.reduce((n, p) => n + p.calls.length, 0), 25)
  // Each caller gets its own answer, under the id it asked with.
  for (const [i, a] of answers.entries()) assert.equal(a.result, `getAccountInfo:["account-${i}"]`)
})

await test('the same question asked twice at once is sent once', async () => {
  const [a, b, c] = await Promise.all([
    ask('getAccountInfo', ['same']),
    ask('getAccountInfo', ['same']),
    ask('getAccountInfo', ['other']),
  ])
  assert.equal(posts.reduce((n, p) => n + p.calls.length, 0), 2)
  assert.equal(a.result, b.result)
  assert.notEqual(a.result, c.result)
  // Both copies are readable: a Response body can only be consumed once.
  assert.equal(b.result, 'getAccountInfo:["same"]')
})

await test('a rate-limited request is retried, and the caller never sees the 429', async () => {
  behaviour = (n) => (n === 1
    ? new Response('<!doctype html> Access denied … error code: 1015', { status: 429, headers: { 'retry-after': '1' } })
    : null)
  const started = Date.now()
  const a = await ask('getBalance', ['wallet'])
  assert.equal(a.result, 'getBalance:["wallet"]')
  assert.equal(posts.length, 2, 'it should have been sent again')
  assert.ok(Date.now() - started >= 900, 'retry-after asked for a second')
})

await test('a refusal that never lets up is reported in words, not as HTML', async () => {
  behaviour = () => new Response('<!doctype html> … 1015', { status: 429 })
  await assert.rejects(ask('getSlot', []), /rate limiting/)
  assert.ok(posts.length > 1 && posts.length <= 6, `tried ${posts.length} times`)
})

await test('a transaction goes out on its own, never sharing a body', async () => {
  const all = Promise.all([
    ask('getAccountInfo', ['a']),
    ask('sendTransaction', ['AAAA…']),
    ask('getAccountInfo', ['b']),
  ])
  await all
  const send = posts.find((p) => p.calls.some((c) => c.method === 'sendTransaction'))
  assert.equal(send.calls.length, 1)
})

await test('a batch the caller built itself, or a body we cannot read, is passed straight through', async () => {
  const res = await rpcFetch('https://example.test/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }]),
  })
  assert.equal(res.status, 200)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].calls.length, 1)
  await rpcFetch('https://example.test/api/rpc', { method: 'POST', body: 'not json' })
  assert.equal(posts.length, 2)
})

await test('requests are paced so the zone rule never sees a burst it would block', async () => {
  // The real ceiling is 25 requests per 10 seconds; shrunk here so the test is quick.
  // Sixty calls are six batches, and only four may leave per window.
  Object.assign(pacing, { requests: 4, per: 300 })
  const started = Date.now()
  await Promise.all(Array.from({ length: 60 }, (_, i) => ask('getAccountInfo', [`a-${i}`])))
  assert.equal(posts.length, 6)
  assert.ok(Date.now() - started >= 300, 'the sixth request waited for the window to roll')
})

console.log(`\n${passed} passed`)
process.exit(process.exitCode ?? 0)
