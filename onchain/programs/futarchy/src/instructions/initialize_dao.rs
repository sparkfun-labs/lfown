// Derived from zcombinatorio/programs initialize_parent_dao (AGPL-3.0). LFOwn fork:
// no Squads, no protocol keys — see programs/COMBINATOR-FORK.md.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::Mint;

use crate::constants::MAX_WITHDRAWAL_BPS;
use crate::errors::FutarchyError;
use crate::state::dao::*;
use crate::state::moderator::*;

#[derive(Accounts)]
#[instruction(name: String)]
pub struct InitializeDAO<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + DAOAccount::INIT_SPACE,
        seeds = [DAO_SEED, name.as_bytes()],
        bump
    )]
    pub dao: Box<Account<'info, DAOAccount>>,

    #[account(
        init,
        payer = admin,
        space = 8 + ModeratorAccount::INIT_SPACE,
        seeds = [MODERATOR_SEED, name.as_bytes()],
        bump
    )]
    pub moderator: Box<Account<'info, ModeratorAccount>>,

    /// CHECK: a PDA that only signs; it holds no data of its own.
    #[account(seeds = [TREASURY_SEED, dao.key().as_ref()], bump)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: a PDA that only signs; it holds no data of its own.
    #[account(seeds = [MINT_AUTHORITY_SEED, dao.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: a PDA that only signs; it holds the position NFT once attached.
    #[account(seeds = [LIQUIDITY_SEED, dao.key().as_ref()], bump)]
    pub liquidity_authority: UncheckedAccount<'info>,

    /// The DAO must already hold its token's mint authority. A DAO that governs a token
    /// someone else can still mint governs nothing, so the handover comes first.
    #[account(
        constraint = base_mint.mint_authority == COption::Some(mint_authority.key()) @ FutarchyError::MintNotControlled,
    )]
    pub base_mint: Box<Account<'info, Mint>>,

    pub quote_mint: Box<Account<'info, Mint>>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_dao_handler(
    ctx: Context<InitializeDAO>,
    name: String,
    pool: Pubkey,
    pool_type: PoolType,
    withdrawal_bps: u16,
) -> Result<()> {
    require!(name.len() <= 32, FutarchyError::NameTooLong);
    require!(withdrawal_bps >= 1 && withdrawal_bps <= MAX_WITHDRAWAL_BPS, FutarchyError::InvalidWithdrawal);

    let admin = ctx.accounts.admin.key();
    let moderator_key = ctx.accounts.moderator.key();
    let base_mint = ctx.accounts.base_mint.key();
    let quote_mint = ctx.accounts.quote_mint.key();

    ctx.accounts.moderator.set_inner(ModeratorAccount {
        version: MODERATOR_VERSION,
        bump: ctx.bumps.moderator,
        name: name.clone(),
        quote_mint,
        base_mint,
        proposal_id_counter: 0,
        admin,
    });

    ctx.accounts.dao.set_inner(DAOAccount {
        version: DAO_VERSION,
        bump: ctx.bumps.dao,
        name: name.clone(),
        admin,
        token_mint: base_mint,
        quote_mint,
        moderator: moderator_key,
        pool,
        pool_type,
        treasury: ctx.accounts.treasury.key(),
        treasury_bump: ctx.bumps.treasury,
        mint_authority: ctx.accounts.mint_authority.key(),
        mint_authority_bump: ctx.bumps.mint_authority,
        liquidity_authority: ctx.accounts.liquidity_authority.key(),
        liquidity_authority_bump: ctx.bumps.liquidity_authority,
        position: Pubkey::default(),
        withdrawal_bps,
        active_proposal: Pubkey::default(),
    });

    emit!(ModeratorInitialized {
        version: MODERATOR_VERSION,
        name: name.clone(),
        moderator: moderator_key,
        admin,
        base_mint,
        quote_mint,
    });
    emit!(DAOInitialized {
        version: DAO_VERSION,
        name,
        dao: ctx.accounts.dao.key(),
        admin,
        token_mint: base_mint,
        treasury: ctx.accounts.treasury.key(),
        mint_authority: ctx.accounts.mint_authority.key(),
        pool,
    });
    Ok(())
}
