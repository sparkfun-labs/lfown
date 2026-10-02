// Derived from zcombinatorio/programs (AGPL-3.0). LFOwn fork: see programs/COMBINATOR-FORK.md.
//
// One DAO per token, governed by futarchy over its liquidity pool. What upstream ran by
// hand through protocol-held multisig keys runs here on-chain: an option carries its
// actions from before the market opens, and once it has won anyone can execute them.
use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod liquidity;
pub mod price_guard;
pub mod state;

pub use constants::*;
pub use errors::*;
pub use instructions::*;
pub use state::*;

declare_id!("5cviD5QQ1WKi8aaqh9wCbirJVp1tFkZyoCYZNmdPNoAK");

// Meteora DAMM v2 (cp-amm), called through its IDL only: none of Meteora's source is
// copied here. The IDL is the interface their published SDK ships with.
declare_program!(cp_amm);

#[program]
pub mod futarchy {
    use super::*;

    pub fn initialize_dao(
        ctx: Context<InitializeDAO>,
        name: String,
        pool: Pubkey,
        pool_type: PoolType,
        withdrawal_bps: u16,
        governance: GovernanceConfig,
    ) -> Result<()> {
        instructions::initialize_dao::initialize_dao_handler(ctx, name, pool, pool_type, withdrawal_bps, governance)
    }

    pub fn bootstrap_dao(
        ctx: Context<BootstrapDAO>,
        name: String,
        withdrawal_bps: u16,
        governance: GovernanceConfig,
    ) -> Result<()> {
        instructions::bootstrap_dao::bootstrap_dao_handler(ctx, name, withdrawal_bps, governance)
    }

    pub fn record_price(ctx: Context<RecordPrice>) -> Result<()> {
        instructions::record_price::record_price_handler(ctx)
    }

    pub fn attach_position(ctx: Context<AttachPosition>) -> Result<()> {
        instructions::liquidity::attach_position_handler(ctx)
    }

    pub fn prepare_proposal_liquidity(ctx: Context<PrepareProposalLiquidity>) -> Result<()> {
        instructions::liquidity::prepare_proposal_liquidity_handler(ctx)
    }

    pub fn return_liquidity(ctx: Context<ReturnLiquidity>) -> Result<()> {
        instructions::liquidity::return_liquidity_handler(ctx)
    }

    pub fn claim_pool_fees(ctx: Context<ClaimPoolFees>) -> Result<()> {
        instructions::liquidity::claim_pool_fees_handler(ctx)
    }

    pub fn withdraw_protocol_fees(ctx: Context<WithdrawProtocolFees>) -> Result<()> {
        instructions::liquidity::withdraw_protocol_fees_handler(ctx)
    }

    pub fn initialize_proposal<'info>(
        ctx: Context<'_, '_, 'info, 'info, InitializeProposal<'info>>,
        metadata: Option<String>,
    ) -> Result<u16> {
        instructions::initialize_proposal::initialize_proposal_handler(ctx, metadata)
    }

    pub fn create_proposal_markets<'info>(ctx: Context<'_, '_, 'info, 'info, CreateProposalMarkets<'info>>) -> Result<()> {
        instructions::create_markets::create_proposal_markets_handler(ctx)
    }

    pub fn cancel_proposal(ctx: Context<CancelProposal>) -> Result<()> {
        instructions::cancel_proposal::cancel_proposal_handler(ctx)
    }

    pub fn add_option<'info>(ctx: Context<'_, '_, 'info, 'info, AddOption<'info>>) -> Result<()> {
        instructions::add_option::add_option_handler(ctx)
    }

    pub fn set_option_actions(
        ctx: Context<SetOptionActions>,
        option_index: u8,
        actions: Vec<Action>,
    ) -> Result<()> {
        instructions::set_option_actions::set_option_actions_handler(ctx, option_index, actions)
    }

    pub fn launch_proposal<'info>(
        ctx: Context<'_, '_, 'info, 'info, LaunchProposal<'info>>,
    ) -> Result<()> {
        instructions::launch_proposal::launch_proposal_handler(ctx)
    }

    pub fn finalize_proposal<'info>(
        ctx: Context<'_, '_, 'info, 'info, FinalizeProposal<'info>>,
    ) -> Result<()> {
        instructions::finalize_proposal::finalize_proposal_handler(ctx)
    }

    pub fn redeem_liquidity<'info>(
        ctx: Context<'_, '_, 'info, 'info, RedeemLiquidity<'info>>,
    ) -> Result<()> {
        instructions::redeem_liquidity::redeem_liquidity_handler(ctx)
    }

    pub fn return_stake(ctx: Context<ReturnStake>) -> Result<()> {
        instructions::return_stake::return_stake_handler(ctx)
    }

    pub fn execute_transfer(ctx: Context<ExecuteTransfer>, action_index: u8) -> Result<()> {
        instructions::execute_action::execute_transfer_handler(ctx, action_index)
    }

    pub fn execute_mint(ctx: Context<ExecuteMint>, action_index: u8) -> Result<()> {
        instructions::execute_action::execute_mint_handler(ctx, action_index)
    }

    pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::transfer_admin::transfer_admin_handler(ctx, new_admin)
    }
}
