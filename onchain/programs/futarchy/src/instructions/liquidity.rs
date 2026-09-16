// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
//
// The DAO's own Meteora DAMM v2 position, run by this program alone.
//
// Upstream kept the pool's liquidity with a server key: the key pulled a share out to seed
// each proposal's markets, put it back afterwards, and split the pool fees. Here the
// position NFT belongs to the DAO's liquidity authority, a PDA of this program, so every
// one of those moves is an instruction whose rules are on-chain:
//
//   attach_position             once: the DAO takes custody of its position
//   prepare_proposal_liquidity  a proposal's creator takes `withdrawal_bps` of it out
//   (launch_proposal, redeem_liquidity move it through the markets and back)
//   return_liquidity            anyone: whatever came back goes into the pool again
//   claim_pool_fees             anyone: fees claimed and split with LFOwn
//
// Meteora's program is called through its IDL (`declare_program!(cp_amm)`); none of its
// source is used.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::TokenAccount as InterfaceTokenAccount;

use crate::constants::*;
use crate::cp_amm;
use crate::errors::FutarchyError;
use crate::liquidity::liquidity_for_amounts;
use crate::state::dao::*;
use crate::state::moderator::*;
use crate::state::proposal::*;

#[event]
pub struct PositionAttached {
    pub dao: Pubkey,
    pub pool: Pubkey,
    pub position: Pubkey,
}

#[event]
pub struct ProposalLiquidityPrepared {
    pub dao: Pubkey,
    pub proposal: Pubkey,
    pub liquidity_delta: u128,
    pub base_amount: u64,
    pub quote_amount: u64,
}

#[event]
pub struct LiquidityReturned {
    pub dao: Pubkey,
    pub liquidity_delta: u128,
    pub base_available: u64,
    pub quote_available: u64,
}

#[event]
pub struct PoolFeesClaimed {
    pub dao: Pubkey,
    pub base_to_treasury: u64,
    pub quote_to_treasury: u64,
    pub base_to_protocol: u64,
    pub quote_to_protocol: u64,
}

fn liquidity_seeds<'a>(dao: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [LIQUIDITY_SEED, dao.as_ref(), bump]
}

// ── attach_position ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct AttachPosition<'info> {
    #[account(address = dao.admin @ FutarchyError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [DAO_SEED, dao.name.as_bytes()], bump = dao.bump)]
    pub dao: Box<Account<'info, DAOAccount>>,

    /// CHECK: the DAO's liquidity authority, checked by seeds.
    #[account(seeds = [LIQUIDITY_SEED, dao.key().as_ref()], bump = dao.liquidity_authority_bump)]
    pub liquidity_authority: UncheckedAccount<'info>,

    #[account(address = dao.pool @ FutarchyError::InvalidPool)]
    pub pool: AccountLoader<'info, cp_amm::accounts::Pool>,

    pub position: AccountLoader<'info, cp_amm::accounts::Position>,

    /// The position NFT's token account, which the liquidity authority must already hold.
    pub position_nft_account: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
}

pub fn attach_position_handler(ctx: Context<AttachPosition>) -> Result<()> {
    let dao = &ctx.accounts.dao;
    require_keys_eq!(dao.position, Pubkey::default(), FutarchyError::PositionAlreadyAttached);
    {
        let pool = ctx.accounts.pool.load()?;
        require_keys_eq!(pool.token_a_mint, dao.token_mint, FutarchyError::InvalidPool);
        require_keys_eq!(pool.token_b_mint, dao.quote_mint, FutarchyError::InvalidPool);
    }
    {
        let position = ctx.accounts.position.load()?;
        let nft = &ctx.accounts.position_nft_account;
        require_keys_eq!(position.pool, dao.pool, FutarchyError::InvalidPosition);
        require_keys_eq!(nft.mint, position.nft_mint, FutarchyError::InvalidPosition);
        require_keys_eq!(nft.owner, ctx.accounts.liquidity_authority.key(), FutarchyError::InvalidPosition);
        require!(nft.amount == 1, FutarchyError::InvalidPosition);
    }

    let dao = &mut ctx.accounts.dao;
    dao.position = ctx.accounts.position.key();
    emit!(PositionAttached { dao: dao.key(), pool: dao.pool, position: dao.position });
    Ok(())
}

// ── prepare_proposal_liquidity ──────────────────────────────────────────────

