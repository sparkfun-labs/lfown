// Derived from zcombinatorio/programs (AGPL-3.0). LFOwn fork: see programs/COMBINATOR-FORK.md.
use anchor_lang::prelude::*;

use crate::constants::{MAX_PROPOSAL_MINUTES, MIN_PROPOSAL_MINUTES};
use crate::errors::FutarchyError;

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

/// Seeds: [POSITION_NFT_SEED, dao]. The mint of a bootstrapped pool's position NFT.
#[constant]
pub const POSITION_NFT_SEED: &[u8] = b"position_nft";

/// The rules every proposal of a DAO runs under, fixed when the DAO opens.
///
/// Upstream let each proposal's creator pick its own length, TWAP bounds and pass margin,
/// which was harmless while only the protocol's admin could propose. Anyone can propose
/// here, so none of it is theirs to choose: a one-minute market, or a TWAP that cannot
/// move, would decide a vote before anyone could trade it.
#[derive(Copy, Clone, InitSpace, AnchorSerialize, AnchorDeserialize, PartialEq, Eq, Debug)]
pub struct GovernanceConfig {
    /// How long a proposal's markets trade, in minutes.
    pub proposal_length_minutes: u16,
    /// Seconds at the start of a proposal during which the TWAP does not count.
    pub warmup_seconds: u32,
    /// How far above the status quo's TWAP an option must finish to win, in basis points.
    pub market_bias_bps: u16,
    /// How far the TWAP's observation may move per update, in basis points of the price the
    /// market opened at.
    pub max_observation_change_bps: u16,
    /// The conditional markets' trading fee, in basis points.
    pub market_fee_bps: u16,
    /// DAO tokens a proposer locks until the proposal is decided. Zero for none.
    pub proposal_stake: u64,
    /// The most one `Transfer` action may take, in basis points of what the treasury holds
    /// of that token when it runs. A market worth a few thousand dollars must not be able
    /// to hand over everything in one vote.
    pub max_transfer_bps: u16,
    /// The most one `MintTo` action may issue, in basis points of the supply when it runs.
    pub max_mint_bps: u16,
    /// Seconds between a proposal's decision and its actions becoming executable: time for
    /// holders who disagree to leave before a hostile outcome lands.
    pub execution_delay_seconds: u32,
    /// Seconds after that during which the actions may run. Past it they never can: an
    /// old decision must not be executable against a treasury that has moved on.
    pub execution_window_seconds: u32,
    /// Share of the stake kept by the treasury when the market turns a proposal down, in
    /// basis points. Proposing costs something only if it can cost something.
    pub failed_stake_slash_bps: u16,
}

impl GovernanceConfig {
    pub fn validate(&self) -> Result<()> {
        require!(
            self.proposal_length_minutes >= MIN_PROPOSAL_MINUTES && self.proposal_length_minutes <= MAX_PROPOSAL_MINUTES,
            FutarchyError::InvalidGovernance
        );
        require!(self.warmup_seconds <= self.proposal_length_minutes as u32 * 60 / 2, FutarchyError::InvalidGovernance);
        require!(self.market_bias_bps <= 10_000, FutarchyError::InvalidGovernance);
        require!(
            self.max_observation_change_bps >= 1 && self.max_observation_change_bps <= 10_000,
            FutarchyError::InvalidGovernance
        );
        require!(self.market_fee_bps <= amm::MAX_FEE, FutarchyError::InvalidGovernance);
        require!(self.max_transfer_bps >= 1 && self.max_transfer_bps <= 10_000, FutarchyError::InvalidGovernance);
        require!(self.max_mint_bps <= 10_000, FutarchyError::InvalidGovernance);
        require!(self.execution_window_seconds >= 60, FutarchyError::InvalidGovernance);
        require!(self.failed_stake_slash_bps <= 10_000, FutarchyError::InvalidGovernance);
        Ok(())
    }
}

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
/// Seeds: [DAO_SEED, token_mint]
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

    pub governance: GovernanceConfig,

    /// The pool's square-root price as `record_price` last saw it, and when. Moving the
    /// DAO's liquidity, or opening a market, needs the pool to still be near a price that
    /// held at least a minute ago: see `price_guard.rs`.
    pub price_checkpoint: u128,
    pub price_checkpoint_at: i64,
    /// Where the checkpoint stood when its current window opened, and when: within a
    /// window it moves `MAX_CHECKPOINT_DRIFT_BPS` from there at most, whoever records.
    pub price_anchor: u128,
    pub price_anchor_at: i64,

    /// Set when a proposal's liquidity comes home, cleared when it is back in the pool. No
    /// proposal may take liquidity out in between, or each would take a share of what was
    /// left in the pool while the rest sat outside it, and the position would melt away.
    pub pending_return: bool,

    /// What winners have taken in the current LIMIT_WINDOW_SECONDS, in basis points of
    /// what was there each time: of the treasury's holding for transfers, of the supply for
    /// mints. The governance limits cap these sums, not each action, so ten proposals
    /// cannot take ten times the limit (4th audit M1).
    pub limit_window_start: i64,
    pub transferred_bps: u32,
    pub minted_bps: u32,
}

impl DAOAccount {
    /// Opens a new limit window, both sums back to zero, once the current one is over.
    pub fn roll_limit_window(&mut self, now: i64) {
        if now >= self.limit_window_start.saturating_add(crate::constants::LIMIT_WINDOW_SECONDS) {
            self.limit_window_start = now;
            self.transferred_bps = 0;
            self.minted_bps = 0;
        }
    }
}

/// Adds `amount` of `base`, in basis points rounded up, to `used`, refusing a sum past `max`.
/// Rounded up: a run of small actions cannot slip under the limit.
pub fn spend_allowance(used: u32, max: u16, amount: u64, base: u64) -> Result<u32> {
    require!(base > 0, FutarchyError::ActionOverLimit);
    let total = (used as u128).saturating_add(((amount as u128) * 10_000).div_ceil(base as u128));
    require!(total <= max as u128, FutarchyError::ActionOverLimit);
    Ok(total as u32)
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
