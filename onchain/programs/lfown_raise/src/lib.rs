//! LFOwn raise — a fair launch's sale, written from scratch.
//!
//! The shape follows MetaDAO's launchpad (commit in USDC, one price for everyone,
//! oversubscription refunded, a raise that misses its goal refunded in full), but none of
//! its code: MetaDAO's programs are under the Business Source License, which does not
//! allow production use without their approval.
//!
//! The flow:
//!
//! 1. `initialize_raise` — the launch supply (`tokens_for_investors + tokens_for_pool`) is
//!    minted into the raise's vault. The raise keeps the mint authority but has no
//!    instruction that mints again.
//! 2. `commit` — anyone commits USDC until `ends_at`.
//! 3. `settle` — anyone, once `ends_at` has passed. Below the goal the raise fails. At or
//!    above it, `goal - quote_to_pool` goes to the treasury, and `quote_to_pool` USDC with
//!    `tokens_for_pool` tokens goes to the pool operator, who opens the liquidity pool.
//!    The mint authority goes to the pool operator too, to be handed to the DAO once it
//!    exists: the token stays mintable, so a proposal can issue more. A raise that fails
//!    keeps the authority, and with it nobody can ever mint that token again.
//! 4. `open_claims` — the pool operator confirms the pool exists. Until then nobody but
//!    the operator holds tokens, so nobody can open a pool of their own first at another
//!    price. Claims also open on their own after `claim_delay_seconds`.
//! 5. `claim` — tokens pro rata, plus the refund of any oversubscription.
//!    `refund` — the whole commitment back, for a raise that failed.
//!
//! The pool is opened off-chain by the operator rather than by CPI here. The operator
//! already holds the pool's withdrawable liquidity by design — futarchy governance pulls
//! it out to seed each proposal's markets — so a CPI would not remove any trust, and it
//! keeps this program to the one thing that must be trustless: backers' USDC.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, spl_token::instruction::AuthorityType, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer},
};

pub mod math;
pub mod state;

use state::*;

declare_id!("FpYo9n8JojtoCL3JKpQfR7oWAJmJhFmnDWjk4p4tFcSM");

pub const RAISE_SEED: &[u8] = b"raise";
pub const COMMITMENT_SEED: &[u8] = b"commitment";

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeRaiseArgs {
    pub goal: u64,
    pub tokens_for_investors: u64,
    pub tokens_for_pool: u64,
    pub quote_to_pool: u64,
    pub duration_seconds: i64,
    pub claim_delay_seconds: i64,
    /// A hash of the DAO this raise will open if it succeeds — its name, withdrawal share
    /// and governance rules (see futarchy's `bootstrap_dao`). Fixed before anyone commits,
    /// so backers know the rules they are buying into, and so opening the DAO needs no one's
    /// permission: whoever calls it can only open exactly this one.
    pub dao_commitment: [u8; 32],
}

#[program]
pub mod lfown_raise {
    use super::*;

