// One header for every page.
//
// The three pages drifted into three different navigations because each carried its
// own copy. Now they carry a marker and the header is injected here, so the only way
// to change one is to change all of them.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
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

/**
 * Every page carries the same two actions: the way to launch and the wallet. The
 * launch button drops below the breakpoint, where the burger's drawer has it and the
 * bar has room for one button only.
 */
const ACTIONS = `<a class="btn hide-s launch-cta" href="/launch"><span>Launch Ownership Memes</span></a>
      ${WALLET}`

/**
 * `wallet: 'own'` pages ship a bundle that drives the wallet button itself; every other
 * page gets the small shared one, so Connect wallet works everywhere.
 */
const pages = [
  { file: 'public/index.html', here: null, wallet: 'own' },
  { file: 'public/launch/index.html', here: '/launch', wallet: 'own' },
  { file: 'public/profile.html', here: null, wallet: 'own' },
  { file: 'public/lfown.html', here: '/lfown', wallet: 'header' },
  { file: 'public/rewards.html', here: '/rewards', wallet: 'header' },
  // Flat files, not directories: nothing runs before them, and a directory would have
  // answered /leaderboard with a 307 to /leaderboard/.
  { file: 'public/leaderboard.html', here: '/leaderboard', wallet: 'header' },
  { file: 'public/creator/index.html', here: null, wallet: 'header' },
  { file: 'public/404.html', here: null, wallet: 'header' },
  { file: 'public/design.html', here: null, wallet: 'header' },
  // The first landing, kept as a model and linked from nowhere.
  { file: 'public/classic/index.html', here: null, wallet: 'header' },
].filter((p) => existsSync(p.file))

for (const { file, here, wallet } of pages) {
  const html = readFileSync(file, 'utf8')
  const start = html.indexOf('<header class="top">')
  // The block now runs past </header> — the drawer has to sit outside it — so it
  // ends at its own marker. Falling back to </header> is what lets a page that has
  // never been built pick the block up the first time.
  const marked = html.indexOf(END)
  const end = marked === -1 ? html.indexOf('</header>') + '</header>'.length : marked + END.length
  if (start === -1 || end < start) throw new Error(`no header to replace in ${file}`)

  let block = header.replace('<!--ACTION-->', ACTIONS).replace('<!--BEACON-->', BEACON)
    .replace('<!--WALLET_SCRIPT-->', wallet === 'header' ? '<script type="module" src="/app/header-wallet.js"></script>' : '')
  if (here) block = block.replace(`class="mono hide-s" href="${here}"`, `class="mono hide-s" href="${here}" aria-current="page"`)

  writeFileSync(file, html.slice(0, start) + block.trim() + html.slice(end))
  console.log('header →', file)
}
