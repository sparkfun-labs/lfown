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
//! 3. `settle` — once `ends_at` has passed. Below the goal the raise fails, and anyone may
//!    say so. At or above it, the raise succeeds only through its DAO: the pool operator
//!    is the DAO's liquidity authority, a PDA of the futarchy program, and it must sign —
//!    which it does only inside `futarchy::bootstrap_dao`, the instruction that opens the
//!    DAO and its pool in the same breath. `goal - quote_to_pool` goes to the treasury,
//!    `quote_to_pool` and `tokens_for_pool` to the operator, the mint authority too, and
//!    claims open: the pool exists by the end of that same instruction, so nobody can open
//!    one of their own first at another price.
//! 4. `claim` — tokens pro rata, plus the refund of any oversubscription.
//!    `refund` — the whole commitment back, for a raise that failed.
//!
//! A raise that met its goal but was never turned into a DAO by its deadline
//! (`ends_at + claim_delay_seconds`) fails like one that missed it: `settle` then marks it
//! failed, for anyone, and everyone takes their whole commitment back. Nothing is ever
//! left in the vault with no way out.
//!
//! What a raise may be is checked when it opens, not trusted: its mint must sign (so
//! nobody can open a raise on a creator's freshly made mint in between their two
//! transactions), its treasury and pool operator must be the addresses of the DAO its own
//! mint derives, the pool's share must open the pool at the backers' price, and its
//! windows are bounded.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self as ata, get_associated_token_address, AssociatedToken},
    token::{self, spl_token::instruction::AuthorityType, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer},
};

pub mod math;
pub mod state;

use state::*;

declare_id!("FpYo9n8JojtoCL3JKpQfR7oWAJmJhFmnDWjk4p4tFcSM");

pub const RAISE_SEED: &[u8] = b"raise";
pub const COMMITMENT_SEED: &[u8] = b"commitment";

/// LFOwn's futarchy program: a raise pays only the DAO its mint derives there.
pub const FUTARCHY_PROGRAM: Pubkey = pubkey!("5cviD5QQ1WKi8aaqh9wCbirJVp1tFkZyoCYZNmdPNoAK");
/// Bounds on a raise's windows. The deadline is how long a successful raise may wait for
/// its DAO before it counts as failed; never forever, never too short to be met.
pub const MIN_DURATION_SECONDS: i64 = 10;
pub const MAX_DURATION_SECONDS: i64 = 30 * 24 * 60 * 60;
pub const MIN_DEADLINE_SECONDS: i64 = 60;
pub const MAX_DEADLINE_SECONDS: i64 = 30 * 24 * 60 * 60;

/// The DAO a raise's mint derives in the futarchy program, and its two accounts that a
/// raise pays: (treasury, liquidity authority).
/// Metaplex's token metadata program, which names the token and shows its picture.
pub const METADATA_PROGRAM: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/// Metaplex's limits on a token's name, symbol and metadata URI.
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;

/// The futarchy DAO's mint authority for this mint: the only key that may rename the token
/// or change its picture, and only through a winning proposal.
pub fn dao_mint_authority(base_mint: &Pubkey) -> Pubkey {
    let (dao, _) = Pubkey::find_program_address(&[b"dao", base_mint.as_ref()], &FUTARCHY_PROGRAM);
    Pubkey::find_program_address(&[b"mint_authority", dao.as_ref()], &FUTARCHY_PROGRAM).0
}

