// LFOwn — turning chain errors into sentences.
//
// A failed transaction arrives as a simulation dump: a program id, a hex code, and
// forty lines of logs. The reason is usually in there — "insufficient lamports
// 12097367, need 14654755" — but it is buried between two stack traces, and the
// part shown first is the part that means least.
//
// Everything here reads the dump and answers the only question worth asking: what
// does the person have to do differently. The full text still goes to the console.

const SOL = (lamports) => (Number(lamports) / 1e9).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')

/** Anchor prints a sentence of its own; when it does, that sentence wins. */
function anchorMessage(text) {
  return text.match(/Error Message: ([^".]+)/)?.[1]?.trim() ?? null
}

/**
 * Did the person say no, as opposed to something failing?
 *
 * Worth telling apart when a screen signs several transactions in a row: a network
 * error on one is no reason to stop, and a refusal on one is every reason to.
 */
export function declined(error) {
  const raw = [error?.message ?? String(error ?? ''), (error?.logs ?? []).join(' ')].join(' ')
  return /User rejected|rejected the request|Transaction cancelled/i.test(raw)
}

export function readable(error) {
  // The logs are on the error object in some web3 versions and inlined in the
  // message in others, so both are searched.
  const raw = [error?.message ?? String(error ?? ''), (error?.logs ?? []).join(' ')].join(' ')

  if (declined(error)) return 'You declined the transaction in your wallet.'

  // Meteora's wording for "the curve does not hold that many tokens". A creator
  // reading it thinks the pool is broken; what it means is they asked for more of
  // their own supply than is ever sold on the curve — a fifth of it is reserved for
  // the pool the coin graduates into.
  if (/not enough liquidity/i.test(raw)) {
    return 'That dev buy is larger than the curve holds. Most of the supply is sold on the curve, but a fifth is reserved for the pool your coin graduates into — try a smaller share.'
  }

  const short = raw.match(/insufficient lamports (\d+),?\s*need (\d+)/i)
  if (short) {
    return `Not enough SOL: this needs ${SOL(short[2])} SOL and the wallet holds ${SOL(short[1])}.`
  }

  if (/insufficient funds|InsufficientFunds/i.test(raw) || /Transfer: insufficient/i.test(raw)) {
    return 'The wallet does not hold enough of one of the tokens this transaction spends.'
  }

  // Anchor's own wording for this one is accurate and useless: it says what the
  // program thinks, not what the person should do instead.
  if (/PoolIsCompleted|Pool is completed/i.test(raw)) {
    return 'This coin has graduated — it trades on its Meteora pool now, not on the curve.'
  }

  const anchor = anchorMessage(raw)
  if (anchor) return anchor.charAt(0).toUpperCase() + anchor.slice(1) + '.'

  if (/Blockhash not found|block height exceeded|BlockhashNotFound/i.test(raw)) {
    return 'The transaction expired before it reached the network. Try again.'
  }
  if (/0x1771|SlippageToleranceExceeded|ExceededSlippage/i.test(raw)) {
    return 'The price moved past your slippage while you were signing. Try again.'
  }
  if (/already in use|AccountAlreadyInitialized/i.test(raw)) {
    return 'That account already exists on chain. Reload the page and try again.'
  }
  if (/failed to (send|simulate)|fetch|network|Failed to fetch/i.test(raw) && !/program error/i.test(raw)) {
    return 'Could not reach the network. Check your connection and try again.'
  }

  // bn.js asserts rather than explains when a number is out of range, which is what
  // an amount larger than the curve can price looks like from here.
  if (/Assertion failed|BN\b.*out of range|Number can only safely store/i.test(raw)) {
    return 'That amount is out of range for this pool. Try a smaller one.'
  }

  // Nothing recognised: keep the first sentence, drop the log dump behind it.
  const first = String(error?.message ?? error ?? 'Something went wrong.')
    .split(/\.\s|\bLogs:/)[0]
    .trim()
  return (first || 'Something went wrong.').replace(/\.*$/, '.')
}

/** Says it to the person, keeps the whole thing for whoever opens the console. */
export function explain(error, where) {
  console.error(where ? `${where}:` : 'transaction failed:', error)
  return readable(error)
}
