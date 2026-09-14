// LFOwn — a reserve of mint addresses that end in `own`, for launches made by agents.
//
// The launch page grinds its own address in the browser, across the visitor's cores,
// so the key that signs the pool never crosses a network. An agent has no browser to
// do that in, and asking every agent to search 195,000 keys first would be asking
// most of them not to launch. So the server keeps a small reserve instead: the minute
// cron tops it up, and each launch made through the API takes one address out.
//
// The trade is written down rather than hidden. A mint key from the reserve exists on
// the server between the moment it is ground and the moment its pool opens. It still
// never leaves: the server signs with it and hands back a signed transaction. And it
// controls nothing worth taking — the config makes the mint authority immutable, so
// once the pool exists the key can never sign anything that matters again.
//
// Ground with the runtime's native Ed25519. Measured inside workerd: 36,489 keys a
// second, about 5.3 seconds per address on average, against roughly 30 seconds for
// the JavaScript implementation the browser uses. The private key is exported as a
// JWK, whose `d` is exactly the 32-byte seed `Keypair.fromSeed` takes — checked
// against the same address on thousands of keys, in Node and in workerd.

const PREFIX = 'mintpool:v1:'

/** How many addresses the reserve tries to hold. */
export const POOL_TARGET = 20

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const SUFFIX = 'own'
const MODULUS = 58 ** SUFFIX.length
const SUFFIX_VALUE = [...SUFFIX].reduce((t, c) => t * 58 + B58.indexOf(c), 0)

/**
 * Whether a 32-byte public key's base58 form ends in `own`, without building it.
 *
 * The last three base58 digits of a number are its remainder modulo 58³; leading zero
 * bytes only ever add `1`s at the front. So the whole check is one pass of modular
 * reduction — the same answer as encoding the address, on 200,000 keys out of 200,000.
 */
export function endsWithOwn(publicKey) {
  let r = 0
  for (let i = 0; i < 32; i++) r = (r * 256 + publicKey[i]) % MODULUS
  return r === SUFFIX_VALUE
}

function base58(bytes) {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out
}

const fromBase64Url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

/**
 * Searches for addresses until `budgetMs` has passed or `max` have been found.
 *
 * Keys are generated in batches so the runtime's native code does the work in
 * parallel rather than one promise at a time. Only a winning key's private half is
 * ever exported.
 */
export async function grind({ budgetMs, max = Infinity, now = () => Date.now() }) {
  const subtle = globalThis.crypto.subtle
  const found = []
  const deadline = now() + budgetMs
  while (found.length < max && now() < deadline) {
    const batch = await Promise.all(Array.from({ length: 128 }, async () => {
      const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign'])
      const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))
      return endsWithOwn(raw) ? { pair, raw } : null
    }))
    for (const hit of batch) {
      if (!hit || found.length >= max) continue
      const { d } = await subtle.exportKey('jwk', hit.pair.privateKey)
      found.push({ address: base58(hit.raw), seed: fromBase64Url(d) })
    }
  }
  return found
}

/** How many addresses the reserve holds right now. */
export async function poolSize(kv) {
  let count = 0
  let cursor
  do {
    const page = await kv.list({ prefix: PREFIX, cursor })
    count += page.keys.length
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return count
}

/**
 * Tops the reserve up to `target`, spending at most `budgetMs` searching.
 *
 * Each address is written as soon as it is found, so a run cut short still keeps
 * what it ground.
 */
export async function refill(kv, { target = POOL_TARGET, budgetMs = 15_000, now } = {}) {
  const had = await poolSize(kv)
  if (had >= target) return { had, added: 0 }
  const deadline = (now ?? Date.now)() + budgetMs
  let added = 0
  while (had + added < target) {
    const left = deadline - (now ?? Date.now)()
    if (left <= 0) break
    const [hit] = await grind({ budgetMs: left, max: 1, now })
    if (!hit) break
    const seed = btoa(String.fromCharCode(...hit.seed))
    await kv.put(`${PREFIX}${hit.address}`, seed, { metadata: { groundAt: new Date().toISOString() } })
    added++
  }
  return { had, added }
}

/**
 * Takes one address out of the reserve: its 32-byte seed and the address itself.
 * Null when the reserve is empty, which the caller answers with a random address.
 *
 * KV is eventually consistent, so two launches at two edges within the same minute
 * could draw the same address. Picking at random among what is listed makes that
 * unlikely, and it is harmless when it happens: the second pool cannot open on a
 * mint that already exists, the transaction is rejected, and the agent asks again.
 */
export async function take(kv) {
  const { keys } = await kv.list({ prefix: PREFIX, limit: 50 })
  const order = keys.map((k) => k.name).sort(() => Math.random() - 0.5)
  for (const name of order) {
    const value = await kv.get(name)
    await kv.delete(name)
    if (!value) continue
    const seed = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
    if (seed.length !== 32) continue
    return { address: name.slice(PREFIX.length), seed }
  }
  return null
}
