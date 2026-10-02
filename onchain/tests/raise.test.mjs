// LFOwn raise — the program as compiled, run in LiteSVM.
//
//   anchor build && npm test
//
// LiteSVM executes the real .so in-process, and lets the clock jump to the end of a raise
// instead of waiting for it. Every rule the program enforces is tried from the side that
// should be refused, not only from the side that should pass.
//
// A raise that meets its goal succeeds only by becoming its DAO (futarchy's bootstrap_dao
// settles it): that path, and the claims after it, are in futarchy.test.mjs. Here is
// everything the raise decides on its own.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LiteSVM, Clock, FailedTransactionMetadata } from 'litesvm'
import anchor from '@coral-xyz/anchor'
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, TOKEN_PROGRAM_ID, AccountLayout, MintLayout,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createMintToInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'

const IDL = JSON.parse(readFileSync(new URL('../target/idl/lfown_raise.json', import.meta.url), 'utf8'))
const PROGRAM_ID = new PublicKey(IDL.address)
// A raise pays only the DAO its mint derives in the futarchy program.
const FUTARCHY_ID = new PublicKey(JSON.parse(readFileSync(new URL('../target/idl/futarchy.json', import.meta.url), 'utf8')).address)
const futarchyPda = (...seeds) => PublicKey.findProgramAddressSync(seeds.map((x) => (typeof x === 'string' ? Buffer.from(x) : x.toBuffer())), FUTARCHY_ID)[0]
const daoOf = (mint) => { const dao = futarchyPda('dao', mint); return { dao, treasury: futarchyPda('treasury', dao), operator: futarchyPda('liquidity', dao) } }
const SO = new URL('../target/deploy/lfown_raise.so', import.meta.url).pathname
const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const metadataOf = (mint) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM)[0]

// Building instructions needs no network; the connection is never called.
const program = new anchor.Program(IDL, new anchor.AnchorProvider(new Connection('http://127.0.0.1:1'), new anchor.Wallet(Keypair.generate()), {}))

const USDC = (n) => BigInt(Math.round(n * 1e6))
const TOKENS = (n) => BigInt(Math.round(n * 1e6))
const SPEC = { goal: USDC(5_000), tokensForInvestors: TOKENS(10_000_000), tokensForPool: TOKENS(8_000_000), quoteToPool: USDC(4_000) }

