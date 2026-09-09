// One header for every page.
//
// The three pages drifted into three different navigations because each carried its
// own copy. Now they carry a marker and the header is injected here, so the only way
// to change one is to change all of them.

import { readFileSync, writeFileSync } from 'node:fs'

const header = readFileSync('src/partials/header.html', 'utf8').trimEnd()
const END = '<!--/lfown-header-->'

/** The right-hand action differs by page; everything left of it does not. */
const WALLET = `<span class="wallet-slot">
        <button class="btn" type="button" id="connect">Connect wallet</button>
        <div class="wallet-menu" id="wallet-menu" hidden>
          <div class="wallet-addr" id="wallet-addr"></div>
          <button type="button" data-act="copy">Copy address</button>
          <button type="button" data-act="disconnect">Disconnect</button>
        </div>
      </span>`

const pages = [
  // The landing ships no JavaScript bundle, so it gets a call to action rather
  // than a wallet button it could not connect.
  // The landing is not one of the sections the nav lists, so nothing is marked current.
  // The label sheds its tail below the breakpoint, where the bar also has to hold
  // the burger. One span so the two halves stay a single flex item — as siblings the
  // button's own gap would open between the word and the rest of the sentence.
  {
    file: 'public/index.html',
    action: '<a class="btn" href="/launch"><span>Launch<span class="hide-s"> Ownership Memes</span></span></a>',
    here: null,
  },
  { file: 'public/launch/index.html', action: WALLET, here: '/launch' },
  { file: 'public/coins/index.html', action: WALLET, here: '/coins' },
]

for (const { file, action, here } of pages) {
  const html = readFileSync(file, 'utf8')
  const start = html.indexOf('<header class="top">')
  // The block now runs past </header> — the drawer has to sit outside it — so it
  // ends at its own marker. Falling back to </header> is what lets a page that has
  // never been built pick the block up the first time.
  const marked = html.indexOf(END)
  const end = marked === -1 ? html.indexOf('</header>') + '</header>'.length : marked + END.length
  if (start === -1 || end < start) throw new Error(`no header to replace in ${file}`)

  let block = header.replace('<!--ACTION-->', action)
  if (here) block = block.replace(`class="mono hide-s" href="${here}"`, `class="mono hide-s" href="${here}" aria-current="page"`)

  writeFileSync(file, html.slice(0, start) + block.trim() + html.slice(end))
  console.log('header →', file)
}
