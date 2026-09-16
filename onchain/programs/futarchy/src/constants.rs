use anchor_lang::prelude::*;

// LFOwn fork: upstream's protocol multisig keys are gone. The DAO's treasury and its
// mint authority are program-derived addresses, and nothing but a winning proposal
// moves them (see `execute_action.rs`).

// Maximum number of conditional options
// Bottle-necked by launch_proposal (64 account max)
#[constant]
pub const MAX_OPTIONS: u8 = 6;

// Minimum number of conditional options required
#[constant]
pub const MIN_OPTIONS: u8 = 2;

/// Actions one option can carry. Kept small: every action is something a trader has to
/// read and price before the market opens.
#[constant]
pub const MAX_ACTIONS: u8 = 4;

/// Where LFOwn's half of a DAO's pool fees goes: the same key the amm pays its trading
/// fees to, so there is one protocol wallet per network to configure, not two.
pub const PROTOCOL_FEE_RECIPIENT: Pubkey = amm::FEE_AUTHORITY;

/// LFOwn's share of the fees a DAO's pool position earns, in basis points. The rest goes
/// to the DAO's treasury.
#[constant]
pub const PROTOCOL_FEE_SHARE_BPS: u16 = 5_000;

/// The most of a position's liquidity one proposal may take into its markets. Never all
/// of it: the pool keeps trading while a proposal runs.
#[constant]
pub const MAX_WITHDRAWAL_BPS: u16 = 9_900;

/// DAMM v2's full price range, as square roots in Q64.64. A DAO's pool spans all of it.
pub const DAMM_MIN_SQRT_PRICE: u128 = 4_295_048_016;
pub const DAMM_MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;

/// The base fee a bootstrapped pool charges: a flat 1%, encoded in DAMM v2's 27-byte base
/// fee layout (a fee-time scheduler whose start and end fee are equal — the numerator
/// 10,000,000 over 10^9, then zeros).
pub const POOL_BASE_FEE_DATA: [u8; 27] = [128, 150, 152, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/// Lamports the bootstrap moves to the liquidity authority to pay for the pool's accounts,
/// which DAMM v2 creates with the authority as payer. What is not spent stays with it.
pub const POOL_CREATION_LAMPORTS: u64 = 50_000_000;

/// Meteora DAMM v2's pool authority, the same on every network.
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
