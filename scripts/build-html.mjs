// One header for every page.
//
// The three pages drifted into three different navigations because each carried its
// own copy. Now they carry a marker and the header is injected here, so the only way
// to change one is to change all of them.

import { readFileSync, writeFileSync } from 'node:fs'
import { CF_BEACON_TOKEN } from '../src/lib/config.mjs'

const header = readFileSync('src/partials/header.html', 'utf8').trimEnd()
const END = '<!--/lfown-header-->'

/**
 * Cloudflare's analytics beacon, or nothing at all.
 *
 * It rides in the shared header rather than being pasted into five documents, so a
 * page added later is counted without anyone remembering to. `defer` keeps it off
 * the critical path; with no token the line simply does not exist in the output.
 */
const BEACON = CF_BEACON_TOKEN
  ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${CF_BEACON_TOKEN}"}'></script>`
  : ''

/** The right-hand action differs by page; everything left of it does not. */
const WALLET = `<span class="wallet-slot">
        <button class="btn" type="button" id="connect">Connect wallet</button>
        <div class="wallet-menu" id="wallet-menu" hidden>
          <a href="/profile">Profile</a>
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
  // The leaderboard reads a public report and signs nothing, so it ships no wallet
  // code and gets the landing's call to action instead of a button it could not use.
  // A flat file, not a directory: /coins and /launch are worker-routed shells that
  // ask the assets handler for the `/coins/` form, but nothing runs before this page,
  // and a directory would have answered /leaderboard with a 307 to /leaderboard/.
  // The dead end. No wallet, and nothing is current.
  {
    file: 'public/404.html',
    action: '<a class="btn" href="/launch"><span>Launch<span class="hide-s"> Ownership Memes</span></span></a>',
    here: null,
  },
  // A public record, reached from the leaderboard. No wallet, so no wallet button.
  {
    file: 'public/creator/index.html',
    action: '<a class="btn" href="/launch"><span>Launch<span class="hide-s"> Ownership Memes</span></span></a>',
    here: null,
  },
  // Reached from the wallet menu rather than the nav, so nothing is marked current.
  { file: 'public/profile.html', action: WALLET, here: null },
  // The design sheet, like the leaderboard: a flat file, no bundle, no wallet.
  {
    file: 'public/design.html',
    action: '<a class="btn" href="/launch"><span>Launch<span class="hide-s"> Ownership Memes</span></span></a>',
    here: null,
  },
  {
    file: 'public/leaderboard.html',
    action: '<a class="btn" href="/launch"><span>Launch<span class="hide-s"> Ownership Memes</span></span></a>',
    here: '/leaderboard',
  },
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

  let block = header.replace('<!--ACTION-->', action).replace('<!--BEACON-->', BEACON)
  if (here) block = block.replace(`class="mono hide-s" href="${here}"`, `class="mono hide-s" href="${here}" aria-current="page"`)

  writeFileSync(file, html.slice(0, start) + block.trim() + html.slice(end))
  console.log('header →', file)
}
