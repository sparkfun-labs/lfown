// LFOwn — the header's wallet button on pages that ship no app of their own.
//
// /launch, the coins pages and /profile each drive the button themselves, because
// what they do next depends on the wallet. Every other page — $LFOWN, rewards, the
// leaderboard, a creator's record — only needs the button to connect, show who is
// connected and offer the profile, and this is that, shared.

import { available, connect, reconnect, forget, showIcon } from './wallet.js'
import { isPhone, toggleWalletAppsMenu } from './mobile-wallet.js'

const button = document.querySelector('#connect')
const menu = document.querySelector('#wallet-menu')
let session = null
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function paint() {
  if (!button) return
  if (session) {
    button.textContent = short(session.address)
    button.title = `${session.name} — ${session.address}`
    button.disabled = false
    return
  }
  if (menu) menu.hidden = true
  const found = available().length
  const phone = !found && isPhone()
  button.textContent = found ? 'Connect wallet' : phone ? 'Open in wallet' : 'No wallet found'
  button.disabled = !found && !phone
}

/** One wallet: use it. Several: let the person say which one. */
function choose(found) {
  if (found.length === 1) return Promise.resolve(found[0])
  const dialog = document.createElement('dialog')
  dialog.id = 'wallet-picker'
  dialog.innerHTML = '<div class="picker-head">Choose a wallet</div><ul class="picker-list"></ul><button class="btn ghost" type="button" id="picker-close">Cancel</button>'
  document.body.appendChild(dialog)
  const list = dialog.querySelector('.picker-list')
  return new Promise((resolve, reject) => {
    for (const w of found) {
      const li = document.createElement('li')
      li.innerHTML = `<button type="button"><span class="blank"></span><span>${esc(w.name)}</span></button>`
      showIcon(li.querySelector('.blank'), w.icon)
      li.querySelector('button').addEventListener('click', () => { dialog.close(); resolve(w) })
      list.appendChild(li)
    }
    dialog.querySelector('#picker-close').onclick = () => dialog.close()
    dialog.addEventListener('close', () => { dialog.remove(); reject(new Error('Wallet choice cancelled.')) }, { once: true })
    dialog.showModal()
  })
}

button?.addEventListener('click', async () => {
  if (session) { menu.hidden = !menu.hidden; return }
  if (!available().length && isPhone()) { toggleWalletAppsMenu(button); return }
  button.textContent = 'Connecting…'
  try {
    session = await connect(await choose(available()))
  } catch (e) {
    button.textContent = e.message
    setTimeout(paint, 1800)
    return
  }
  paint()
})

menu?.addEventListener('click', async (e) => {
  const act = e.target.dataset?.act
  if (!act || !session) return
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(session.address); e.target.textContent = 'Copied' } catch { e.target.textContent = 'Copy failed' }
    setTimeout(() => { e.target.textContent = 'Copy address' }, 1200)
    return
  }
  try { await session.disconnect?.() } catch { /* drop it locally either way */ }
  forget()
  session = null
  paint()
})
document.addEventListener('click', (e) => { if (menu && !e.target.closest('.wallet-slot')) menu.hidden = true })
window.addEventListener('wallet-standard:register-wallet', () => setTimeout(paint, 0))

paint()
// Wallets register a beat after the page loads; a refresh should not cost a reconnection.
;(async () => {
  for (let wait = 0; wait < 8 && !available().length; wait++) await new Promise((r) => setTimeout(r, 250))
  session = await reconnect().catch(() => null)
  paint()
})()
