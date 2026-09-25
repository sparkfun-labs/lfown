// Derived from zcombinatorio/programs initialize_parent_dao (AGPL-3.0). LFOwn fork:
// no Squads, no protocol keys — see programs/COMBINATOR-FORK.md.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{self, spl_token::instruction::AuthorityType, Mint, SetAuthority, Token};

use crate::constants::MAX_WITHDRAWAL_BPS;
use crate::errors::FutarchyError;
use crate::state::dao::*;
use crate::state::moderator::*;

#[derive(Accounts)]
#[instruction(name: String)]
pub struct InitializeDAO<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Only whoever holds the token's mint may open its DAO, and hands the mint to it in
    /// the same instruction. A DAO that governs a token someone else can still mint governs
    /// nothing; and a mint handed to the DAO's address first could be claimed by anyone
    /// who opened the DAO before its owner did.
    #[account(
        mut,
        constraint = base_mint.mint_authority == COption::Some(admin.key()) @ FutarchyError::MintNotControlled,
    )]
    pub base_mint: Box<Account<'info, Mint>>,

    pub quote_mint: Box<Account<'info, Mint>>,

    // LFOwn fork: a DAO is found by its token, not by a name. A name is anyone's to type,
    // and a DAO opened under a raise's name before the raise settled took its money.
    #[account(
        init,
        payer = admin,
        space = 8 + DAOAccount::INIT_SPACE,
        seeds = [DAO_SEED, base_mint.key().as_ref()],
        bump
    )]
    pub dao: Box<Account<'info, DAOAccount>>,

    #[account(
        init,
        payer = admin,
        space = 8 + ModeratorAccount::INIT_SPACE,
        seeds = [MODERATOR_SEED, base_mint.key().as_ref()],
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

    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_dao_handler(
    ctx: Context<InitializeDAO>,
    name: String,
    pool: Pubkey,
    pool_type: PoolType,
    withdrawal_bps: u16,
    governance: GovernanceConfig,
) -> Result<()> {
    governance.validate()?;
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
        governance,
        // No checkpoint until the admin attaches the position, at the pool's price then.
        price_checkpoint: 0,
        price_checkpoint_at: 0,
        price_anchor: 0,
        price_anchor_at: 0,
        pending_return: false,
    });

    // The mint goes to the DAO in the same instruction that opens it.
    token::set_authority(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.admin.to_account_info(),
                account_or_mint: ctx.accounts.base_mint.to_account_info(),
            },
        ),
        AuthorityType::MintTokens,
        Some(ctx.accounts.mint_authority.key()),
    )?;

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
