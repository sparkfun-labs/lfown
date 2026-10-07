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
    const session = {
      name: wallet.name,
      address: publicKey.toBase58(),
      disconnect: () => { unfollow(session); return legacy.disconnect?.() },
      async signAndSend(tx, connection) {
        const signed = await legacy.signTransaction(tx)
        return connection.sendRawTransaction(signed.serialize())
      },
      async signOnly(tx) {
        const signed = await legacy.signTransaction(tx)
        return signed.serialize({ requireAllSignatures: false, verifySignatures: false })
      },
      async signAllOnly(txs) {
        if (typeof legacy.signAllTransactions !== 'function') return null
        const signed = await legacy.signAllTransactions(txs)
        return signed.map((t) => t.serialize({ requireAllSignatures: false, verifySignatures: false }))
      },
      /** The wallet's ed25519 signature of `bytes`, or null when it cannot sign messages. */
      async signMessage(bytes) {
        if (typeof legacy.signMessage !== 'function') return null
        const { signature } = await legacy.signMessage(bytes, 'utf8')
        return Uint8Array.from(signature)
      },
    }
    // The account the wallet has selected now: a switch to an account this site was never
    // shown comes as null, and a silent reconnect is the only way to learn which it is.
    const current = async (key = legacy.publicKey) => {
      if (key) return key.toBase58()
      try { return (await legacy.connect({ onlyIfTrusted: true })).publicKey?.toBase58() ?? null } catch { return null }
    }
    const onSwitch = (key) => current(key).then((address) => moved(session, address))
    legacy.on?.('accountChanged', onSwitch)
    follow(session, {
      check: () => current().then((address) => moved(session, address)),
      stop: () => (legacy.off ?? legacy.removeListener)?.call(legacy, 'accountChanged', onSwitch),
    })
    return session
  }

  const connectFeature = wallet.features['standard:connect']
  const { accounts } = await connectFeature.connect(silent ? { silent: true } : undefined)
  // Mutable: when the person switches accounts in the wallet, signing follows the new one.
  let account = accounts[0]
  if (!account) throw new Error('the wallet returned no account')
  try { localStorage.setItem(REMEMBERED, wallet.name) } catch {}

  const signAndSendFeature = wallet.features['solana:signAndSendTransaction']
  const signFeature = wallet.features['solana:signTransaction']

  const session = {
    name: wallet.name,
    address: account.address,
    disconnect: () => { unfollow(session); return wallet.features['standard:disconnect']?.disconnect() },
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

    /**
     * The same, for several transactions at once and a single approval.
     *
     * A launch that shares fees with holders is two transactions — the pool has to
     * exist before it can be handed to the vault — and asking for two approvals to do
     * one thing reads like something went wrong. The Wallet Standard takes as many
     * inputs as you give it and answers in the same order.
     *
     * Null when the wallet cannot do it, so the caller can fall back to one at a time
     * rather than lose the launch.
     */
    async signAllOnly(txs) {
      if (!signFeature) return null
      const signed = await signFeature.signTransaction(...txs.map((tx) => ({
        account,
        chain: 'solana:mainnet',
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      })))
      if (signed.length !== txs.length) throw new Error(`${wallet.name} signed ${signed.length} of ${txs.length} transactions`)
      return signed.map((o) => o.signedTransaction)
    },

    /** The wallet's ed25519 signature of `bytes` (a sign-in, not a transaction), or null when it cannot sign messages. */
    async signMessage(bytes) {
      const feature = wallet.features['solana:signMessage']
      if (!feature) return null
      const [{ signature }] = await feature.signMessage({ account, message: bytes })
      return Uint8Array.from(signature)
    },
  }
  // The account the wallet shows this site now. Empty after a switch to an account the site
  // was never connected to: a silent connect then says which, or that there is none.
  const check = async () => {
    let next = wallet.accounts?.[0] ?? null
    if (!next) {
      try { next = (await connectFeature.connect({ silent: true })).accounts?.[0] ?? null } catch { next = null }
    }
    if (next && next.address !== session.address) account = next
    moved(session, next?.address ?? null)
  }
  const off = wallet.features['standard:events']?.on('change', (props) => { if (props.accounts) check() })
  follow(session, { check, stop: () => off?.() })
  return session
}

// ── following the wallet ─────────────────────────────────────────────────────
//
// Switching accounts in Phantom, Jupiter or any wallet, in the extension or in the app's own
// browser, changes who is signing. The wallet says so with an event (Wallet Standard's
// `change`, the older providers' `accountChanged`), and in case it says nothing, the account
// is checked again whenever the page comes back into focus. Either way the session is
// updated in place and the page hears it as one `lfown:wallet-change` event on window:
// detail.address is the new address, or null once the wallet no longer shows this site any.

let followed = null // { session, check, stop }
function follow(session, watcher) {
  if (followed) followed.stop()
  followed = { session, ...watcher }
}
function unfollow(session) {
  if (followed?.session !== session) return
  followed.stop()
  followed = null
}
function moved(session, address) {
  if (followed?.session !== session || address === session.address) return
  if (address) session.address = address
  else unfollow(session)
  window.dispatchEvent(new CustomEvent('lfown:wallet-change', { detail: { session, address } }))
}
let lastCheck = 0
const recheck = () => {
  if (!followed || document.hidden || Date.now() - lastCheck < 1_000) return
  lastCheck = Date.now()
  followed.check()
}
window.addEventListener('focus', recheck)
document.addEventListener('visibilitychange', recheck)

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function bs58(bytes) {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out
}
