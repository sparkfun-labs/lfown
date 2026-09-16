// Derived from zcombinatorio/programs (AGPL-3.0). LFOwn fork: see programs/COMBINATOR-FORK.md.
use anchor_lang::prelude::*;

pub const DAO_VERSION: u8 = 1;

#[constant]
pub const DAO_SEED: &[u8] = b"dao";

/// Seeds: [TREASURY_SEED, dao]. Owns the DAO's token accounts.
#[constant]
pub const TREASURY_SEED: &[u8] = b"treasury";

/// Seeds: [MINT_AUTHORITY_SEED, dao]. The DAO token's mint authority.
#[constant]
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";

/// Seeds: [LIQUIDITY_SEED, dao]. Owns the DAO's DAMM v2 position and every token on its
/// way between that pool and a proposal's markets.
#[constant]
pub const LIQUIDITY_SEED: &[u8] = b"liquidity";

#[derive(Copy, Clone, InitSpace, AnchorSerialize, AnchorDeserialize, PartialEq, Eq, Debug)]
pub enum PoolType {
    DAMM,
    DLMM,
}

/// One DAO per token, governed by futarchy over its liquidity pool.
///
/// Upstream kept the treasury and the mint authority in Squads multisigs whose members
/// were the protocol's own keys, and ran a passing proposal's outcome by hand. Here both
/// are PDAs of this program: the only instructions that sign for them are
/// `execute_transfer` and `execute_mint`, and those only run an action attached to the
/// option that won.
///
/// Seeds: [DAO_SEED, name]
#[account]
#[derive(InitSpace)]
pub struct DAOAccount {
    pub version: u8,
    pub bump: u8,

    #[max_len(32)]
    pub name: String,

    /// Creates proposals. Holds no power over the treasury or the mint.
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub moderator: Pubkey,
    pub pool: Pubkey,
    pub pool_type: PoolType,

    pub treasury: Pubkey,
    pub treasury_bump: u8,
    pub mint_authority: Pubkey,
    pub mint_authority_bump: u8,

    /// Holds the position NFT, so only this program can move the pool's liquidity.
    pub liquidity_authority: Pubkey,
    pub liquidity_authority_bump: u8,
    /// The DAMM v2 position whose liquidity seeds proposals. Default until attached.
    pub position: Pubkey,
    /// Share of the position's unlocked liquidity each proposal's markets are seeded with.
    pub withdrawal_bps: u16,
    /// The proposal whose markets hold the liquidity right now, or default. One at a time,
    /// so liquidity on its way into a proposal cannot be pushed back into the pool.
    pub active_proposal: Pubkey,
}

#[event]
pub struct DAOInitialized {
    pub version: u8,
    pub name: String,
    pub dao: Pubkey,
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub treasury: Pubkey,
    pub mint_authority: Pubkey,
    pub pool: Pubkey,
}
