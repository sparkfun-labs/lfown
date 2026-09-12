// LFOwn — where the DAO's share ends up, for anyone who wants to check.
//
// The address is read from the shared config rather than written down again: it is
// the account every fee claim pays into, and a second copy that drifted would send
// people to look at the wrong wallet while the figure beside it stayed right.

import { FEES } from '../lib/config.mjs'

/** The treasury on Solscan, opened on the portfolio tab — what it is holding. */
export const TREASURY = `https://solscan.io/account/${FEES.treasury}#portfolio`