pub fn dao_recipients(base_mint: &Pubkey) -> (Pubkey, Pubkey) {
    let (dao, _) = Pubkey::find_program_address(&[b"dao", base_mint.as_ref()], &FUTARCHY_PROGRAM);
    let (treasury, _) = Pubkey::find_program_address(&[b"treasury", dao.as_ref()], &FUTARCHY_PROGRAM);
    let (liquidity, _) = Pubkey::find_program_address(&[b"liquidity", dao.as_ref()], &FUTARCHY_PROGRAM);
    (treasury, liquidity)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeRaiseArgs {
    pub goal: u64,
    pub tokens_for_investors: u64,
    pub tokens_for_pool: u64,
    pub quote_to_pool: u64,
    pub duration_seconds: i64,
    /// How long after `ends_at` a raise that met its goal may wait to become a DAO; past
    /// it, the raise fails and everyone is refunded.
    pub claim_delay_seconds: i64,
    /// A hash of the DAO this raise will open if it succeeds — its name, withdrawal share
    /// and governance rules (see futarchy's `bootstrap_dao`). Fixed before anyone commits,
    /// so backers know the rules they are buying into, and so opening the DAO needs no one's
    /// permission: whoever calls it can only open exactly this one.
    pub dao_commitment: [u8; 32],
    /// The token's name, symbol and metadata URI, written by the raise when it creates the
    /// token: the creator never holds its mint, its metadata, or its freeze authority.
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

#[program]
pub mod lfown_raise {
    use super::*;

    pub fn initialize_raise(ctx: Context<InitializeRaise>, args: InitializeRaiseArgs) -> Result<()> {
        require!(args.goal > 0, RaiseError::InvalidParams);
        // Both shares are paid: some to the pool, some to the treasury.
        require!(args.quote_to_pool > 0 && args.quote_to_pool < args.goal, RaiseError::InvalidParams);
        require!(args.tokens_for_investors > 0 && args.tokens_for_pool > 0, RaiseError::InvalidParams);
        require!(
            (MIN_DURATION_SECONDS..=MAX_DURATION_SECONDS).contains(&args.duration_seconds)
                && (MIN_DEADLINE_SECONDS..=MAX_DEADLINE_SECONDS).contains(&args.claim_delay_seconds),
            RaiseError::InvalidParams
        );
        // The pool opens at the backers' price: quote_to_pool / tokens_for_pool equals
        // goal / tokens_for_investors, within one unit of rounding. Otherwise whoever sets
        // the raise up could open the pool far below what backers paid, and buy from it.
        let pool_side = args.quote_to_pool as u128 * args.tokens_for_investors as u128;
        let backer_side = args.goal as u128 * args.tokens_for_pool as u128;
        require!(pool_side.abs_diff(backer_side) <= args.tokens_for_investors as u128, RaiseError::PoolPriceMismatch);
        let (treasury, liquidity) = dao_recipients(&ctx.accounts.base_mint.key());
        require_keys_eq!(ctx.accounts.treasury.key(), treasury, RaiseError::NotTheDao);
        require_keys_eq!(ctx.accounts.pool_operator.key(), liquidity, RaiseError::NotTheDao);
        require!(
            args.name.len() <= MAX_NAME_LEN && args.symbol.len() <= MAX_SYMBOL_LEN && args.uri.len() <= MAX_URI_LEN,
            RaiseError::InvalidParams
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
        create_metadata(&ctx.accounts, seeds, &args)?;

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

        // Below the goal, or past the deadline without a DAO: failed, and anyone may say so.
        let deadline = raise.ends_at.saturating_add(raise.claim_delay_seconds);
        if raise.total_committed < raise.goal || now >= deadline {
            let raise = &mut ctx.accounts.raise;
            raise.state = RaiseState::Failed;
            raise.settled_at = now;
            emit!(RaiseSettled { raise: raise.key(), succeeded: false, total_committed: raise.total_committed });
            return Ok(());
        }

        // Success is paid out only to a DAO that is being opened right now: the operator is
        // the DAO's liquidity authority, which signs only inside `bootstrap_dao`.
        require!(ctx.accounts.pool_operator.is_signer, RaiseError::NotOperator);

        let mint_key = raise.base_mint;
        let seeds: &[&[u8]] = &[RAISE_SEED, mint_key.as_ref(), &[raise.bump]];

        let quote_to_treasury = raise.quote_to_treasury();
        let quote_to_pool = raise.quote_to_pool;
        let tokens_for_pool = raise.tokens_for_pool;

        // The recipients' accounts, opened only now: a failed raise pays nobody and opens none.
        let a = &ctx.accounts;
        for (account, owner, mint) in [
            (&a.treasury_quote, &a.treasury, &a.quote_mint),
            (&a.operator_quote, &a.pool_operator, &a.quote_mint),
        ] {
            open_associated(a, account.to_account_info(), owner.to_account_info(), mint.to_account_info())?;
        }
        open_associated(a, a.operator_base.to_account_info(), a.pool_operator.to_account_info(), a.base_mint.to_account_info())?;

        transfer_signed(&ctx.accounts.token_program, &ctx.accounts.quote_vault, ctx.accounts.treasury_quote.to_account_info(), &ctx.accounts.raise, seeds, quote_to_treasury)?;
        transfer_signed(&ctx.accounts.token_program, &ctx.accounts.quote_vault, ctx.accounts.operator_quote.to_account_info(), &ctx.accounts.raise, seeds, quote_to_pool)?;
        transfer_signed(&ctx.accounts.token_program, &ctx.accounts.base_vault, ctx.accounts.operator_base.to_account_info(), &ctx.accounts.raise, seeds, tokens_for_pool)?;
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
        raise.claims_open = true;
        emit!(RaiseSettled { raise: raise.key(), succeeded: true, total_committed: raise.total_committed });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let raise = &ctx.accounts.raise;
        require!(raise.state == RaiseState::Succeeded, RaiseError::NotSucceeded);
        require!(raise.claims_open, RaiseError::ClaimsNotOpen);
        require!(!ctx.accounts.commitment.settled, RaiseError::AlreadySettled);

        let amount = ctx.accounts.commitment.amount;
        let tokens = math::tokens_for(amount, raise.total_committed, raise.tokens_for_investors);
        let refund = math::refund_for(amount, raise.total_committed, raise.goal);

        let mint_key = raise.base_mint;
        let seeds: &[&[u8]] = &[RAISE_SEED, mint_key.as_ref(), &[raise.bump]];
        if tokens > 0 {
            transfer_signed(&ctx.accounts.token_program, &ctx.accounts.base_vault, ctx.accounts.user_base.to_account_info(), &ctx.accounts.raise, seeds, tokens)?;
        }
        if refund > 0 {
            transfer_signed(&ctx.accounts.token_program, &ctx.accounts.quote_vault, ctx.accounts.user_quote.to_account_info(), &ctx.accounts.raise, seeds, refund)?;
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
        transfer_signed(&ctx.accounts.token_program, &ctx.accounts.quote_vault, ctx.accounts.user_quote.to_account_info(), &ctx.accounts.raise, seeds, amount)?;
        ctx.accounts.commitment.settled = true;
        emit!(Claimed { raise: ctx.accounts.raise.key(), owner: ctx.accounts.user.key(), tokens: 0, refund: amount });
        Ok(())
    }
}

/// A transfer out of one of the raise's vaults, signed by the raise.
/// Opens `account`, the associated token account of `owner` for `mint`, if it is not open.
fn open_associated<'info>(a: &Settle<'info>, account: AccountInfo<'info>, owner: AccountInfo<'info>, mint: AccountInfo<'info>) -> Result<()> {
    ata::create_idempotent(CpiContext::new(
        a.associated_token_program.to_account_info(),
        ata::Create {
            payer: a.cranker.to_account_info(),
            associated_token: account,
            authority: owner,
            mint,
            system_program: a.system_program.to_account_info(),
            token_program: a.token_program.to_account_info(),
        },
    ))
}

fn transfer_signed<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    raise: &Account<'info, Raise>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer { from: from.to_account_info(), to, authority: raise.to_account_info() },
            &[seeds],
        ),
        amount,
    )
}

