use crate::constants::MAX_OPTIONS;
use anchor_lang::prelude::*;
use crate::errors::*;

pub const PROPOSAL_VERSION: u8 = 1;

#[constant]
pub const PROPOSAL_SEED: &[u8] = b"proposal";

/// Seeds: [STAKE_SEED, proposal]. The token account holding a proposer's stake.
#[constant]
pub const STAKE_SEED: &[u8] = b"stake";

#[derive(Copy, Clone, InitSpace, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub enum ProposalState {
    Setup,        // Options being added
    Pending,      // Betting active
    Resolved(u8), // Index of the winning option
}

#[derive(InitSpace, AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ProposalParams {
    pub length: u16,                 // In minutes
    pub starting_observation: u128,  // Initial TWAP value
    pub max_observation_delta: u128, // Max change per update
    pub warmup_duration: u32,        // Seconds before TWAP is valid
    pub market_bias: u16, // "pass-fail" gap. bips required for an option to win over index 0
    pub fee: u16,                    // AMM protocol fee in bips
}

impl ProposalParams {
    pub fn validate(&self) -> Result<()> {
        // Cap maximum gap at 100%
        require!(self.market_bias <= 10000, FutarchyError::InvalidProposalParams);

        // Warm-up shouldn't last longer than proposal (warmup is seconds, length is minutes)
        require!(self.warmup_duration <= self.length as u32 * 60, FutarchyError::InvalidProposalParams);

        // Ensure updates can occur
        require!(self.max_observation_delta > 0, FutarchyError::InvalidProposalParams);

        // Proposals of length 0 are nonsensical
        require!(self.length > 0, FutarchyError::InvalidProposalParams);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
/// Seeds: [PROPOSAL_SEED, moderator.key(), &id.to_le_bytes()]
pub struct ProposalAccount {
    pub version: u8,
    pub bump: u8,
    pub moderator: Pubkey,
    pub id: u16, // Set by moderator
    pub num_options: u8,
    pub state: ProposalState,

    pub created_at: i64,
    pub creator: Pubkey, // Should match moderator admin

    // References for validation
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub vault: Pubkey,
    pub pools: [Pubkey; MAX_OPTIONS as usize],

    // Configuration
    pub config: ProposalParams,

    // LFOwn fork: what `prepare_proposal_liquidity` took out of the DAO's pool for this
    // proposal's markets. Zero until then.
    pub base_liquidity: u64,
    pub quote_liquidity: u64,

    // LFOwn fork: DAO tokens the creator locked to propose, held by the proposal until
    // it is decided. Zero once returned.
    pub stake: u64,

    #[max_len(64)] // Should cover v0 & most of v1
    pub metadata: Option<String>, // IPFS CID
}
