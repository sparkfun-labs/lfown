// Wallet connection over the Wallet Standard, with a fallback to the older
// injected providers. No adapter library: the standard is an event handshake
// and two feature calls, and a launchpad should not ship a dependency tree to
// discover a browser extension.

const wallets = []
let handshakeDone = false

function addLegacy() {
  // Wallets that predate the standard only expose a window global.
  const known = [
    [window.solana, 'isPhantom', 'Phantom'],
    [window.solflare, 'isSolflare', 'Solflare'],
    [window.backpack, 'isBackpack', 'Backpack'],
    [window.glow, 'isGlow', 'Glow'],
    [window.coinbaseSolana, 'isCoinbaseWallet', 'Coinbase Wallet'],
    [window.trustwallet?.solana, 'isTrust', 'Trust'],
  ]
  for (const [provider, flag, name] of known) {
    if (!provider?.[flag]) continue
    if (wallets.some((w) => w.__legacy === provider || w.name === name)) continue
    wallets.push({ name, icon: null, __legacy: provider })
  }
}

function handshake() {
  if (handshakeDone) return
  handshakeDone = true
  const register = (...found) => {
    for (const w of found) {
      if (!w.chains?.some((c) => c.startsWith('solana:'))) continue
      if (wallets.some((existing) => existing.name === w.name)) continue
      wallets.push(w)
    }
  }
  // Wallets that load after us announce themselves; wallets already loaded answer
  // the app-ready event. Both paths land in the same list.
  window.addEventListener('wallet-standard:register-wallet', (e) => e.detail({ register }))
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register } }))
}

/** Every Solana wallet this browser exposes, standard or legacy. */
export function available() {
  handshake()
  addLegacy()
  return wallets
}

/**
 * A wallet's own icon, ready to assign to `img.src`.
 *
 * Wallet Standard icons are data URIs — `data:image/svg+xml;base64,…` and three
 * siblings — not URLs. Running one through an http(s)-only sanitiser leaves an
 * empty src and the browser draws its broken-image glyph, which is what every row
 * in the picker showed. An SVG inside an <img> is script-sandboxed by the browser
 * (no scripts, no external fetches), so these are safe to render; anything outside
 * the four shapes the standard defines, or a plain URL that is not https, is refused.
 *
 * Returns a raw string for a DOM property. Do not interpolate it into HTML.
 */
const DATA_ICON = /^data:image\/(?:svg\+xml|png|webp|gif|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/

export function iconSrc(value) {
  const raw = String(value ?? '').trim()
  if (DATA_ICON.test(raw)) return raw
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

/**
 * Puts a wallet's icon in place of `slot`, but only once it has actually loaded —
 * so an icon that fails for any reason leaves the neutral placeholder rather than
 * a broken picture.
 */
export function showIcon(slot, icon) {
  const src = iconSrc(icon)
  if (!src || !slot) return
  const img = new Image()
  img.alt = ''
  img.addEventListener('load', () => slot.replaceWith(img), { once: true })
  img.src = src
}

const REMEMBERED = 'lfown-wallet'

/** The wallet someone last connected, if any, so a refresh can pick it up again. */
export function remembered() {
  try { return localStorage.getItem(REMEMBERED) } catch { return null }
}

export function forget() {
  try { localStorage.removeItem(REMEMBERED) } catch {}
}

/**
 * Reconnects the last wallet without prompting.
 *
 * `silent` means the wallet answers only if it already trusts this site; if it does
 * not, it declines rather than opening a popup nobody asked for. Reloading a page
 * should not cost a click, and it should not steal focus either.
 */
export async function reconnect() {
  const name = remembered()
  if (!name) return null
  const wallet = available().find((w) => w.name === name)
  if (!wallet) return null
  try {
    return await connect(wallet, { silent: true })
  } catch {
    forget() // the wallet no longer trusts us, or was removed
    return null
  }
}

/** Connects and returns { address, signAndSend(tx, connection) }. */
export async function connect(wallet, { silent = false } = {}) {
  if (wallet.__legacy) {
    const legacy = wallet.__legacy
    const { publicKey } = await legacy.connect(silent ? { onlyIfTrusted: true } : undefined)
    try { localStorage.setItem(REMEMBERED, wallet.name) } catch {}
    return {
      name: wallet.name,
      address: publicKey.toBase58(),
      disconnect: () => legacy.disconnect?.(),
      async signAndSend(tx, connection) {
        const signed = await legacy.signTransaction(tx)
        return connection.sendRawTransaction(signed.serialize())
      },
      async signOnly(tx) {
        const signed = await legacy.signTransaction(tx)
        return signed.serialize({ requireAllSignatures: false, verifySignatures: false })
      },
    }
  }

  const connectFeature = wallet.features['standard:connect']
  const { accounts } = await connectFeature.connect(silent ? { silent: true } : undefined)
  const account = accounts[0]
  if (!account) throw new Error('the wallet returned no account')
  try { localStorage.setItem(REMEMBERED, wallet.name) } catch {}

  const signAndSendFeature = wallet.features['solana:signAndSendTransaction']
  const signFeature = wallet.features['solana:signTransaction']

  return {
    name: wallet.name,
    address: account.address,
    disconnect: () => wallet.features['standard:disconnect']?.disconnect(),
    async signAndSend(tx, connection) {
      // Preferred: the wallet broadcasts through its own RPC, so a dropped
      // transaction is its problem to retry, not ours.
      if (signAndSendFeature) {
        const [{ signature }] = await signAndSendFeature.signAndSendTransaction({
          account,
          chain: 'solana:mainnet',
          transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        })
        return bs58(signature)
      }
      if (!signFeature) throw new Error(`${wallet.name} cannot sign transactions`)
      const [{ signedTransaction }] = await signFeature.signTransaction({
        account,
        chain: 'solana:mainnet',
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      })
      return connection.sendRawTransaction(signedTransaction)
    },

    /**
     * The wallet's signature, handed back rather than broadcast.
     *
     * Phantom will not simulate a transaction it is not the only signer of, and says
     * so with a warning on the approval screen. Its guidance is to take the wallet's
     * signature first and attach the remaining ones afterwards — which is what a
     * launch needs, since the new mint has to sign alongside its creator.
     *
     * Returns null when the wallet can only sign-and-send, so the caller can fall
     * back to the old order rather than lose the launch.
     */
    async signOnly(tx) {
      if (!signFeature) return null
      const [{ signedTransaction }] = await signFeature.signTransaction({
        account,
        chain: 'solana:mainnet',
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      })
      return signedTransaction
    },
  }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function bs58(bytes) {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out
}