/// Metaplex `CreateMetadataAccountV3`, signed by the raise as the token's mint authority.
/// The update authority is the DAO's mint authority: nobody renames the token or swaps its
/// picture but a winning proposal.
#[inline(never)]
fn create_metadata(a: &InitializeRaise, seeds: &[&[u8]], args: &InitializeRaiseArgs) -> Result<()> {
    let mut data = vec![33u8]; // CreateMetadataAccountV3
    for text in [&args.name, &args.symbol, &args.uri] {
        data.extend_from_slice(&(text.len() as u32).to_le_bytes());
        data.extend_from_slice(text.as_bytes());
    }
    data.extend_from_slice(&[0, 0, 0, 0, 0, 1, 0]); // no fee, creators, collection or uses; mutable; no details
    let metas = vec![
        AccountMeta::new(a.metadata.key(), false),
        AccountMeta::new_readonly(a.base_mint.key(), false),
        AccountMeta::new_readonly(a.raise.key(), true),
        AccountMeta::new(a.authority.key(), true),
        AccountMeta::new_readonly(a.update_authority.key(), false),
        AccountMeta::new_readonly(a.system_program.key(), false),
        AccountMeta::new_readonly(a.rent.key(), false),
    ];
    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction { program_id: METADATA_PROGRAM, accounts: metas, data },
        &[
            a.metadata.to_account_info(), a.base_mint.to_account_info(), a.raise.to_account_info(),
            a.authority.to_account_info(), a.update_authority.to_account_info(), a.system_program.to_account_info(),
            a.rent.to_account_info(), a.token_metadata_program.to_account_info(),
        ],
        &[seeds],
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeRaise<'info> {
    // The raise creates the token itself: six decimals, the raise as its mint authority,
    // and no freeze authority, ever. A mint made beforehand could have had accounts the DAO
    // will use frozen in advance, its freeze authority revoked afterwards, and looked clean.
    #[account(init, payer = authority, mint::decimals = 6, mint::authority = raise)]
    pub base_mint: Box<Account<'info, Mint>>,
    // A coin someone can freeze could freeze the raise's vault, and with it every refund.
    // No ownership coin has a freeze authority (checked 25 Sep 2026: none of 23).
    #[account(
        constraint = quote_mint.decimals == 6 @ RaiseError::InvalidMint,
        constraint = quote_mint.freeze_authority.is_none() @ RaiseError::InvalidMint,
    )]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = authority,
        space = 8 + Raise::INIT_SPACE,
        seeds = [RAISE_SEED, base_mint.key().as_ref()],
        bump,
    )]
    pub raise: Box<Account<'info, Raise>>,
    // If needed: anyone can open an associated token account for any owner, and one opened
    // ahead of time must not stop the raise.
    #[account(init_if_needed, payer = authority, associated_token::mint = base_mint, associated_token::authority = raise)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = authority, associated_token::mint = quote_mint, associated_token::authority = raise)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: must be the treasury of the DAO this mint derives (checked in the handler).
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: must be the liquidity authority of that DAO (checked in the handler).
    pub pool_operator: UncheckedAccount<'info>,
    /// CHECK: the token's Metaplex metadata account, created by the CPI.
    #[account(mut, address = Pubkey::find_program_address(&[b"metadata", METADATA_PROGRAM.as_ref(), base_mint.key().as_ref()], &METADATA_PROGRAM).0 @ RaiseError::InvalidMint)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: the DAO's mint authority, the metadata's update authority.
    #[account(address = dao_mint_authority(&base_mint.key()) @ RaiseError::NotTheDao)]
    pub update_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: Metaplex's program, by address.
    #[account(address = METADATA_PROGRAM)]
    pub token_metadata_program: UncheckedAccount<'info>,
    pub rent: Sysvar<'info, Rent>,
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
    /// CHECK: the treasury's associated account for the coin; opened on success only.
    #[account(mut, address = get_associated_token_address(&treasury.key(), &quote_mint.key()) @ RaiseError::NotTheDao)]
    pub treasury_quote: UncheckedAccount<'info>,
    /// CHECK: checked against the address recorded at initialization.
    #[account(address = raise.pool_operator)]
    pub pool_operator: UncheckedAccount<'info>,
    /// CHECK: the operator's associated account for the coin; opened on success only.
    #[account(mut, address = get_associated_token_address(&pool_operator.key(), &quote_mint.key()) @ RaiseError::NotTheDao)]
    pub operator_quote: UncheckedAccount<'info>,
    /// CHECK: the operator's associated account for the token; opened on success only.
    #[account(mut, address = get_associated_token_address(&pool_operator.key(), &base_mint.key()) @ RaiseError::NotTheDao)]
    pub operator_base: UncheckedAccount<'info>,
    #[account(mut)]
    pub cranker: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
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
    #[msg("The pool's share does not open the pool at the backers' price")]
    PoolPriceMismatch,
    #[msg("The new mint must sign the raise that sells it")]
    MintMustSign,
    #[msg("The treasury and pool operator must be the DAO this mint derives")]
    NotTheDao,
}
