use amm::cpi::accounts::CreatePool;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, TokenAccount, Transfer};
use vault::VAULT_VERSION;
use vault::cpi::accounts::InitializeVault;

use crate::cp_amm;
use crate::price_guard::{check_fair_price, max_observation_delta, observation_for, spot_sqrt_price};

use crate::state::moderator::{ModeratorAccount, MODERATOR_SEED};
use crate::state::dao::{DAOAccount, DAO_SEED};
use crate::state::proposal::*;
use crate::errors::FutarchyError;
use amm::program::Amm;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use vault::program::Vault;

#[event]
pub struct ProposalInitialized {
    pub version: u8,
    pub proposal_id: u16,
    pub proposal: Pubkey,
    pub moderator: Pubkey,
    pub length: u16,
    pub creator: Pubkey,
}

// LFOwn fork: anyone may propose, by locking the DAO's `proposal_stake` until the
// proposal is decided (`return_stake` gives it back). Upstream allowed the moderator's
// admin alone, which made a DAO's governance only as open as one key.
//
// The creator picks the question and its options, nothing else: the length, TWAP bounds,
// pass margin and fee come from the DAO's governance config, and the markets open at the
// DAO pool's own price, checked against the price guard.
#[derive(Accounts)]
pub struct InitializeProposal<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [
            MODERATOR_SEED,
            moderator.base_mint.as_ref()
        ],
        bump = moderator.bump
    )]
    pub moderator: Box<Account<'info, ModeratorAccount>>,

    // LFOwn fork: the DAO whose liquidity authority provides the markets' liquidity.
    #[account(
        seeds = [DAO_SEED, moderator.base_mint.as_ref()],
        bump = dao.bump,
        constraint = dao.moderator == moderator.key() @ FutarchyError::InvalidDAO,
    )]
    pub dao: Box<Account<'info, DAOAccount>>,

    #[account(
        init,
        payer = creator,
        space = 8 + ProposalAccount::INIT_SPACE,
        seeds = [
            PROPOSAL_SEED,
            moderator.key().as_ref(),
            &moderator.proposal_id_counter.to_le_bytes()
        ],
        bump
    )]
    pub proposal: Box<Account<'info, ProposalAccount>>,

    /// The DAO's DAMM v2 pool, whose price the markets open at.
    #[account(address = dao.pool @ FutarchyError::InvalidPool)]
    pub pool: AccountLoader<'info, cp_amm::accounts::Pool>,

    #[account(address = dao.token_mint @ FutarchyError::InvalidMint)]
    pub token_mint: Box<Account<'info, Mint>>,

    /// Where the creator's stake comes from.
    #[account(mut, token::mint = token_mint, token::authority = creator)]
    pub creator_token: Box<Account<'info, TokenAccount>>,

    /// Holds the stake until the proposal is decided.
    #[account(
        init,
        payer = creator,
        seeds = [STAKE_SEED, proposal.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = proposal,
    )]
    pub stake_escrow: Box<Account<'info, TokenAccount>>,

    // Programs
    pub system_program: Program<'info, System>,
    pub vault_program: Program<'info, Vault>,
    pub amm_program: Program<'info, Amm>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    // Remaining accounts (in order):
    // 0: base_mint
    // 1: quote_mint
    // 2: vault
    // 3: base_token_acc
    // 4: quote_token_acc
    // 5: cond_base_mint_0
    // 6: cond_base_mint_1
    // 7: cond_quote_mint_0
    // 8: cond_quote_mint_1
    // 9: pool_0
    // 10: reserve_a_0
    // 11: reserve_b_0
    // 12: fee_authority
    // 13: fee_vault_0
    // 14: pool_1
    // 15: reserve_a_1
    // 16: reserve_b_1
    // 17: fee_vault_1
}

