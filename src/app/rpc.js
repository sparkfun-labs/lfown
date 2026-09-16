// LFOwn — how the browser talks to our RPC proxy.
//
// web3.js and the Meteora SDKs ask for one account at a time, and they ask a lot: a
// creator opening their profile with thirteen coins, then pressing Claim everything,
// sends several hundred requests to `/api/rpc` within a few seconds. Our own limiter
// allows that, but the zone's WAF rate-limiting rule does not — it answers HTML with
// status 429 (Cloudflare error 1015), the SDK fails to parse it, and the claim dies
// with "failed to get info about account …: Error: 429 <!doctype html>".
//
// Nothing about those requests needed to be separate. JSON-RPC takes an array, our
// proxy already accepts ten calls per request, and Helius answers them in one round
// trip. So this collects the calls made in the same tick, sends them together, and
// hands each caller its own answer back. The same wrapper is the one place that can
// hold identical questions to a single answer, keep a few requests in flight rather
// than a hundred, and retry the ones that are refused — which is what turns a wall
// into a pause.
//
// Used by every Connection in the app: trade.js and launchpad.js both build theirs
// with `fetch: rpcFetch`.

const ENDPOINT = `${location.origin}/api/rpc`

/** What the Worker accepts in one request — see RPC_MAX_BATCH in worker.mjs. */
const MAX_BATCH = 10
/** And how large the whole body may be, with room left for the envelope. */
const MAX_BODY = 48 * 1024
/** Calls wait this long for company. One frame is enough: the SDKs ask in bursts. */
const FLUSH_MS = 8
/** Requests allowed in the air at once. Beyond this the queue simply waits. */
const MAX_INFLIGHT = 3
const RETRIES = 4

/**
 * The pace the whole app keeps to, whatever it is doing.
 *
 * Two ceilings sit above this browser and the tighter one decides: the zone's WAF rule
 * allows 50 requests per 10 seconds per IP across all of `/api/` and blocks for 10
 * seconds when it is passed, and the Worker's own limiter allows 200 a minute. Batching
 * alone does not keep under either — three requests in flight, each answered in a
 * fraction of a second, is a rate of dozens per second. So requests are counted and
 * paced, leaving room for the page's ordinary calls to `/api/launches`, `/api/fees` and
 * the rest, which the WAF counts too.
 *
 * Passing it is worse than waiting for it: a block costs ten seconds of everything.
 */
export const pacing = { requests: 25, per: 10_000 }
const sentAt = []

/**
 * Sent alone, immediately. A transaction is what someone is waiting on with a wallet
 * open, and it is far too large to share a body with anything else.
 */
const NEVER_BATCH = new Set(['sendTransaction', 'simulateTransaction'])

/**
 * Asked over and over by different parts of one screen, and unchanged between two
 * calls in the same breath: a pool's config, a mint, a fee vault. Identical questions
 * in flight at the same moment share one answer.
 */
const DEDUPE = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getTokenAccountBalance',
  'getTokenAccountsByOwner', 'getMinimumBalanceForRentExemption', 'getTokenSupply',
  'getBalance', 'getVersion', 'getGenesisHash',
])

const queue = []
const inFlight = new Map()
let flushing = null
let live = 0
let nextId = 1

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/**
 * One POST, retried while the answer is "not now".
 *
 * A 429 from the zone's rule is HTML, not JSON, so the body is only read once the
 * status says it is worth reading. `Retry-After` is obeyed when it is given, because
 * guessing shorter only gets the next one refused too.
 */
async function post(payload, { signal } = {}) {
  let wait = 400
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (e) {
      if (attempt >= RETRIES || signal?.aborted) throw e
      await sleep(wait + Math.random() * 200)
      wait *= 2
      continue
    }
    if (res.ok) return res.json()

    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= RETRIES) {
      const detail = res.status === 429
        ? 'the RPC is rate limiting this browser — wait a minute and try again'
        : `the RPC answered ${res.status}`
      throw new Error(detail)
    }
    const after = Number(res.headers.get('retry-after'))
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : wait + Math.random() * 200)
    wait *= 2
  }
}

/** Answers, by the id we gave each call. */
function answerAll(entries, results) {
  const byId = new Map((Array.isArray(results) ? results : [results]).map((r) => [r?.id, r]))
  for (const entry of entries) {
    const found = byId.get(entry.sent.id)
    entry.resolve(json(found ? { ...found, id: entry.call.id } : {
      jsonrpc: '2.0',
      id: entry.call.id,
      error: { code: -32603, message: 'the RPC returned no answer for this call' },
    }))
  }
}

/** Takes as much of the queue as fits in one request. */
function takeBatch() {
  const batch = []
  let size = 2
  while (queue.length && batch.length < MAX_BATCH) {
    const entry = queue[0]
    const alone = NEVER_BATCH.has(entry.call.method)
    // A transaction shares a request with nothing, whether it arrived first or last:
    // with company already gathered it waits for the next request rather than joining.
    if (batch.length && (alone || size + entry.size + 1 > MAX_BODY)) break
    batch.push(queue.shift())
    size += entry.size + 1
    if (alone) break
  }
  return batch
}

/** Holds a request back until sending it keeps the app inside `pacing`. */
async function pace() {
  for (;;) {
    const now = Date.now()
    while (sentAt.length && now - sentAt[0] >= pacing.per) sentAt.shift()
    if (sentAt.length < pacing.requests) {
      sentAt.push(now)
      return
    }
    await sleep(pacing.per - (now - sentAt[0]) + 5)
  }
}

async function run(batch) {
  live++
  try {
    await pace()
    const payload = batch.length === 1 ? batch[0].sent : batch.map((e) => e.sent)
    const results = await post(payload, { signal: batch[0].signal })
    answerAll(batch, results)
  } catch (e) {
    for (const entry of batch) entry.reject(e)
  } finally {
    live--
    schedule()
  }
}

function schedule() {
  if (flushing || !queue.length) return
  flushing = setTimeout(() => {
    flushing = null
    while (queue.length && live < MAX_INFLIGHT) run(takeBatch())
    if (queue.length) schedule()
  }, FLUSH_MS)
}

/**
 * A `fetch` for web3.js's Connection: same signature, same kind of answer, but the
 * calls travel together. Anything that is not a single JSON-RPC call to our proxy —
 * an array the caller built itself, a body we cannot read — goes straight out.
 */
export function rpcFetch(url, init) {
  if (init?.method !== 'POST' || typeof init?.body !== 'string') return fetch(url, init)
  let call
  try {
    call = JSON.parse(init.body)
  } catch {
    return fetch(url, init)
  }
  if (Array.isArray(call) || !call?.method) return fetch(url, init)

  const key = DEDUPE.has(call.method) ? `${call.method}:${JSON.stringify(call.params ?? null)}` : null
  if (key && inFlight.has(key)) {
    // The same question, already asked. Both callers get the same answer, and a
    // Response body can only be read once, so each gets its own copy.
    return inFlight.get(key).then((res) => res.clone())
  }

  const promise = new Promise((resolve, reject) => {
    queue.push({
      call,
      sent: { ...call, id: nextId++ },
      size: init.body.length,
      signal: init.signal,
      resolve,
      reject,
    })
    schedule()
  })
  if (key) {
    inFlight.set(key, promise)
    const forget = () => inFlight.delete(key)
    promise.then(forget, forget)
    return promise.then((res) => res.clone())
  }
  return promise
}
