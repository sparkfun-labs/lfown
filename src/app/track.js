// LFOwn — where people drop off, counted without following anyone.
//
// Each step of the launch flow is a named event, counted per day and per kind of
// device (phone or desktop). Nothing identifies a visitor: no cookie, no id, no
// address — only "one more person reached the review today, on a phone". Each event
// is sent at most once per tab, so reloading does not inflate a step.

import { isPhone } from './mobile-wallet.js'

const sent = new Set()
const device = () => (isPhone() ? 'mobile' : 'desktop')

export function track(event) {
  const key = `lfown-ev:${event}`
  if (sent.has(event)) return
  sent.add(event)
  try {
    if (sessionStorage.getItem(key)) return
    sessionStorage.setItem(key, '1')
  } catch { /* storage refused: count it anyway, once for this page */ }
  const body = JSON.stringify({ e: event, d: device() })
  // A beacon survives the page being replaced, which is exactly when "launched" fires.
  if (!navigator.sendBeacon?.('/api/event', new Blob([body], { type: 'application/json' }))) {
    fetch('/api/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {})
  }
}