    pub fn initialize_raise(ctx: Context<InitializeRaise>, args: InitializeRaiseArgs) -> Result<()> {
        require!(args.goal > 0, RaiseError::InvalidParams);
        require!(args.quote_to_pool <= args.goal, RaiseError::InvalidParams);
        require!(args.tokens_for_investors > 0 && args.tokens_for_pool > 0, RaiseError::InvalidParams);
        require!(args.duration_seconds > 0 && args.claim_delay_seconds >= 0, RaiseError::InvalidParams);
        require!(
            ctx.accounts.base_mint.mint_authority == COption::Some(ctx.accounts.raise.key()),
            RaiseError::InvalidMint
        );
        let supply = args
            .tokens_for_investors
            .checked_add(args.tokens_for_pool)
            .ok_or(RaiseError::Overflow)?;

        let mint_key = ctx.accounts.base_mint.key();
        let bump = ctx.bumps.raise;
        let seeds: &[&[u8]] = &[RAISE_SEED, mint_key.as_ref(), &[bump]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.base_vault.to_account_info(),
                    authority: ctx.accounts.raise.to_account_info(),
                },
                &[seeds],
            ),
            supply,
        )?;

        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.raise.set_inner(Raise {
            authority: ctx.accounts.authority.key(),
            base_mint: mint_key,
            quote_mint: ctx.accounts.quote_mint.key(),
            base_vault: ctx.accounts.base_vault.key(),
            quote_vault: ctx.accounts.quote_vault.key(),
            treasury: ctx.accounts.treasury.key(),
            pool_operator: ctx.accounts.pool_operator.key(),
            goal: args.goal,
            tokens_for_investors: args.tokens_for_investors,
            tokens_for_pool: args.tokens_for_pool,
            quote_to_pool: args.quote_to_pool,
            total_committed: 0,
            starts_at: now,
            ends_at: now.checked_add(args.duration_seconds).ok_or(RaiseError::Overflow)?,
            settled_at: 0,
            claim_delay_seconds: args.claim_delay_seconds,
            dao_commitment: args.dao_commitment,
            state: RaiseState::Live,
            claims_open: false,
            bump,
        });
        emit!(RaiseOpened { raise: ctx.accounts.raise.key(), base_mint: mint_key, goal: args.goal, ends_at: ctx.accounts.raise.ends_at });
        Ok(())
    }

    pub fn commit(ctx: Context<Commit>, amount: u64) -> Result<()> {
        let raise = &ctx.accounts.raise;
        require!(raise.state == RaiseState::Live, RaiseError::NotLive);
        require!(Clock::get()?.unix_timestamp < raise.ends_at, RaiseError::Ended);
        require!(amount > 0, RaiseError::InvalidAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_quote.to_account_info(),
                    to: ctx.accounts.quote_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let commitment = &mut ctx.accounts.commitment;
        if commitment.owner == Pubkey::default() {
            commitment.raise = ctx.accounts.raise.key();
            commitment.owner = ctx.accounts.user.key();
            commitment.bump = ctx.bumps.commitment;
        }
        commitment.amount = commitment.amount.checked_add(amount).ok_or(RaiseError::Overflow)?;

        let raise = &mut ctx.accounts.raise;
        raise.total_committed = raise.total_committed.checked_add(amount).ok_or(RaiseError::Overflow)?;
        emit!(Committed { raise: raise.key(), owner: commitment.owner, amount, total_committed: raise.total_committed });
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let raise = &ctx.accounts.raise;
        require!(raise.state == RaiseState::Live, RaiseError::NotLive);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= raise.ends_at, RaiseError::NotEnded);

        if raise.total_committed < raise.goal {
            let raise = &mut ctx.accounts.raise;
            raise.state = RaiseState::Failed;
            raise.settled_at = now;
            emit!(RaiseSettled { raise: raise.key(), succeeded: false, total_committed: raise.total_committed });
            return Ok(());
        }

        let mint_key = raise.base_mint;
        let seeds: &[&[u8]] = &[RAISE_SEED, mint_key.as_ref(), &[raise.bump]];

        let quote_to_treasury = raise.quote_to_treasury();
        let quote_to_pool = raise.quote_to_pool;
        let tokens_for_pool = raise.tokens_for_pool;

        transfer_signed(&ctx.accounts.token_program, &ctx.accounts.quote_vault, &ctx.accounts.treasury_quote, &ctx.accounts.raise, seeds, quote_to_treasury)?;
        transfer_signed(&ctx.accounts.token_program, &ctx.accounts.quote_vault, &ctx.accounts.operator_quote, &ctx.accounts.raise, seeds, quote_to_pool)?;
        transfer_signed(&ctx.accounts.token_program, &ctx.accounts.base_vault, &ctx.accounts.operator_base, &ctx.accounts.raise, seeds, tokens_for_pool)?;
        // The token stays mintable after launch, under governance: the operator passes the
        // authority on to the DAO's mint vault when it creates the DAO.
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.raise.to_account_info(),
                    account_or_mint: ctx.accounts.base_mint.to_account_info(),
                },
                &[seeds],
            ),
            AuthorityType::MintTokens,
            Some(ctx.accounts.pool_operator.key()),
        )?;

        let raise = &mut ctx.accounts.raise;
        raise.state = RaiseState::Succeeded;
        raise.settled_at = now;
        emit!(RaiseSettled { raise: raise.key(), succeeded: true, total_committed: raise.total_committed });
        Ok(())
    }

    pub fn open_claims(ctx: Context<OpenClaims>) -> Result<()> {
        let raise = &mut ctx.accounts.raise;
        require!(raise.state == RaiseState::Succeeded, RaiseError::NotSucceeded);
        raise.claims_open = true;
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let raise = &ctx.accounts.raise;
        require!(raise.state == RaiseState::Succeeded, RaiseError::NotSucceeded);
        let now = Clock::get()?.unix_timestamp;
        let delay_passed = now >= raise.settled_at.saturating_add(raise.claim_delay_seconds);
        require!(raise.claims_open || delay_passed, RaiseError::ClaimsNotOpen);
        require!(!ctx.accounts.commitment.settled, RaiseError::AlreadySettled);

        let amount = ctx.accounts.commitment.amount;
        let tokens = math::tokens_for(amount, raise.total_committed, raise.tokens_for_investors);
        let refund = math::refund_for(amount, raise.total_committed, raise.goal);

        let mint_key = raise.base_mint;
        let seeds: &[&[u8]] = &[RAISE_SEED, mint_key.as_ref(), &[raise.bump]];
        if tokens > 0 {
            transfer_signed(&ctx.accounts.token_program, &ctx.accounts.base_vault, &ctx.accounts.user_base, &ctx.accounts.raise, seeds, tokens)?;
        }
        if refund > 0 {
            transfer_signed(&ctx.accounts.token_program, &ctx.accounts.quote_vault, &ctx.accounts.user_quote, &ctx.accounts.raise, seeds, refund)?;
        }
        ctx.accounts.commitment.settled = true;
        emit!(Claimed { raise: ctx.accounts.raise.key(), owner: ctx.accounts.user.key(), tokens, refund });
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let raise = &ctx.accounts.raise;
        require!(raise.state == RaiseState::Failed, RaiseError::NotFailed);
        require!(!ctx.accounts.commitment.settled, RaiseError::AlreadySettled);

        let amount = ctx.accounts.commitment.amount;
        let mint_key = raise.base_mint;
        let seeds: &[&[u8]] = &[RAISE_SEED, mint_key.as_ref(), &[raise.bump]];
        transfer_signed(&ctx.accounts.token_program, &ctx.accounts.quote_vault, &ctx.accounts.user_quote, &ctx.accounts.raise, seeds, amount)?;
        ctx.accounts.commitment.settled = true;
        emit!(Claimed { raise: ctx.accounts.raise.key(), owner: ctx.accounts.user.key(), tokens: 0, refund: amount });
        Ok(())
    }
}

