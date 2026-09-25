use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum RaiseState {
    /// Taking commitments until `ends_at`.
    Live,
    /// Reached its goal: the pool's and the treasury's shares have been paid out, and
    /// backers claim their tokens and any oversubscription refund.
    Succeeded,
    /// Ended below its goal: every backer takes their whole commitment back.
    Failed,
}

#[account]
#[derive(InitSpace)]
pub struct Raise {
    /// Who opened the raise.
    pub authority: Pubkey,
    /// The token being sold. Its launch supply is minted into `base_vault` when the raise
    /// opens; the mint authority passes to `pool_operator` if the raise succeeds.
    pub base_mint: Pubkey,
    /// What backers pay in. USDC in production; any 6-decimal mint in tests.
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    /// Receives `goal - quote_to_pool` when the raise succeeds.
    pub treasury: Pubkey,
    /// Receives `quote_to_pool` and `tokens_for_pool` to open the liquidity pool, and the
    /// mint authority to hand to the DAO. The only account that can open claims early.
    pub pool_operator: Pubkey,
    /// The amount raised, exactly: oversubscription is refunded, not kept.
    pub goal: u64,
    pub tokens_for_investors: u64,
    pub tokens_for_pool: u64,
    pub quote_to_pool: u64,
    pub total_committed: u64,
    pub starts_at: i64,
    pub ends_at: i64,
    pub settled_at: i64,
    /// How long after `ends_at` a raise that met its goal may wait to become a DAO. Past
    /// it, `settle` marks it failed and everyone takes their commitment back.
    pub claim_delay_seconds: i64,
    /// The DAO it opens on success, committed to at creation: see `InitializeRaiseArgs`.
    pub dao_commitment: [u8; 32],
    pub state: RaiseState,
    pub claims_open: bool,
    pub bump: u8,
}

impl Raise {
    pub fn quote_to_treasury(&self) -> u64 {
        self.goal - self.quote_to_pool
    }
}

#[account]
#[derive(InitSpace)]
pub struct Commitment {
    pub raise: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    /// Set once tokens and refund, or the whole refund of a failed raise, have been paid.
    pub settled: bool,
    pub bump: u8,
}
