# Security

## Reporting a vulnerability

Please report privately rather than in a public issue. A launchpad's users sign
transactions built by this code, and a bug in the open is a bug someone can use
while it is being fixed.

- On GitHub, use **Security → Report a vulnerability** on this repository, if the
  tab is enabled.
- Otherwise, a direct message to [@LFOWNDOTFUN](https://x.com/LFOWNDOTFUN) on X.

Say what you found, how to reproduce it, and what you think it lets someone do.
You will get an answer within a few days, and credit in the fix if you want it.

## What is in scope

- The Worker (`src/worker.mjs`, `src/lib/`): the API, the crons, the keeper that
  graduates pools and sweeps fees.
- The browser app (`src/app/`): anything that changes what a wallet is asked to
  sign, or that lets chain data — token names, symbols, image links — run as code
  on this origin.
- The operator scripts (`scripts/`), where they would spend more than they say.

Denial-of-service findings against the public API are welcome but low priority
past what the rate limits already state.

## How fixes ship

The site is deployed from a working tree, not from the repository: a fix is
deployed first and the commit that reveals it is pushed afterwards, so the window
between "published" and "patched" is zero rather than the time a deploy takes.

## Known limits

These are documented rather than hidden. The README's *Security* section has the
detail.

- The fee claimer key is hot: it lives in the Worker so the hourly sweep can sign.
  What it can and cannot reach is spelled out in the README.
- Cross-origin checks on the POST routes are a speed bump. Per-address rate limits
  in the Worker and a WAF rule on the zone are the controls.
- `npm audit` lists transitive advisories under the Solana and Meteora SDKs that
  cannot be fixed here; the README lists which of them reach the browser.