/// A transfer out of one of the raise's vaults, signed by the raise.
fn transfer_signed<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    raise: &Account<'info, Raise>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer { from: from.to_account_info(), to: to.to_account_info(), authority: raise.to_account_info() },
            &[seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct InitializeRaise<'info> {
    #[account(
        mut,
        constraint = base_mint.decimals == 6 @ RaiseError::InvalidMint,
        constraint = base_mint.supply == 0 @ RaiseError::InvalidMint,
        constraint = base_mint.freeze_authority.is_none() @ RaiseError::InvalidMint,
    )]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(constraint = quote_mint.decimals == 6 @ RaiseError::InvalidMint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = authority,
        space = 8 + Raise::INIT_SPACE,
        seeds = [RAISE_SEED, base_mint.key().as_ref()],
        bump,
    )]
    pub raise: Box<Account<'info, Raise>>,
    #[account(init, payer = authority, associated_token::mint = base_mint, associated_token::authority = raise)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = authority, associated_token::mint = quote_mint, associated_token::authority = raise)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: only its address is recorded; it receives the treasury's share.
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: only its address is recorded; it receives the pool's share and opens claims.
    pub pool_operator: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Commit<'info> {
    #[account(mut, seeds = [RAISE_SEED, raise.base_mint.as_ref()], bump = raise.bump)]
    pub raise: Box<Account<'info, Raise>>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Commitment::INIT_SPACE,
        seeds = [COMMITMENT_SEED, raise.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub commitment: Box<Account<'info, Commitment>>,
    #[account(mut, token::mint = raise.quote_mint, token::authority = user)]
    pub user_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = raise.quote_vault)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, seeds = [RAISE_SEED, raise.base_mint.as_ref()], bump = raise.bump)]
    pub raise: Box<Account<'info, Raise>>,
    #[account(mut, address = raise.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = raise.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = raise.base_vault)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = raise.quote_vault)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked against the address recorded at initialization.
    #[account(address = raise.treasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = cranker, associated_token::mint = quote_mint, associated_token::authority = treasury)]
    pub treasury_quote: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked against the address recorded at initialization.
    #[account(address = raise.pool_operator)]
    pub pool_operator: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = cranker, associated_token::mint = quote_mint, associated_token::authority = pool_operator)]
    pub operator_quote: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = cranker, associated_token::mint = base_mint, associated_token::authority = pool_operator)]
    pub operator_base: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub cranker: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenClaims<'info> {
    #[account(mut, seeds = [RAISE_SEED, raise.base_mint.as_ref()], bump = raise.bump, has_one = pool_operator @ RaiseError::NotOperator)]
    pub raise: Box<Account<'info, Raise>>,
    pub pool_operator: Signer<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(seeds = [RAISE_SEED, raise.base_mint.as_ref()], bump = raise.bump)]
    pub raise: Box<Account<'info, Raise>>,
    #[account(
        mut,
        seeds = [COMMITMENT_SEED, raise.key().as_ref(), user.key().as_ref()],
        bump = commitment.bump,
        has_one = raise,
        constraint = commitment.owner == user.key() @ RaiseError::NotOwner,
    )]
    pub commitment: Box<Account<'info, Commitment>>,
    #[account(address = raise.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = raise.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = raise.base_vault)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = raise.quote_vault)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = user, associated_token::mint = base_mint, associated_token::authority = user)]
    pub user_base: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = user, associated_token::mint = quote_mint, associated_token::authority = user)]
    pub user_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(seeds = [RAISE_SEED, raise.base_mint.as_ref()], bump = raise.bump)]
    pub raise: Box<Account<'info, Raise>>,
    #[account(
        mut,
        seeds = [COMMITMENT_SEED, raise.key().as_ref(), user.key().as_ref()],
        bump = commitment.bump,
        has_one = raise,
        constraint = commitment.owner == user.key() @ RaiseError::NotOwner,
    )]
    pub commitment: Box<Account<'info, Commitment>>,
    #[account(address = raise.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = raise.quote_vault)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = user, associated_token::mint = quote_mint, associated_token::authority = user)]
    pub user_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct RaiseOpened {
    pub raise: Pubkey,
    pub base_mint: Pubkey,
    pub goal: u64,
    pub ends_at: i64,
}

