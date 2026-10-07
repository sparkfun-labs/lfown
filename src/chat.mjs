// LFOwn — chat rooms.
//
//   GET /api/chat/<mint>            the coin's room: its messages, newest last (?before=<id> pages back)
//   GET /api/chat/<mint>/ws         a WebSocket: the latest messages, then every new one live
//
// One room per coin, on the coin's page. Each is one Durable Object holding its
// whole history in its own SQLite, kept for good. Anyone reads; a connected wallet writes,
// once it has signed the sign-in message below (no transaction, nothing on chain). The
// signature is the session: the page keeps it and sends it when it opens the socket, and
// the room checks it every time, so there is no server secret and no account.
//
// Moderation: wallets listed in CHAT_ADMINS (comma-separated) can delete a message or ban a
// wallet from the room, over the same socket.

import { ed25519 } from '@noble/curves/ed25519'

const ROOM = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const MAX_TEXT = 500
const PAGE = 50
/** How long a sign-in lasts. */
const SESSION_DAYS = 30
/** At most one message per this many ms, and BURST in any minute, per wallet. */
const MIN_GAP_MS = 2_000
const BURST = 12

/** The exact text a wallet signs to chat. The page builds it the same way. */
export function signInMessage(wallet, expires) {
  return `Sign in to chat on LFOwn.\n\nWallet: ${wallet}\nExpires: ${new Date(expires).toISOString()}\n\nThis is not a transaction and costs nothing.`
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function fromBase58(s) {
  let n = 0n
  for (const c of s) {
    const i = B58.indexOf(c)
    if (i < 0) throw new Error('not base58')
    n = n * 58n + BigInt(i)
  }
  const out = []
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n }
  for (const c of s) { if (c !== '1') break; out.unshift(0) }
  return Uint8Array.from(out)
}
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** The wallet a sign-in proves, or null. */
export function verifySignIn(auth, now = Date.now()) {
  try {
    const { wallet, expires, signature } = auth ?? {}
    if (!WALLET.test(wallet ?? '') || !Number.isFinite(expires) || expires < now || expires > now + (SESSION_DAYS + 1) * 86_400_000) return null
    const key = fromBase58(wallet)
    if (key.length !== 32) return null
    const message = new TextEncoder().encode(signInMessage(wallet, expires))
    return ed25519.verify(fromBase64(String(signature)), message, key) ? wallet : null
  } catch {
    return null
  }
}

/** What a message may say: trimmed, control characters out, one paragraph break at most in a row. */
export function cleanText(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT)
}

const row = (r) => ({ id: r.id, wallet: r.wallet, text: r.text, at: r.at })

