// LFOwn — a throwaway wallet for a local chain, and nowhere else.
//
// A fair launch on localnet cannot be tried with Phantom: Phantom does not sign for a
// validator on this machine. This registers a Wallet Standard wallet backed by a keypair
// kept in this browser's localStorage, so the pages can be used end to end against
// `npm run localnet` exactly as they will be with a real wallet.
//
// fair.js loads it only for a test cluster (localnet, devnet) and only when the page is
// served from this machine. `?as=alice` picks a named key, so one browser can play the creator,
// a backer and a trader in turn.

import { Keypair, Transaction } from '@solana/web3.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

export function installDevWallet() {
  if (!LOCAL_HOSTS.has(location.hostname)) return null
  const who = new URLSearchParams(location.search).get('as') || 'me'
  const storeKey = `lfown-dev-wallet:${who}`
  let secret = null
  try { secret = JSON.parse(localStorage.getItem(storeKey)) } catch {}
  const keypair = secret ? Keypair.fromSecretKey(Uint8Array.from(secret)) : Keypair.generate()
  if (!secret) { try { localStorage.setItem(storeKey, JSON.stringify([...keypair.secretKey])) } catch {} }

  const account = {
    address: keypair.publicKey.toBase58(),
    publicKey: keypair.publicKey.toBytes(),
    chains: ['solana:localnet', 'solana:devnet', 'solana:mainnet'],
    features: ['solana:signTransaction'],
  }
  const sign = (bytes) => {
    const tx = Transaction.from(bytes)
    tx.partialSign(keypair)
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false })
  }
  const wallet = {
    version: '1.0.0',
    name: `Local test wallet (${who})`,
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#d7263d"/><text x="16" y="22" font-size="16" text-anchor="middle" fill="#fff" font-family="monospace">L</text></svg>'),
    chains: account.chains,
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy'],
        signTransaction: async (...inputs) => inputs.map((i) => ({ signedTransaction: sign(i.transaction) })),
      },
    },
  }

  // Both halves of the Wallet Standard handshake: announce now, and answer an app that
  // asks later.
  const register = ({ register: add }) => add(wallet)
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
  window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail))
  return keypair.publicKey.toBase58()
}
