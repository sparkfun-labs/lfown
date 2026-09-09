// One core's share of the search for a mint address ending in `own`.
//
// Only the public key is derived for each candidate: that is the whole cost, and
// the private half is just the 32 random bytes that produced it. Those bytes are
// what comes back, and Keypair.fromSeed rebuilds the pair from them on the main
// thread — so nothing that can sign ever leaves this machine.

import { ed25519 } from '@noble/curves/ed25519.js'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function bs58(bytes) {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out
}

const REPORT = 5000

self.onmessage = ({ data }) => {
  const suffix = String(data?.suffix ?? 'own')
  const seed = new Uint8Array(32)
  let tries = 0
  // Deliberately blocking: this worker exists to burn one core until it wins, and
  // the page it belongs to is on another thread.
  for (;;) {
    crypto.getRandomValues(seed)
    tries++
    if (bs58(ed25519.getPublicKey(seed)).endsWith(suffix)) {
      self.postMessage({ seed, tries })
      return
    }
    if (tries % REPORT === 0) self.postMessage({ tries: REPORT })
  }
}
