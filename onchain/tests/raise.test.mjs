// LFOwn raise — the program as compiled, run in LiteSVM.
//
//   anchor build && npm test
//
// LiteSVM executes the real .so in-process, and lets the clock jump to the end of a raise
// instead of waiting for it. Every rule the program enforces is tried from the side that
// should be refused, not only from the side that should pass.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LiteSVM, Clock, FailedTransactionMetadata } from 'litesvm'
import anchor from '@coral-xyz/anchor'
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, TOKEN_PROGRAM_ID, AccountLayout, MintLayout,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createMintToInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'

const IDL = JSON.parse(readFileSync(new URL('../target/idl/lfown_raise.json', import.meta.url), 'utf8'))
const PROGRAM_ID = new PublicKey(IDL.address)
const SO = new URL('../target/deploy/lfown_raise.so', import.meta.url).pathname

// Building instructions needs no network; the connection is never called.
const program = new anchor.Program(IDL, new anchor.AnchorProvider(new Connection('http://127.0.0.1:1'), new anchor.Wallet(Keypair.generate()), {}))

const USDC = (n) => BigInt(Math.round(n * 1e6))
const TOKENS = (n) => BigInt(Math.round(n * 1e6))
const SPEC = { goal: USDC(5_000), tokensForInvestors: TOKENS(10_000_000), tokensForPool: TOKENS(8_000_000), quoteToPool: USDC(4_000) }

function world() {
  const svm = new LiteSVM()
  svm.addProgramFromFile(PROGRAM_ID, SO)
  const payer = Keypair.generate()
  svm.airdrop(payer.publicKey, BigInt(100 * LAMPORTS_PER_SOL))

  const send = (ixs, signers) => {
    const tx = new Transaction().add(...ixs)
    tx.recentBlockhash = svm.latestBlockhash()
    tx.feePayer = signers[0].publicKey
    tx.sign(...signers)
    const res = svm.sendTransaction(tx)
    // Two identical transactions in a row would share a signature and be refused as a
    // duplicate; a fresh blockhash each time keeps every attempt its own.
    svm.expireBlockhash()
    if (res instanceof FailedTransactionMetadata) {
      const logs = res.meta().logs()
      const code = logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean)
      return { ok: false, code, logs }
    }
    return { ok: true, logs: res.logs() }
  }
  const must = (r, what) => { assert.ok(r.ok, `${what} failed: ${r.code ?? ''}\n${r.logs?.join('\n')}`); return r }
  const refused = (r, code, what) => {
    assert.equal(r.ok, false, `${what} should have been refused`)
    if (code) assert.equal(r.code, code, `${what}: expected ${code}, got ${r.code}\n${r.logs?.join('\n')}`)
  }

  const createMint = (authority) => {
    const mint = Keypair.generate()
    must(send([
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, 6, authority, null),
    ], [payer, mint]), 'create mint')
    return mint.publicKey
  }
  const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true)
  const balance = (address) => {
    const account = svm.getAccount(address)
    return account ? AccountLayout.decode(Buffer.from(account.data)).amount : 0n
  }
  const person = (usdcMint, usdc) => {
    const kp = Keypair.generate()
    svm.airdrop(kp.publicKey, BigInt(10 * LAMPORTS_PER_SOL))
    must(send([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(usdcMint, kp.publicKey), kp.publicKey, usdcMint),
      createMintToInstruction(usdcMint, ata(usdcMint, kp.publicKey), payer.publicKey, usdc),
    ], [payer]), 'fund backer')
    return kp
  }
  const now = () => svm.getClock().unixTimestamp
  const warp = (seconds) => {
    const c = svm.getClock()
    svm.setClock(new Clock(c.slot + 1000n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(seconds)))
  }
  const decode = (name, address) => program.coder.accounts.decode(name, Buffer.from(svm.getAccount(address).data))

  return { svm, payer, send, must, refused, createMint, ata, balance, person, now, warp, decode }
}

