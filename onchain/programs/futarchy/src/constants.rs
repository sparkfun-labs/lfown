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

/// Meteora DAMM v2's pool authority, the same on every network.
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