pub fn initialize_proposal_handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, InitializeProposal<'info>>,
    metadata: Option<String>,
) -> Result<u16> {
    require!(
        ctx.remaining_accounts.len() == 18,
        FutarchyError::InvalidRemainingAccounts
    );

    if let Some(m) = &metadata {
        require!(m.len() <= 64, FutarchyError::MetadataTooLong);
    }

    // The markets open at the pool's price, and only a price the guard accepts.
    let dao = &ctx.accounts.dao;
    require_keys_neq!(dao.position, Pubkey::default(), FutarchyError::PositionNotAttached);
    let sqrt_price = spot_sqrt_price(&ctx.accounts.pool)?;
    check_fair_price(dao, sqrt_price, Clock::get()?.unix_timestamp)?;
    let starting_observation = observation_for(sqrt_price);
    let governance = dao.governance;
    let proposal_params = ProposalParams {
        length: governance.proposal_length_minutes,
        starting_observation,
        max_observation_delta: max_observation_delta(starting_observation, governance.max_observation_change_bps),
        warmup_duration: governance.warmup_seconds,
        market_bias: governance.market_bias_bps,
        fee: governance.market_fee_bps,
    };
    proposal_params.validate()?;

    let stake = governance.proposal_stake;
    if stake > 0 {
        require!(ctx.accounts.creator_token.amount >= stake, FutarchyError::InsufficientStake);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.creator_token.to_account_info(),
                    to: ctx.accounts.stake_escrow.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            stake,
        )?;
    }

    // Validate mints match moderator
    let moderator = &mut ctx.accounts.moderator;
    require!(
        ctx.remaining_accounts[0].key() == moderator.base_mint,
        FutarchyError::InvalidMint
    );
    require!(
        ctx.remaining_accounts[1].key() == moderator.quote_mint,
        FutarchyError::InvalidMint
    );

    let proposal = &mut ctx.accounts.proposal;

    // Store state with checked counter increment
    let proposal_id = moderator.proposal_id_counter;
    moderator.proposal_id_counter = proposal_id
        .checked_add(1)
        .ok_or(FutarchyError::CounterOverflow)?;
    proposal.version = PROPOSAL_VERSION;
    proposal.id = proposal_id;
    proposal.creator = ctx.accounts.creator.key();
    proposal.moderator = moderator.key();
    proposal.base_mint = moderator.base_mint;
    proposal.quote_mint = moderator.quote_mint;
    proposal.bump = ctx.bumps.proposal;
    proposal.config = proposal_params;
    proposal.num_options = 2;
    proposal.state = ProposalState::Setup;
    proposal.pools[0] = ctx.remaining_accounts[9].key();
    proposal.pools[1] = ctx.remaining_accounts[14].key();
    // pools[2..] already default/zeroed
    proposal.vault = ctx.remaining_accounts[2].key();
    proposal.metadata = metadata;
    proposal.stake = stake;

    // Build proposal PDA signer seeds
    let proposal_seeds = &[
        PROPOSAL_SEED,
        proposal.moderator.as_ref(),
        &proposal_id.to_le_bytes(),
        &[ctx.bumps.proposal],
    ];
    let signer_seeds = &[&proposal_seeds[..]];

    // Initialize Vault with proposal PDA as owner, signer as payer
    let init_vault_ctx = CpiContext::new_with_signer(
        ctx.accounts.vault_program.to_account_info(),
        InitializeVault {
            payer: ctx.accounts.creator.to_account_info(),
            owner: proposal.to_account_info(),
            base_mint: ctx.remaining_accounts[0].to_account_info(),
            quote_mint: ctx.remaining_accounts[1].to_account_info(),
            vault: ctx.remaining_accounts[2].to_account_info(),
            base_token_acc: ctx.remaining_accounts[3].to_account_info(),
            quote_token_acc: ctx.remaining_accounts[4].to_account_info(),
            cond_base_mint_0: ctx.remaining_accounts[5].to_account_info(),
            cond_quote_mint_0: ctx.remaining_accounts[7].to_account_info(),
            cond_base_mint_1: ctx.remaining_accounts[6].to_account_info(),
            cond_quote_mint_1: ctx.remaining_accounts[8].to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
        },
        signer_seeds,
    );

    vault::cpi::initialize(init_vault_ctx, proposal_id)?;

    // Each market trades, and its TWAP counts, for the proposal's length from the moment
    // it is funded (`launch_proposal`), and not a second past it.
    let trading_seconds = proposal.config.length as u32 * 60;

    // Create pool 0
    let create_pool_0_ctx = CpiContext::new_with_signer(
        ctx.accounts.amm_program.to_account_info(),
        CreatePool {
            payer: ctx.accounts.creator.to_account_info(),
            admin: proposal.to_account_info(),
            mint_a: ctx.remaining_accounts[7].to_account_info(), // cond_quote_mint_0
            mint_b: ctx.remaining_accounts[5].to_account_info(), // cond_base_mint_0
            pool: ctx.remaining_accounts[9].to_account_info(),   // pool_0
            reserve_a: ctx.remaining_accounts[10].to_account_info(), // reserve_a_0
            reserve_b: ctx.remaining_accounts[11].to_account_info(), // reserve_b_0
            fee_authority: ctx.remaining_accounts[12].to_account_info(), // fee_authority
            fee_vault: ctx.remaining_accounts[13].to_account_info(), // fee_vault_0
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
        signer_seeds
    );

    amm::cpi::create_pool(
        create_pool_0_ctx,
        proposal.config.fee,
        proposal.config.starting_observation,
        proposal.config.max_observation_delta,
        proposal.config.warmup_duration,
        trading_seconds,
        Some(ctx.accounts.dao.liquidity_authority)
    )?;

    // Create pool 1
    let create_pool_1_ctx = CpiContext::new_with_signer(
        ctx.accounts.amm_program.to_account_info(),
        CreatePool {
            payer: ctx.accounts.creator.to_account_info(),
            admin: proposal.to_account_info(),
            mint_a: ctx.remaining_accounts[8].to_account_info(), // cond_quote_mint_1
            mint_b: ctx.remaining_accounts[6].to_account_info(), // cond_base_mint_1
            pool: ctx.remaining_accounts[14].to_account_info(),  // pool_1
            reserve_a: ctx.remaining_accounts[15].to_account_info(), // reserve_a_1
            reserve_b: ctx.remaining_accounts[16].to_account_info(), // reserve_b_1
            fee_authority: ctx.remaining_accounts[12].to_account_info(), // fee_authority
            fee_vault: ctx.remaining_accounts[17].to_account_info(), // fee_vault_1
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
        signer_seeds
    );

    amm::cpi::create_pool(
        create_pool_1_ctx,
        proposal.config.fee,
        proposal.config.starting_observation,
        proposal.config.max_observation_delta,
        proposal.config.warmup_duration,
        trading_seconds,
        Some(ctx.accounts.dao.liquidity_authority)
    )?;

    emit!(ProposalInitialized {
        version: VAULT_VERSION,
        proposal_id,
        proposal: proposal.key(),
        moderator: moderator.key(),
        creator: proposal.creator,
        length: proposal.config.length
    });

    Ok(proposal_id)
}
