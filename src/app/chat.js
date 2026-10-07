// LFOwn — a chat room in the page (see src/chat.mjs for the room itself).
//
//   mountChat(el, { room, title, getSession, ensureWallet, tags, holdings })
//
// `tags(wallet)` names what a wallet is to this room (["creator"], …); `holdings(wallets)`
// resolves to a Map of wallet → dollars held, shown beside each name and kept fresh.
//
// Anyone reads, live. Writing takes a connected wallet and, once per month per wallet, a
// signed sign-in message — no transaction. The signature is kept in this browser and sent
// whenever the socket opens.

import { esc } from './escape.js'

const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`
const SESSION_DAYS = 30
const authKey = (wallet) => `lfown-chat-auth:${wallet}`

// The same text src/chat.mjs verifies, character for character.
const signInMessage = (wallet, expires) =>
  `Sign in to chat on LFOWN.\n\nWallet: ${wallet}\nExpires: ${new Date(expires).toISOString()}\n\nThis is not a transaction and costs nothing.`

function savedAuth(wallet) {
  try {
    const auth = JSON.parse(localStorage.getItem(authKey(wallet)))
    return auth?.wallet === wallet && auth.expires > Date.now() + 60_000 ? auth : null
  } catch { return null }
}

async function signIn(session) {
  if (typeof session.signMessage !== 'function') throw new Error(`${session.name ?? 'This wallet'} cannot sign messages, so it cannot chat.`)
  const expires = Date.now() + SESSION_DAYS * 86_400_000
  const signature = await session.signMessage(new TextEncoder().encode(signInMessage(session.address, expires)))
  if (!signature) throw new Error(`${session.name ?? 'This wallet'} cannot sign messages, so it cannot chat.`)
  const auth = { wallet: session.address, expires, signature: btoa(String.fromCharCode(...signature)) }
  try { localStorage.setItem(authKey(session.address), JSON.stringify(auth)) } catch {}
  return auth
}

/** A colour of its own for each wallet, from its address: easier to follow a thread. */
const hue = (wallet) => [...wallet].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

function when(at) {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

const money = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : n >= 1 ? `$${n.toFixed(0)}` : n > 0 ? '<$1' : '$0')

export function mountChat(el, { room, title = 'Chat', getSession, ensureWallet, tags = () => [], holdings = null }) {
  el.classList.add('chat')
  el.innerHTML = `
    <div class="chat-head"><h3>${esc(title)}</h3><span class="chat-live" data-live>connecting…</span></div>
    <div class="chat-log" data-log><button class="chat-more" type="button" data-more hidden>Earlier messages</button></div>
    <form class="chat-form" data-form>
      <textarea data-input rows="1" maxlength="500" placeholder="Say something…" aria-label="Message"></textarea>
      <button class="btn" type="submit" data-send>Send</button>
    </form>
    <p class="chat-note" data-note></p>`
  const log = el.querySelector('[data-log]')
  const more = el.querySelector('[data-more]')
  const input = el.querySelector('[data-input]')
  const note = el.querySelector('[data-note]')
  const live = el.querySelector('[data-live]')
  const say = (text, warn = false) => { note.textContent = text; note.classList.toggle('warn', warn) }

  const shown = new Map() // id → element
  let oldest = null
  let me = null // the wallet this socket is signed in as
  let admin = false
  let ws = null
  let retry = 0
  let closed = false
  let pending = null // a message waiting for the sign-in to land
  // Dollars held per wallet, fetched in batches for the wallets on screen, refreshed each minute.
  const held = new Map()
  let heldTimer = null
  const paintHeld = (wallet) => {
    for (const b of log.querySelectorAll(`.chat-held[data-w="${CSS.escape(wallet)}"]`)) {
      const v = held.get(wallet)
      b.textContent = v == null ? '' : money(v)
      b.hidden = v == null
      b.classList.toggle('zero', v === 0)
    }
  }
  const fetchHeld = (wallets) => {
    if (!holdings || !wallets.length) return
    holdings(wallets).then((map) => {
      for (const w of wallets) { held.set(w, map.get(w) ?? 0); paintHeld(w) }
    }).catch((e) => console.error('chat holdings unavailable:', e.message))
  }
  const missing = new Set()
  const wantHeld = (wallet) => {
    if (!holdings || held.has(wallet)) return
    missing.add(wallet)
    clearTimeout(heldTimer)
    heldTimer = setTimeout(() => { const ws = [...missing]; missing.clear(); fetchHeld(ws) }, 250)
  }
  const refreshHeld = holdings ? setInterval(() => { if (!document.hidden) fetchHeld([...held.keys()]) }, 60_000) : null

  const line = (m) => {
    const li = document.createElement('div')
    li.className = 'chat-msg'
    li.dataset.id = m.id
    li.dataset.wallet = m.wallet
    li.dataset.at = m.at
    const badges = tags(m.wallet)
    li.innerHTML = `<div class="chat-meta"><a class="chat-who" href="/creator/${esc(m.wallet)}" style="--h:${hue(m.wallet)}">${esc(short(m.wallet))}</a>
      ${badges.map((t) => `<span class="chat-tag ${esc(t)}">${esc(t)}</span>`).join('')}
      <span class="chat-held" data-w="${esc(m.wallet)}" title="What this wallet holds of the coin now" hidden></span>
      <time datetime="${new Date(m.at).toISOString()}">${esc(when(m.at))}</time>
      ${admin ? `<button type="button" class="chat-mod" data-del="${m.id}">delete</button><button type="button" class="chat-mod" data-ban="${esc(m.wallet)}">ban</button>` : ''}</div>
      <p class="chat-text"></p>`
    // Text, never HTML: a message is whatever someone typed.
    li.querySelector('.chat-text').textContent = m.text
    const b = li.querySelector('.chat-held')
    if (held.has(m.wallet)) { const v = held.get(m.wallet); b.textContent = money(v); b.hidden = false; b.classList.toggle('zero', v === 0) } else wantHeld(m.wallet)
    return li
  }
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80
  const add = (messages, { prepend = false } = {}) => {
    const stick = nearBottom()
    const before = log.scrollHeight
    const frag = document.createDocumentFragment()
    for (const m of messages) {
      if (shown.has(m.id)) continue
      const li = line(m)
      shown.set(m.id, li)
      frag.appendChild(li)
      if (oldest == null || m.id < oldest) oldest = m.id
    }
    if (prepend) {
      more.after(frag)
      log.scrollTop += log.scrollHeight - before
    } else {
      log.appendChild(frag)
      if (stick) log.scrollTop = log.scrollHeight
    }
  }
  const empty = () => {
    if (!shown.size && !log.querySelector('.chat-empty')) log.insertAdjacentHTML('beforeend', '<p class="chat-empty">No message yet. Start it.</p>')
    else if (shown.size) log.querySelector('.chat-empty')?.remove()
  }
  const redraw = () => {
    const all = [...shown.entries()].sort((a, b) => a[0] - b[0])
    for (const [id, old] of all) {
      const fresh = line({ id, wallet: old.dataset.wallet, text: old.querySelector('.chat-text').textContent, at: Number(old.dataset.at) })
      old.replaceWith(fresh)
      shown.set(id, fresh)
    }
  }

  const send = (event) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)) }
  const authenticate = () => {
    const session = getSession()
    const auth = session && savedAuth(session.address)
    if (auth) send({ type: 'auth', auth })
  }

  function open() {
    if (closed) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/api/chat/${encodeURIComponent(room)}/ws`)
    ws.addEventListener('open', () => { retry = 0; live.textContent = 'live'; live.classList.add('on'); authenticate() })
    ws.addEventListener('message', (e) => {
      let ev
      try { ev = JSON.parse(e.data) } catch { return }
      if (ev.type === 'history') {
        add(ev.messages)
        more.hidden = ev.messages.length < 50
        empty()
      } else if (ev.type === 'message') {
        add([ev.message])
        empty()
      } else if (ev.type === 'deleted') {
        for (const id of ev.ids) { shown.get(id)?.remove(); shown.delete(id) }
        empty()
      } else if (ev.type === 'auth') {
        if (!ev.ok) {
          try { localStorage.removeItem(authKey(getSession()?.address ?? '')) } catch {}
          me = null
          say(ev.error, true)
          return
        }
        me = ev.wallet
        if (admin !== ev.admin) { admin = ev.admin; redraw() }
        if (pending) { send({ type: 'say', text: pending }); pending = null; input.value = ''; say('') }
      } else if (ev.type === 'error') {
        say(ev.error, true)
      }
    })
    ws.addEventListener('close', () => {
      me = null
      live.textContent = 'reconnecting…'
      live.classList.remove('on')
      if (!closed) setTimeout(open, Math.min(30_000, 1_000 * 2 ** retry++))
    })
  }
  open()

  more.addEventListener('click', async () => {
    more.disabled = true
    try {
      const { messages } = await fetch(`/api/chat/${encodeURIComponent(room)}?before=${oldest}`).then((r) => r.json())
      add(messages, { prepend: true })
      more.hidden = messages.length < 50
    } catch { say('Could not load earlier messages.', true) }
    more.disabled = false
  })

  log.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]')
    const ban = e.target.closest('[data-ban]')
    if (del) send({ type: 'delete', id: Number(del.dataset.del) })
    if (ban && confirm(`Ban ${ban.dataset.ban} from this room and delete their messages?`)) send({ type: 'ban', wallet: ban.dataset.ban })
  })

  // Enter sends, Shift+Enter is a new line; the box grows with what is typed.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.querySelector('[data-form]').requestSubmit() }
  })
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px` })

  el.querySelector('[data-form]').addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    try {
      const session = getSession() ?? await ensureWallet()
      if (me === session.address) {
        send({ type: 'say', text })
        input.value = ''
        input.style.height = 'auto'
        say('')
        return
      }
      // Not signed in on this socket yet: sign in (once a month), then the message goes.
      let auth = savedAuth(session.address)
      if (!auth) { say('Sign the message in your wallet — it is not a transaction.'); auth = await signIn(session) }
      pending = text
      send({ type: 'auth', auth })
    } catch (err) {
      say(/reject|declin|cancel/i.test(err?.message ?? '') ? 'You declined in your wallet.' : (err?.message ?? 'Could not send.'), true)
    }
  })

  return {
    /** The page's wallet changed: a fresh socket, signed in as the new one if it has signed before. */
    sessionChanged() {
      me = null
      if (admin) { admin = false; redraw() }
      ws?.close() // reopens on its own, and signs in again
    },
    close() { closed = true; clearInterval(refreshHeld); clearTimeout(heldTimer); ws?.close() },
  }
}
