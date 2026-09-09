// Move whatever the collector is holding to the DAO treasury.
//
// The collector should never hold anything: a claim sends straight to the treasury.
// This exists because an early version of claim-fees.mjs sent to the signer instead
// of the receiver, and because a hot key holding funds is exactly what the split
// between the two accounts was meant to avoid.
//
//   node scripts/forward-fees.mjs                  # show what is stranded
//   LFOWN_ARM=yes node scripts/forward-fees.mjs    # send it on

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import {
  getAssociatedTokenAddress, getAccount, createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction, getMint,
} from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import { FEES } from '../src/lib/config.mjs'

const ARMED = process.env.LFOWN_ARM === 'yes'
const RPC = readFileSync('.dev.vars', 'utf8').match(/https:\/\/[^\s"]+/)[0]
const connection = new Connection(RPC, 'confirmed')

const collector = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  readFileSync(process.env.LFOWN_COLLECTOR_KEYPAIR ?? '.keys/lfown-collector.json', 'utf8'))))
if (collector.publicKey.toBase58() !== FEES.recipient) {
  console.error(`that keypair is ${collector.publicKey.toBase58()}, not the collector ${FEES.recipient}`)
  process.exit(1)
}

const treasury = new PublicKey(FEES.treasury)
console.log(ARMED ? '*** ARMED ***' : 'dry run — set LFOWN_ARM=yes to send')
console.log('from:', collector.publicKey.toBase58())
console.log('to  :', treasury.toBase58(), '\n')

const { value } = await connection.getParsedTokenAccountsByOwner(collector.publicKey, {
  programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
})

let moved = 0
for (const { account } of value) {
  const info = account.data.parsed.info
  const amount = BigInt(info.tokenAmount.amount)
  if (amount === 0n) continue

  const mint = new PublicKey(info.mint)
  console.log(`  ${info.tokenAmount.uiAmountString}  ${info.mint}`)
  if (!ARMED) { moved++; continue }

  const from = await getAssociatedTokenAddress(mint, collector.publicKey, true)
  const to = await getAssociatedTokenAddress(mint, treasury, true)
  const tx = new Transaction()

  // The treasury is a PDA; its token account may not exist yet, and anyone may open it.
  const exists = await getAccount(connection, to).then(() => true).catch(() => false)
  if (!exists) tx.add(createAssociatedTokenAccountInstruction(collector.publicKey, to, treasury, mint))

  const { decimals } = await getMint(connection, mint)
  tx.add(createTransferCheckedInstruction(from, mint, to, collector.publicKey, amount, decimals))
  tx.feePayer = collector.publicKey

  console.log('    sent:', await sendAndConfirmTransaction(connection, tx, [collector], { commitment: 'confirmed' }))
  moved++
}

if (!moved) console.log('  nothing stranded — the collector is empty, which is how it should be.')
