// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
use anchor_lang::prelude::*;

pub const OPTION_ACTIONS_VERSION: u8 = 1;

#[constant]
pub const ACTIONS_SEED: &[u8] = b"actions";

/// Something a proposal option does if it wins. Deliberately a closed list: an option
/// that could run arbitrary instructions would be one nobody can price.
#[derive(Clone, Copy, InitSpace, AnchorSerialize, AnchorDeserialize, PartialEq, Eq, Debug)]
pub enum Action {
    /// Pay `amount` of `mint` out of the DAO treasury to `recipient`.
    Transfer { mint: Pubkey, amount: u64, recipient: Pubkey },
    /// Issue `amount` new DAO tokens to `recipient`.
    MintTo { amount: u64, recipient: Pubkey },
}

/// The actions attached to one option of one proposal.
///
/// Written only while the proposal is in `Setup`, so they are fixed before a single trade:
/// the market prices exactly what will run. Option 0 is the status quo and never has any.
///
/// Seeds: [ACTIONS_SEED, proposal, option_index]
#[account]
#[derive(InitSpace)]
pub struct OptionActions {
    pub version: u8,
    pub bump: u8,
    pub proposal: Pubkey,
    pub option_index: u8,
    #[max_len(4)] // == MAX_ACTIONS
    pub actions: Vec<Action>,
    /// Bit i is set once action i has run. Each runs at most once.
    pub executed: u8,
}

#[event]
pub struct OptionActionsSet {
    pub proposal: Pubkey,
    pub option_index: u8,
    pub actions: Vec<Action>,
}

#[event]
pub struct ActionExecuted {
    pub proposal: Pubkey,
    pub option_index: u8,
    pub action_index: u8,
    pub action: Action,
}