function world() {
  const svm = new LiteSVM()
  svm.addProgramFromFile(PROGRAM_ID, SO)
  svm.addProgramFromFile(METADATA_PROGRAM, new URL('fixtures/mpl_token_metadata.so', import.meta.url).pathname)
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

  const createMint = (authority, freezeAuthority = null) => {
    const mint = Keypair.generate()
    must(send([
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, 6, authority, freezeAuthority),
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
function openRaise(w, { duration = 3600, claimDelay = 86_400, spec = SPEC, recipients, mintSigns = true, freezableCoin = false, premade } = {}) {
  const usdcMint = w.createMint(w.payer.publicKey, freezableCoin ? w.payer.publicKey : null)
  const baseMintKp = Keypair.generate()
  const [raise] = PublicKey.findProgramAddressSync([Buffer.from('raise'), baseMintKp.publicKey.toBuffer()], PROGRAM_ID)
  // The raise creates its token itself. `premade`: an attacker's mint made beforehand at the
  // same address, with whatever authorities they liked.
  if (premade) {
    w.must(w.send([
      SystemProgram.createAccount({ fromPubkey: w.payer.publicKey, newAccountPubkey: baseMintKp.publicKey, lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(baseMintKp.publicKey, 6, raise, w.payer.publicKey),
    ], [w.payer, baseMintKp]), 'an attacker makes the mint first')
  }
  const baseMint = baseMintKp.publicKey
  const { treasury, operator } = recipients ?? daoOf(baseMint)

  const bn = (v) => new anchor.BN(v.toString())
  const initIx = (over = {}) => program.instruction.initializeRaise({
    goal: bn(spec.goal), tokensForInvestors: bn(spec.tokensForInvestors), tokensForPool: bn(spec.tokensForPool),
    quoteToPool: bn(spec.quoteToPool), durationSeconds: bn(duration), claimDelaySeconds: bn(claimDelay),
    daoCommitment: Array(32).fill(0), name: 'Fair Coin', symbol: 'FAIR', uri: 'https://letsfuckingown.fun/i/fair.json', ...over,
  }, { accounts: {
    baseMint, quoteMint: usdcMint, raise, baseVault: w.ata(baseMint, raise), quoteVault: w.ata(usdcMint, raise),
    treasury, poolOperator: operator, metadata: metadataOf(baseMint), updateAuthority: futarchyPda('mint_authority', daoOf(baseMint).dao),
    authority: w.payer.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    tokenMetadataProgram: METADATA_PROGRAM, rent: SYSVAR_RENT_PUBKEY,
  } })
  // The new mint signs its own raise: that is what keeps anyone else from opening one on it.
  const init = (over) => {
    const ix = initIx(over)
    // An intruder's transaction: the mint listed as a plain account, not as a signer.
    if (!mintSigns) ix.keys = ix.keys.map((k) => (k.pubkey.equals(baseMintKp.publicKey) ? { ...k, isSigner: false } : k))
    return w.send([ix], mintSigns ? [w.payer, baseMintKp] : [w.payer])
  }

  const commitment = (user) => PublicKey.findProgramAddressSync([Buffer.from('commitment'), raise.toBuffer(), user.toBuffer()], PROGRAM_ID)[0]
  const commit = (user, amount) => w.send([program.instruction.commit(bn(amount), { accounts: {
    raise, commitment: commitment(user.publicKey), userQuote: w.ata(usdcMint, user.publicKey), quoteVault: w.ata(usdcMint, raise),
    user: user.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  } })], [user])
  const settle = (cranker = w.payer) => w.send([program.instruction.settle({ accounts: {
    raise, baseMint, quoteMint: usdcMint, baseVault: w.ata(baseMint, raise), quoteVault: w.ata(usdcMint, raise),
    treasury, treasuryQuote: w.ata(usdcMint, treasury), poolOperator: operator,
    operatorQuote: w.ata(usdcMint, operator), operatorBase: w.ata(baseMint, operator),
    cranker: cranker.publicKey, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  } })], [cranker])
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

  return { usdcMint, baseMint, raise, treasury, operator, init, commit, settle, claim, refund }
}

test('a raise below its goal fails and gives everyone their whole commitment back', () => {
  const w = world()
  const r = openRaise(w)
  w.must(r.init(), 'initialize')
  const mint = () => MintLayout.decode(Buffer.from(w.svm.getAccount(r.baseMint).data))
  assert.equal(mint().supply, SPEC.tokensForInvestors + SPEC.tokensForPool, 'the launch supply is minted up front')
  const alice = w.person(r.usdcMint, USDC(4_000))
  w.must(r.commit(alice, USDC(4_000)), 'commit')
  w.refused(r.settle(), 'NotEnded', 'settling before the end')
  w.warp(3601)
  w.refused(r.commit(alice, 1n), 'Ended', 'committing after the end')
  w.must(r.settle(), 'anyone settles a raise that missed its goal')
  assert.equal(w.decode('raise', r.raise).state.failed !== undefined, true, 'the raise is failed')
  assert.equal(w.balance(w.ata(r.usdcMint, r.treasury)), 0n, 'the treasury is paid nothing')
  assert.equal(new PublicKey(mint().mintAuthority).toBase58(), r.raise.toBase58(), 'a failed raise keeps the authority, so nobody can mint it')

  w.refused(r.claim(alice), 'NotSucceeded', 'claiming tokens from a failed raise')
  w.must(r.refund(alice), 'refund')
  assert.equal(w.balance(w.ata(r.usdcMint, alice.publicKey)), USDC(4_000))
  w.refused(r.refund(alice), 'AlreadySettled', 'refunding twice')
})

test('a raise that met its goal succeeds only through its DAO, and without one by its deadline it fails', () => {
  const w = world()
  const r = openRaise(w, { claimDelay: 600 })
  w.must(r.init(), 'initialize')
  const alice = w.person(r.usdcMint, USDC(3_000))
  const bob = w.person(r.usdcMint, USDC(3_000))
  w.must(r.commit(alice, USDC(3_000)), 'alice')
  w.must(r.commit(bob, USDC(3_000)), 'bob')
  w.warp(3601)
  // Success pays the DAO's accounts and opens claims: only the DAO's liquidity authority
  // may do that, and it signs only inside bootstrap_dao, which opens the pool at once.
  w.refused(r.settle(), 'NotOperator', 'settling a successful raise without its DAO')
  w.refused(r.claim(alice), 'NotSucceeded', 'claiming before the DAO exists')
  // Nobody opened the DAO in time: the raise fails like one that missed its goal.
  w.warp(600)
  w.must(r.settle(), 'past the deadline, anyone settles it as failed')
  assert.equal(w.decode('raise', r.raise).state.failed !== undefined, true, 'the raise is failed')
  w.must(r.refund(alice), 'alice gets everything back')
  w.must(r.refund(bob), 'bob too')
  assert.equal(w.balance(w.ata(r.usdcMint, alice.publicKey)), USDC(3_000))
  assert.equal(w.balance(w.ata(r.usdcMint, bob.publicKey)), USDC(3_000))
  assert.equal(w.balance(w.ata(r.usdcMint, r.raise)), 0n, 'nothing is left in the vault')
})

test('only the new mint opens a raise on itself, and only for the DAO it derives', () => {
  const w = world()
  // The raise creates the mint, which takes the mint keypair's signature.
  const r = openRaise(w, { mintSigns: false })
  w.refused(r.init(), null, 'opening a raise on a mint without its signature')
  const intruder = Keypair.generate().publicKey
  const s = openRaise(w, { recipients: { treasury: intruder, operator: daoOf(PublicKey.default).operator } })
  w.refused(s.init(), 'NotTheDao', 'a raise paying someone other than its DAO')
})

test("a raise's terms are checked: the pool opens at the backers' price, and its windows are bounded", () => {
  const w = world()
  const cases = [
    [{ quoteToPool: new anchor.BN(USDC(3_000).toString()) }, 'PoolPriceMismatch', 'a pool share that opens the pool below the backers’ price'],
    [{ quoteToPool: new anchor.BN(SPEC.goal.toString()) }, 'InvalidParams', 'a raise that leaves the treasury nothing'],
    [{ claimDelaySeconds: new anchor.BN(0) }, 'InvalidParams', 'a deadline of zero'],
    [{ claimDelaySeconds: new anchor.BN(365 * 86_400) }, 'InvalidParams', 'a deadline of a year'],
    [{ durationSeconds: new anchor.BN(365 * 86_400) }, 'InvalidParams', 'a raise lasting a year'],
  ]
  for (const [over, code, what] of cases) w.refused(openRaise(w).init(over), code, what)
  w.must(openRaise(w).init(), 'the standard terms pass')
})

test('the raise creates its token: no freeze authority ever, no account of it before the raise, metadata under the DAO', () => {
  const w = world()
  // 4th audit H2: a mint made beforehand with a freeze authority could have the DAO's
  // future accounts frozen, the authority revoked, and pass as clean. Now no mint may exist.
  w.refused(openRaise(w, { premade: true }).init(), null, 'a raise on a mint someone made beforehand')
  const r = openRaise(w)
  w.must(r.init(), 'the raise opens and creates its token')
  const mint = MintLayout.decode(Buffer.from(w.svm.getAccount(r.baseMint).data))
  assert.equal(mint.freezeAuthorityOption, 0, 'no freeze authority')
  assert.equal(new PublicKey(mint.mintAuthority).toBase58(), r.raise.toBase58(), 'the raise mints it')
  const meta = Buffer.from(w.svm.getAccount(metadataOf(r.baseMint)).data)
  assert.equal(new PublicKey(meta.subarray(1, 33)).toBase58(), futarchyPda('mint_authority', daoOf(r.baseMint).dao).toBase58(), 'the DAO’s mint authority updates its metadata')
  assert.ok(meta.includes(Buffer.from('Fair Coin')), 'named by the raise')
  w.refused(openRaise(w).init({ name: 'x'.repeat(33) }), 'InvalidParams', 'a name longer than Metaplex allows')
})

test('a coin someone could freeze is refused', () => {
  const w = world()
  // Nor a coin someone could freeze the raise's vault in.
  w.refused(openRaise(w, { freezableCoin: true }).init(), 'InvalidMint', 'a raise priced in a freezable coin')
})