#[derive(Accounts)]
pub struct PrepareProposalLiquidity<'info> {
    #[account(address = proposal.creator @ FutarchyError::Unauthorized)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.moderator.as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.state == ProposalState::Setup @ FutarchyError::InvalidState,
        constraint = proposal.base_liquidity == 0 && proposal.quote_liquidity == 0 @ FutarchyError::LiquidityAlreadyPrepared,
    )]
    pub proposal: Box<Account<'info, ProposalAccount>>,

    #[account(address = proposal.moderator @ FutarchyError::InvalidDAO)]
    pub moderator: Box<Account<'info, ModeratorAccount>>,

    #[account(
        mut,
        seeds = [DAO_SEED, moderator.name.as_bytes()],
        bump = dao.bump,
        constraint = dao.moderator == moderator.key() @ FutarchyError::InvalidDAO,
    )]
    pub dao: Box<Account<'info, DAOAccount>>,

    /// CHECK: the DAO's liquidity authority, checked by seeds; it signs the withdrawal.
    #[account(seeds = [LIQUIDITY_SEED, dao.key().as_ref()], bump = dao.liquidity_authority_bump)]
    pub liquidity_authority: UncheckedAccount<'info>,

    #[account(mut, token::mint = dao.token_mint, token::authority = liquidity_authority)]
    pub liquidity_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = dao.quote_mint, token::authority = liquidity_authority)]
    pub liquidity_quote: Box<Account<'info, TokenAccount>>,

    /// CHECK: Meteora's pool authority, fixed.
    #[account(address = DAMM_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(mut, address = dao.pool @ FutarchyError::InvalidPool)]
    pub pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    #[account(mut, address = dao.position @ FutarchyError::PositionNotAttached)]
    pub position: AccountLoader<'info, cp_amm::accounts::Position>,
    /// CHECK: validated by DAMM v2 against the pool.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM v2 against the pool.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: checked against the DAO.
    #[account(address = dao.token_mint @ FutarchyError::InvalidMint)]
    pub token_a_mint: UncheckedAccount<'info>,
    /// CHECK: checked against the DAO.
    #[account(address = dao.quote_mint @ FutarchyError::InvalidMint)]
    pub token_b_mint: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM v2: the position NFT, held by the signer.
    pub position_nft_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: DAMM v2's event authority, validated by DAMM v2.
    pub event_authority: UncheckedAccount<'info>,
    pub cp_amm_program: Program<'info, cp_amm::program::CpAmm>,
}

pub fn prepare_proposal_liquidity_handler(ctx: Context<PrepareProposalLiquidity>) -> Result<()> {
    let dao = &ctx.accounts.dao;
    require_keys_neq!(dao.position, Pubkey::default(), FutarchyError::PositionNotAttached);
    require_keys_eq!(dao.active_proposal, Pubkey::default(), FutarchyError::ProposalAlreadyActive);

    let liquidity_delta = {
        let position = ctx.accounts.position.load()?;
        let unlocked = position.unlocked_liquidity;
        let bps = dao.withdrawal_bps as u128;
        // Split so the product never nears u128's limit.
        (unlocked / 10_000) * bps + (unlocked % 10_000) * bps / 10_000
    };
    require!(liquidity_delta > 0, FutarchyError::NothingToWithdraw);

    let before_base = ctx.accounts.liquidity_base.amount;
    let before_quote = ctx.accounts.liquidity_quote.amount;

    let dao_key = dao.key();
    let bump = [dao.liquidity_authority_bump];
    let seeds = liquidity_seeds(&dao_key, &bump);
    cp_amm::cpi::remove_liquidity(
        CpiContext::new_with_signer(
            ctx.accounts.cp_amm_program.to_account_info(),
            cp_amm::cpi::accounts::RemoveLiquidity {
                pool_authority: ctx.accounts.pool_authority.to_account_info(),
                pool: ctx.accounts.pool.to_account_info(),
                position: ctx.accounts.position.to_account_info(),
                token_a_account: ctx.accounts.liquidity_base.to_account_info(),
                token_b_account: ctx.accounts.liquidity_quote.to_account_info(),
                token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
                token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
                token_a_mint: ctx.accounts.token_a_mint.to_account_info(),
                token_b_mint: ctx.accounts.token_b_mint.to_account_info(),
                position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
                signer: ctx.accounts.liquidity_authority.to_account_info(),
                token_a_program: ctx.accounts.token_program.to_account_info(),
                token_b_program: ctx.accounts.token_program.to_account_info(),
                event_authority: ctx.accounts.event_authority.to_account_info(),
                program: ctx.accounts.cp_amm_program.to_account_info(),
            },
            &[&seeds],
        ),
        cp_amm::types::RemoveLiquidityParameters {
            liquidity_delta,
            token_a_amount_threshold: 0,
            token_b_amount_threshold: 0,
        },
    )?;

    ctx.accounts.liquidity_base.reload()?;
    ctx.accounts.liquidity_quote.reload()?;
    let base_amount = ctx.accounts.liquidity_base.amount - before_base;
    let quote_amount = ctx.accounts.liquidity_quote.amount - before_quote;
    require!(base_amount > 0 && quote_amount > 0, FutarchyError::NothingToWithdraw);

    let proposal_key = ctx.accounts.proposal.key();
    let proposal = &mut ctx.accounts.proposal;
    proposal.base_liquidity = base_amount;
    proposal.quote_liquidity = quote_amount;
    ctx.accounts.dao.active_proposal = proposal_key;

    emit!(ProposalLiquidityPrepared { dao: dao_key, proposal: proposal_key, liquidity_delta, base_amount, quote_amount });
    Ok(())
}