#[event]
pub struct Committed {
    pub raise: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub total_committed: u64,
}

#[event]
pub struct RaiseSettled {
    pub raise: Pubkey,
    pub succeeded: bool,
    pub total_committed: u64,
}

#[event]
pub struct Claimed {
    pub raise: Pubkey,
    pub owner: Pubkey,
    pub tokens: u64,
    pub refund: u64,
}

#[error_code]
pub enum RaiseError {
    #[msg("The raise parameters are not valid")]
    InvalidParams,
    #[msg("The mint must have 6 decimals, no supply, no freeze authority, and the raise as mint authority")]
    InvalidMint,
    #[msg("The raise is not taking commitments")]
    NotLive,
    #[msg("The raise has ended")]
    Ended,
    #[msg("The raise has not ended yet")]
    NotEnded,
    #[msg("The raise did not succeed")]
    NotSucceeded,
    #[msg("The raise did not fail")]
    NotFailed,
    #[msg("Claims are not open yet")]
    ClaimsNotOpen,
    #[msg("This commitment has already been paid out")]
    AlreadySettled,
    #[msg("Only the pool operator can do this")]
    NotOperator,
    #[msg("This commitment belongs to someone else")]
    NotOwner,
    #[msg("The amount must be above zero")]
    InvalidAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
}