// A plain class rather than one extending `cloudflare:workers`' DurableObject: the
// runtime takes either, and this way Node (scripts/test-worker.mjs) can import the Worker.
export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx
    this.sql = ctx.storage.sql
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`)
    this.sql.exec('CREATE TABLE IF NOT EXISTS bans (wallet TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT NOT NULL)')
    this.admins = new Set(String(env.CHAT_ADMINS ?? '').split(',').map((s) => s.trim()).filter(Boolean))
    // Per-wallet send times, in memory: forgotten when the room sleeps, which is fine.
    this.sent = new Map()
  }

  history(before = null, limit = PAGE) {
    const rows = before
      ? this.sql.exec('SELECT id, wallet, text, at FROM messages WHERE deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?', before, limit).toArray()
      : this.sql.exec('SELECT id, wallet, text, at FROM messages WHERE deleted = 0 ORDER BY id DESC LIMIT ?', limit).toArray()
    return rows.reverse().map(row)
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      // Hibernatable: an idle room costs nothing while its readers keep the socket open.
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment({ wallet: null })
      server.send(JSON.stringify({ type: 'history', messages: this.history() }))
      return new Response(null, { status: 101, webSocket: client })
    }
    const before = Number(url.searchParams.get('before')) || null
    return Response.json({ messages: this.history(before) }, { headers: { 'cache-control': 'no-store' } })
  }

  broadcast(event) {
    const data = JSON.stringify(event)
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data) } catch { /* closing */ }
    }
  }

  async webSocketMessage(ws, raw) {
    const reply = (event) => { try { ws.send(JSON.stringify(event)) } catch {} }
    let msg
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) } catch { return reply({ type: 'error', error: 'Not JSON.' }) }
    const state = ws.deserializeAttachment() ?? {}

    if (msg.type === 'auth') {
      const wallet = verifySignIn(msg.auth)
      if (!wallet) return reply({ type: 'auth', ok: false, error: 'The sign-in did not check out. Sign in again.' })
      ws.serializeAttachment({ wallet })
      return reply({ type: 'auth', ok: true, wallet, admin: this.admins.has(wallet) })
    }

    const wallet = state.wallet
    if (!wallet) return reply({ type: 'error', error: 'Sign in with your wallet to write.' })

    if (msg.type === 'say') {
      if (this.sql.exec('SELECT 1 FROM bans WHERE wallet = ?', wallet).toArray().length) return reply({ type: 'error', error: 'This wallet cannot write in this room.' })
      const text = cleanText(msg.text)
      if (!text) return
      const now = Date.now()
      const times = (this.sent.get(wallet) ?? []).filter((t) => now - t < 60_000)
      if (times.length && now - times[times.length - 1] < MIN_GAP_MS) return reply({ type: 'error', error: 'Slow down a little.' })
      if (times.length >= BURST) return reply({ type: 'error', error: 'That is a lot of messages. Wait a minute.' })
      times.push(now)
      this.sent.set(wallet, times)
      const [r] = this.sql.exec('INSERT INTO messages (wallet, text, at) VALUES (?, ?, ?) RETURNING id, wallet, text, at', wallet, text, now).toArray()
      return this.broadcast({ type: 'message', message: row(r) })
    }

    if (!this.admins.has(wallet)) return reply({ type: 'error', error: 'Not allowed.' })
    if (msg.type === 'delete' && Number.isInteger(msg.id)) {
      this.sql.exec('UPDATE messages SET deleted = 1 WHERE id = ?', msg.id)
      return this.broadcast({ type: 'deleted', ids: [msg.id] })
    }
    if (msg.type === 'ban' && WALLET.test(msg.wallet ?? '')) {
      this.sql.exec('INSERT OR REPLACE INTO bans (wallet, at, by) VALUES (?, ?, ?)', msg.wallet, Date.now(), wallet)
      // Their messages go with them.
      const ids = this.sql.exec('UPDATE messages SET deleted = 1 WHERE wallet = ? AND deleted = 0 RETURNING id', msg.wallet).toArray().map((r) => r.id)
      return this.broadcast({ type: 'deleted', ids })
    }
    return reply({ type: 'error', error: 'Unknown request.' })
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, 'closing') } catch {}
  }
}

/** /api/chat/* — hands the request to its room. */
export async function handleChat(url, request, env) {
  const [, , , room, tail] = url.pathname.split('/') // '', 'api', 'chat', room, 'ws'?
  if (!env.CHAT) return Response.json({ error: 'chat is off' }, { status: 404 })
  if (!ROOM.test(room ?? '') || (tail && tail !== 'ws')) return Response.json({ error: 'no such room' }, { status: 404 })
  if (tail === 'ws' && request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 })
  if (!tail && request.method !== 'GET') return new Response('method not allowed', { status: 405 })
  // Only this site's pages open sockets: another site's page would ride its visitors' IPs.
  const origin = request.headers.get('Origin')
  if (tail === 'ws' && origin && origin !== url.origin && origin !== env.PUBLIC_ORIGIN) return new Response('forbidden', { status: 403 })
  const stub = env.CHAT.get(env.CHAT.idFromName(room))
  return stub.fetch(request)
}