// ── return_liquidity ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ReturnLiquidity<'info> {
    pub payer: Signer<'info>,

    #[account(seeds = [DAO_SEED, dao.name.as_bytes()], bump = dao.bump)]
    pub dao: Box<Account<'info, DAOAccount>>,

    /// CHECK: the DAO's liquidity authority, checked by seeds; it signs the deposit.
    #[account(seeds = [LIQUIDITY_SEED, dao.key().as_ref()], bump = dao.liquidity_authority_bump)]
    pub liquidity_authority: UncheckedAccount<'info>,

    #[account(mut, token::mint = dao.token_mint, token::authority = liquidity_authority)]
    pub liquidity_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = dao.quote_mint, token::authority = liquidity_authority)]
    pub liquidity_quote: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = dao.pool @ FutarchyError::InvalidPool)]
    pub pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    #[account(mut, address = dao.position @ FutarchyError::PositionNotAttached)]
    pub position: AccountLoader<'info, cp_amm::accounts::Position>,
    /// CHECK: validated by DAMM v2 against the pool.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM v2 against the pool.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: checked against the DAO.
    #[account(address = dao.token_mint @ FutarchyError::InvalidMint)]
    pub token_a_mint: UncheckedAccount<'info>,
    /// CHECK: checked against the DAO.
    #[account(address = dao.quote_mint @ FutarchyError::InvalidMint)]
    pub token_b_mint: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM v2: the position NFT, held by the signer.
    pub position_nft_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: DAMM v2's event authority, validated by DAMM v2.
    pub event_authority: UncheckedAccount<'info>,
    pub cp_amm_program: Program<'info, cp_amm::program::CpAmm>,
}

pub fn return_liquidity_handler(ctx: Context<ReturnLiquidity>) -> Result<()> {
    let dao = &ctx.accounts.dao;
    // While a proposal holds the liquidity, what sits with the authority is on its way into
    // that proposal's markets; putting it back into the pool would starve them.
    require_keys_eq!(dao.active_proposal, Pubkey::default(), FutarchyError::ProposalAlreadyActive);

    let (sqrt_price, sqrt_min, sqrt_max) = {
        let pool = ctx.accounts.pool.load()?;
        (pool.sqrt_price, pool.sqrt_min_price, pool.sqrt_max_price)
    };
    let base = ctx.accounts.liquidity_base.amount;
    let quote = ctx.accounts.liquidity_quote.amount;
    let liquidity_delta = liquidity_for_amounts(base, quote, sqrt_price, sqrt_min, sqrt_max)
        .ok_or(FutarchyError::NothingToReturn)?;

    let dao_key = dao.key();
    let bump = [dao.liquidity_authority_bump];
    let seeds = liquidity_seeds(&dao_key, &bump);
    cp_amm::cpi::add_liquidity(
        CpiContext::new_with_signer(
            ctx.accounts.cp_amm_program.to_account_info(),
            cp_amm::cpi::accounts::AddLiquidity {
                pool: ctx.accounts.pool.to_account_info(),
                position: ctx.accounts.position.to_account_info(),
                token_a_account: ctx.accounts.liquidity_base.to_account_info(),
                token_b_account: ctx.accounts.liquidity_quote.to_account_info(),
                token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
                token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
                token_a_mint: ctx.accounts.token_a_mint.to_account_info(),
                token_b_mint: ctx.accounts.token_b_mint.to_account_info(),
                position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
                signer: ctx.accounts.liquidity_authority.to_account_info(),
                token_a_program: ctx.accounts.token_program.to_account_info(),
                token_b_program: ctx.accounts.token_program.to_account_info(),
                event_authority: ctx.accounts.event_authority.to_account_info(),
                program: ctx.accounts.cp_amm_program.to_account_info(),
            },
            &[&seeds],
        ),
        cp_amm::types::AddLiquidityParameters {
            liquidity_delta,
            // Maximums: never more than the authority holds.
            token_a_amount_threshold: base,
            token_b_amount_threshold: quote,
        },
    )?;

    emit!(LiquidityReturned { dao: dao_key, liquidity_delta, base_available: base, quote_available: quote });
    Ok(())
}

