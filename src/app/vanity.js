// LFOwn — mint addresses that end in `own`.
//
// A Solana address is a 32-byte public key: nothing can be appended to it, so the
// only way to end one in `own` is to keep generating keys until one does. Base58
// has 58 characters, which puts a three-character suffix at roughly 195,000 tries —
// about three seconds spread across the cores of a laptop, ten at the 95th percentile.
//
// Ground here rather than on a server on purpose. This keypair signs the transaction
// that opens the pool, and a private key that never crosses the network cannot be
// intercepted on the way back. It is thrown away the moment the pool exists: the
// config makes the mint authority immutable, so it can never sign anything again.

export const SUFFIX = 'own'

/**
 * Starts the search across every core the browser will admit to.
 *
 * Returns the winning 32-byte seed; `Keypair.fromSeed` turns it back into the pair.
 * `cancel` stops the workers, which otherwise run until one of them wins.
 */
export function grind(suffix = SUFFIX, { onProgress } = {}) {
  // Capped: a machine reporting 32 cores does not want 32 threads spinning flat out
  // behind a form, and the gain past a handful is small next to the heat.
  const cores = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8))
  let workers = []
  let tries = 0
  let settled = false

  const stop = () => {
    for (const w of workers) w.terminate()
    workers = []
  }

  const promise = new Promise((resolve, reject) => {
    for (let i = 0; i < cores; i++) {
      let worker
      try {
        worker = new Worker('/app/grind-worker.js', { type: 'module' })
      } catch (e) {
        stop()
        reject(new Error(`this browser would not start the address search: ${e.message}`))
        return
      }
      worker.onmessage = ({ data }) => {
        if (settled) return
        if (data?.seed) {
          settled = true
          stop()
          resolve(new Uint8Array(data.seed))
          return
        }
        tries += data?.tries ?? 0
        onProgress?.(tries)
      }
      worker.onerror = (e) => {
        if (settled) return
        settled = true
        stop()
        reject(new Error(`the address search failed: ${e.message || 'worker error'}`))
      }
      workers.push(worker)
      // The worker waits on a message before it starts; without this it sits idle
      // and the search reports nothing, forever.
      worker.postMessage({ suffix })
    }
  })

  return { promise, cancel: stop, cores }
}
