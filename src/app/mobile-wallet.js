// LFOwn — getting a phone into a wallet.
//
// A phone's own browser has no Solana wallet in it: Safari and Chrome on iOS and
// Android never do. Half the visitors arrive that way, from a link on X, and used to
// meet a greyed-out "No wallet found" and nothing else. Every major wallet app ships
// its own browser and a link that opens a page inside it, so the way on is one tap —
// provided somebody offers it.

/** A phone or tablet, as opposed to a desktop browser that merely has no extension. */
export function isPhone() {
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  return touch && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

/** The same page, opened inside each wallet's in-app browser. */
export function walletLinks(url = location.href) {
  const page = encodeURIComponent(url)
  const ref = encodeURIComponent(location.origin)
  return [
    { name: 'Phantom', href: `https://phantom.app/ul/browse/${page}?ref=${ref}` },
    { name: 'Solflare', href: `https://solflare.com/ul/v1/browse/${page}?ref=${ref}` },
    { name: 'Backpack', href: `https://backpack.app/ul/v1/browse/${page}?ref=${ref}` },
  ]
}

/**
 * Fills `box` with the way into a wallet, when this is a phone with none. Wallets
 * register a beat after the page loads, so it waits for them before deciding; inside a
 * wallet's own browser one always turns up and the box stays empty. `url` is read at
 * the moment of the tap, so a page that has moved on (a coin picked) is the one opened.
 */
export function offerWalletApps(box, { available, url = () => location.href, onShow, onOpen } = {}) {
  if (!box || !isPhone()) return
  setTimeout(() => {
    if (available().length) return
    box.innerHTML = `<p><b>Launching from your phone?</b> Your browser has no wallet in it.
      Open this page in your wallet app:</p>
      <div class="wallet-apps">${walletLinks().map((w) =>
        `<a href="#" data-wallet="${w.name}">${w.name}</a>`).join('')}</div>`
    box.querySelectorAll('a[data-wallet]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault()
      const target = walletLinks(url()).find((w) => w.name === a.dataset.wallet)
      onOpen?.(a.dataset.wallet)
      location.href = target.href
    }))
    box.hidden = false
    onShow?.()
  }, 1500)
}