// ── claim_pool_fees ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ClaimPoolFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [DAO_SEED, dao.name.as_bytes()], bump = dao.bump)]
    pub dao: Box<Account<'info, DAOAccount>>,

    /// CHECK: the DAO's liquidity authority, checked by seeds; it signs the claim and the split.
    #[account(seeds = [LIQUIDITY_SEED, dao.key().as_ref()], bump = dao.liquidity_authority_bump)]
    pub liquidity_authority: UncheckedAccount<'info>,
    /// CHECK: the DAO's treasury, checked by seeds.
    #[account(seeds = [TREASURY_SEED, dao.key().as_ref()], bump = dao.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: LFOwn's fee wallet, fixed.
    #[account(address = PROTOCOL_FEE_RECIPIENT)]
    pub protocol: UncheckedAccount<'info>,

    #[account(address = dao.token_mint @ FutarchyError::InvalidMint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = dao.quote_mint @ FutarchyError::InvalidMint)]
    pub quote_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = base_mint, token::authority = liquidity_authority)]
    pub liquidity_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = liquidity_authority)]
    pub liquidity_quote: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = base_mint, associated_token::authority = treasury)]
    pub treasury_base: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = quote_mint, associated_token::authority = treasury)]
    pub treasury_quote: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = base_mint, associated_token::authority = protocol)]
    pub protocol_base: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = quote_mint, associated_token::authority = protocol)]
    pub protocol_quote: Box<Account<'info, TokenAccount>>,

    /// CHECK: Meteora's pool authority, fixed.
    #[account(address = DAMM_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(address = dao.pool @ FutarchyError::InvalidPool)]
    pub pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    #[account(mut, address = dao.position @ FutarchyError::PositionNotAttached)]
    pub position: AccountLoader<'info, cp_amm::accounts::Position>,
    /// CHECK: validated by DAMM v2 against the pool.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM v2 against the pool.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM v2: the position NFT, held by the signer.
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's event authority, validated by DAMM v2.
    pub event_authority: UncheckedAccount<'info>,
    pub cp_amm_program: Program<'info, cp_amm::program::CpAmm>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_pool_fees_handler(ctx: Context<ClaimPoolFees>) -> Result<()> {
    let before_base = ctx.accounts.liquidity_base.amount;
    let before_quote = ctx.accounts.liquidity_quote.amount;

    let dao_key = ctx.accounts.dao.key();
    let bump = [ctx.accounts.dao.liquidity_authority_bump];
    let seeds = liquidity_seeds(&dao_key, &bump);
    cp_amm::cpi::claim_position_fee(CpiContext::new_with_signer(
        ctx.accounts.cp_amm_program.to_account_info(),
        cp_amm::cpi::accounts::ClaimPositionFee {
            pool_authority: ctx.accounts.pool_authority.to_account_info(),
            pool: ctx.accounts.pool.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            token_a_account: ctx.accounts.liquidity_base.to_account_info(),
            token_b_account: ctx.accounts.liquidity_quote.to_account_info(),
            token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
            token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
            token_a_mint: ctx.accounts.base_mint.to_account_info(),
            token_b_mint: ctx.accounts.quote_mint.to_account_info(),
            position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
            signer: ctx.accounts.liquidity_authority.to_account_info(),
            token_a_program: ctx.accounts.token_program.to_account_info(),
            token_b_program: ctx.accounts.token_program.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.cp_amm_program.to_account_info(),
        },
        &[&seeds],
    ))?;

    // Only what the claim brought in is split. The authority may also be holding liquidity
    // on its way to or from a proposal, and that is not fees.
    ctx.accounts.liquidity_base.reload()?;
    ctx.accounts.liquidity_quote.reload()?;
    let fees_base = ctx.accounts.liquidity_base.amount - before_base;
    let fees_quote = ctx.accounts.liquidity_quote.amount - before_quote;
    let protocol_share = |fees: u64| ((fees as u128) * PROTOCOL_FEE_SHARE_BPS as u128 / 10_000) as u64;
    let base_to_protocol = protocol_share(fees_base);
    let quote_to_protocol = protocol_share(fees_quote);
    let base_to_treasury = fees_base - base_to_protocol;
    let quote_to_treasury = fees_quote - quote_to_protocol;

    for (from, to, amount) in [
        (&ctx.accounts.liquidity_base, &ctx.accounts.treasury_base, base_to_treasury),
        (&ctx.accounts.liquidity_base, &ctx.accounts.protocol_base, base_to_protocol),
        (&ctx.accounts.liquidity_quote, &ctx.accounts.treasury_quote, quote_to_treasury),
        (&ctx.accounts.liquidity_quote, &ctx.accounts.protocol_quote, quote_to_protocol),
    ] {
        if amount == 0 {
            continue;
        }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: ctx.accounts.liquidity_authority.to_account_info(),
                },
                &[&seeds],
            ),
            amount,
        )?;
    }

    emit!(PoolFeesClaimed { dao: dao_key, base_to_treasury, quote_to_treasury, base_to_protocol, quote_to_protocol });
    Ok(())
}