/** A raise opened on fresh mints, with its addresses and one call per instruction. */
function openRaise(w, { duration = 3600, claimDelay = 86_400, spec = SPEC, mintAuthority } = {}) {
  const usdcMint = w.createMint(w.payer.publicKey)
  const baseMintKp = Keypair.generate()
  const [raise] = PublicKey.findProgramAddressSync([Buffer.from('raise'), baseMintKp.publicKey.toBuffer()], PROGRAM_ID)
  // The mint is created with the raise as its authority, which is only possible because the
  // raise's address is derived from the mint's.
  w.must(w.send([
    SystemProgram.createAccount({ fromPubkey: w.payer.publicKey, newAccountPubkey: baseMintKp.publicKey, lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(baseMintKp.publicKey, 6, mintAuthority ?? raise, null),
  ], [w.payer, baseMintKp]), 'create base mint')
  const baseMint = baseMintKp.publicKey
  const treasury = Keypair.generate().publicKey
  const operator = Keypair.generate()
  w.svm.airdrop(operator.publicKey, BigInt(LAMPORTS_PER_SOL))

  const bn = (v) => new anchor.BN(v.toString())
  const init = () => w.send([program.instruction.initializeRaise({
    goal: bn(spec.goal), tokensForInvestors: bn(spec.tokensForInvestors), tokensForPool: bn(spec.tokensForPool),
    quoteToPool: bn(spec.quoteToPool), durationSeconds: bn(duration), claimDelaySeconds: bn(claimDelay),
    daoCommitment: Array(32).fill(0),
  }, { accounts: {
    baseMint, quoteMint: usdcMint, raise, baseVault: w.ata(baseMint, raise), quoteVault: w.ata(usdcMint, raise),
    treasury, poolOperator: operator.publicKey, authority: w.payer.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  } })], [w.payer])

  const commitment = (user) => PublicKey.findProgramAddressSync([Buffer.from('commitment'), raise.toBuffer(), user.toBuffer()], PROGRAM_ID)[0]
  const commit = (user, amount) => w.send([program.instruction.commit(bn(amount), { accounts: {
    raise, commitment: commitment(user.publicKey), userQuote: w.ata(usdcMint, user.publicKey), quoteVault: w.ata(usdcMint, raise),
    user: user.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  } })], [user])
  const settle = (cranker = w.payer) => w.send([program.instruction.settle({ accounts: {
    raise, baseMint, quoteMint: usdcMint, baseVault: w.ata(baseMint, raise), quoteVault: w.ata(usdcMint, raise),
    treasury, treasuryQuote: w.ata(usdcMint, treasury), poolOperator: operator.publicKey,
    operatorQuote: w.ata(usdcMint, operator.publicKey), operatorBase: w.ata(baseMint, operator.publicKey),
    cranker: cranker.publicKey, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  } })], [cranker])
  const openClaims = (signer = operator) => w.send([program.instruction.openClaims({ accounts: { raise, poolOperator: signer.publicKey } })], [signer])
  // `owner` names whose commitment is claimed; `signer` is who actually signs. They differ
  // only in the test that tries to claim someone else's.
  const claim = (signer, owner = signer.publicKey) => w.send([program.instruction.claim({ accounts: {
    raise, commitment: commitment(owner), baseMint, quoteMint: usdcMint,
    baseVault: w.ata(baseMint, raise), quoteVault: w.ata(usdcMint, raise),
    userBase: w.ata(baseMint, signer.publicKey), userQuote: w.ata(usdcMint, signer.publicKey),
    user: signer.publicKey, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  } })], [signer])
  const refund = (user) => w.send([program.instruction.refund({ accounts: {
    raise, commitment: commitment(user.publicKey), quoteMint: usdcMint, quoteVault: w.ata(usdcMint, raise),
    userQuote: w.ata(usdcMint, user.publicKey), user: user.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  } })], [user])

  return { usdcMint, baseMint, raise, treasury, operator, init, commit, settle, openClaims, claim, refund }
}

test('an oversubscribed raise keeps exactly the goal, pays the pool and treasury, and refunds pro rata', () => {
  const w = world()
  const r = openRaise(w)
  w.must(r.init(), 'initialize')

  const mint = () => MintLayout.decode(Buffer.from(w.svm.getAccount(r.baseMint).data))
  assert.equal(mint().supply, SPEC.tokensForInvestors + SPEC.tokensForPool, 'the launch supply is minted up front')
  assert.equal(new PublicKey(mint().mintAuthority).toBase58(), r.raise.toBase58(), 'the raise holds the mint authority while it runs')

  const alice = w.person(r.usdcMint, USDC(6_000))
  const bob = w.person(r.usdcMint, USDC(3_000))
  const carol = w.person(r.usdcMint, USDC(1_000))
  w.must(r.commit(alice, USDC(4_000)), 'alice commits')
  w.must(r.commit(alice, USDC(2_000)), 'alice commits again')
  w.must(r.commit(bob, USDC(3_000)), 'bob commits')
  w.must(r.commit(carol, USDC(1_000)), 'carol commits')
  assert.equal(w.balance(w.ata(r.usdcMint, r.raise)), USDC(10_000))

  w.refused(r.settle(), 'NotEnded', 'settling before the end')
  w.warp(3601)
  w.refused(r.commit(carol, 1n), 'Ended', 'committing after the end')

  w.must(r.settle(), 'settle')
  assert.equal(w.balance(w.ata(r.usdcMint, r.treasury)), USDC(1_000), 'treasury gets 1,000 USDC')
  assert.equal(w.balance(w.ata(r.usdcMint, r.operator.publicKey)), USDC(4_000), 'pool operator gets 4,000 USDC')
  assert.equal(w.balance(w.ata(r.baseMint, r.operator.publicKey)), TOKENS(8_000_000), 'and 8M tokens')
  assert.equal(mint().mintAuthorityOption, 1, 'the token stays mintable')
  assert.equal(new PublicKey(mint().mintAuthority).toBase58(), r.operator.publicKey.toBase58(), 'with the authority handed to the operator, for the DAO')
  w.refused(r.settle(), 'NotLive', 'settling twice')

  w.refused(r.claim(alice), 'ClaimsNotOpen', 'claiming before the pool exists')
  w.refused(r.openClaims(alice), 'NotOperator', 'opening claims as someone else')
  w.must(r.openClaims(), 'operator opens claims')

  const expected = [[alice, 6_000_000, 3_000], [bob, 3_000_000, 1_500], [carol, 1_000_000, 500]]
  for (const [who, tokens, refund] of expected) {
    const before = w.balance(w.ata(r.usdcMint, who.publicKey))
    w.must(r.claim(who), 'claim')
    assert.equal(w.balance(w.ata(r.baseMint, who.publicKey)), TOKENS(tokens))
    assert.equal(w.balance(w.ata(r.usdcMint, who.publicKey)) - before, USDC(refund))
  }
  w.refused(r.claim(alice), 'AlreadySettled', 'claiming twice')
  assert.equal(w.balance(w.ata(r.baseMint, r.raise)), 0n, 'every token paid out')
  assert.equal(w.balance(w.ata(r.usdcMint, r.raise)), 0n, 'every USDC paid out')
})

test('a raise below its goal fails and gives everyone their whole commitment back', () => {
  const w = world()
  const r = openRaise(w)
  w.must(r.init(), 'initialize')
  const alice = w.person(r.usdcMint, USDC(4_000))
  w.must(r.commit(alice, USDC(4_000)), 'commit')
  w.warp(3601)
  w.must(r.settle(), 'settle')
  assert.equal(w.decode('raise', r.raise).state.failed !== undefined, true, 'the raise is failed')
  assert.equal(w.balance(w.ata(r.usdcMint, r.treasury)), 0n, 'the treasury is paid nothing')
  const authority = new PublicKey(MintLayout.decode(Buffer.from(w.svm.getAccount(r.baseMint).data)).mintAuthority)
  assert.equal(authority.toBase58(), r.raise.toBase58(), 'a failed raise keeps the authority, so nobody can mint it')

  w.refused(r.claim(alice), 'NotSucceeded', 'claiming tokens from a failed raise')
  w.must(r.refund(alice), 'refund')
  assert.equal(w.balance(w.ata(r.usdcMint, alice.publicKey)), USDC(4_000))
  w.refused(r.refund(alice), 'AlreadySettled', 'refunding twice')
})

test('at exactly the goal nothing is refunded, and claims open on their own after the delay', () => {
  const w = world()
  const r = openRaise(w, { claimDelay: 600 })
  w.must(r.init(), 'initialize')
  const alice = w.person(r.usdcMint, USDC(2_000))
  const bob = w.person(r.usdcMint, USDC(3_000))
  w.must(r.commit(alice, USDC(2_000)), 'alice')
  w.must(r.commit(bob, USDC(3_000)), 'bob')
  w.warp(3601)
  w.must(r.settle(), 'settle')

  w.refused(r.claim(bob), 'ClaimsNotOpen', 'claiming before the delay with no operator confirmation')
  w.warp(601)
  w.must(r.claim(bob), 'claim after the delay')
  assert.equal(w.balance(w.ata(r.baseMint, bob.publicKey)), TOKENS(6_000_000))
  assert.equal(w.balance(w.ata(r.usdcMint, bob.publicKey)), 0n, 'nothing to refund at exactly the goal')
  w.refused(r.refund(alice), 'NotFailed', 'refunding from a raise that succeeded')
})

test("nobody can claim someone else's commitment", () => {
  const w = world()
  const r = openRaise(w, { claimDelay: 0 })
  w.must(r.init(), 'initialize')
  const alice = w.person(r.usdcMint, USDC(5_000))
  const mallory = w.person(r.usdcMint, 0n)
  w.must(r.commit(alice, USDC(5_000)), 'alice')
  w.warp(3601)
  w.must(r.settle(), 'settle')
  // The commitment address is derived from the signer, so pointing at Alice's fails the seeds.
  w.refused(r.claim(mallory, alice.publicKey), null, "mallory claiming alice's commitment")
  assert.equal(w.balance(w.ata(r.baseMint, mallory.publicKey)), 0n)
  w.must(r.claim(alice), 'alice still claims')
})

test('a mint the raise does not control is refused', () => {
  const w = world()
  const r = openRaise(w, { mintAuthority: Keypair.generate().publicKey })
  w.refused(r.init(), 'InvalidMint', 'opening a raise on a mint someone else can still mint')
})
