// LFOwn — sending a transaction from a Cloudflare Worker.
//
// web3's sendAndConfirmTransaction confirms over a websocket subscription, and a
// Worker has no socket for it to open: rpc-websockets reaches for `window` and
// throws `window is not defined`. The transaction has already been sent by then, so
// the caller reports a failure for something that actually landed — money moves and
// the log says nothing happened.
//
// Polling behaves the same in the Worker and in the scripts, so both use this.

/**
 * Signs, sends, and waits for the signature to land.
 * `transaction.feePayer` is left alone when the caller has set one.
 */
export async function sendAndConfirm(connection, transaction, signers, { timeoutMs = 90_000 } = {}) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  transaction.recentBlockhash = blockhash
  if (!transaction.feePayer) transaction.feePayer = signers[0].publicKey
  transaction.sign(...signers)

  const signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: 'confirmed' })
  await waitFor(connection, signature, lastValidBlockHeight, { timeoutMs })
  return signature
}

/** Polls until the signature confirms, its blockhash expires, or time runs out. */
export async function waitFor(connection, signature, lastValidBlockHeight, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature])
    const status = value?.[0]
    if (status?.err) throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return
    if (lastValidBlockHeight && (await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) {
      throw new Error(`transaction ${signature} expired before it confirmed`)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`transaction ${signature} did not confirm in time`)
}
