// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
//
// A proposal that never got its liquidity out is withdrawn, and its stake goes home whole.
// The site opens a proposal in several transactions; if one after the first fails — the
// pool's price moved past the guard, say — the stake would otherwise sit in escrow with
// no way out but a decision that can never come (4th audit, M9). Its creator may cancel it
// any time; anyone may once it has been left in Setup for CANCEL_AFTER_SECONDS.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::constants::CANCEL_AFTER_SECONDS;
use crate::errors::FutarchyError;
use crate::state::proposal::*;

#[event]
pub struct ProposalCancelled {
    pub proposal: Pubkey,
    pub creator: Pubkey,
    pub stake: u64,
}

#[derive(Accounts)]
pub struct CancelProposal<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.moderator.as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.state == ProposalState::Setup @ FutarchyError::InvalidState,
        constraint = proposal.base_liquidity == 0 && proposal.quote_liquidity == 0 @ FutarchyError::LiquidityAlreadyPrepared,
    )]
    pub proposal: Box<Account<'info, ProposalAccount>>,

    #[account(mut, seeds = [STAKE_SEED, proposal.key().as_ref()], bump, token::mint = token_mint, token::authority = proposal)]
    pub stake_escrow: Box<Account<'info, TokenAccount>>,

    /// CHECK: the proposer; receives the stake and the escrow's rent.
    #[account(mut, address = proposal.creator @ FutarchyError::Unauthorized)]
    pub creator: UncheckedAccount<'info>,

    #[account(address = proposal.base_mint @ FutarchyError::InvalidMint)]
    pub token_mint: Box<Account<'info, Mint>>,

    #[account(init_if_needed, payer = signer, associated_token::mint = token_mint, associated_token::authority = creator)]
    pub creator_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn cancel_proposal_handler(ctx: Context<CancelProposal>) -> Result<()> {
    let proposal = &ctx.accounts.proposal;
    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.signer.key() == proposal.creator || now >= proposal.opened_at.saturating_add(CANCEL_AFTER_SECONDS),
        FutarchyError::CancelTooEarly
    );
    let seeds: &[&[u8]] = &[PROPOSAL_SEED, proposal.moderator.as_ref(), &proposal.id.to_le_bytes(), &[proposal.bump]];
    let amount = ctx.accounts.stake_escrow.amount;
    if amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.stake_escrow.to_account_info(),
                    to: ctx.accounts.creator_token.to_account_info(),
                    authority: ctx.accounts.proposal.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
    }
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.stake_escrow.to_account_info(),
            destination: ctx.accounts.creator.to_account_info(),
            authority: ctx.accounts.proposal.to_account_info(),
        },
        &[seeds],
    ))?;
    let proposal = &mut ctx.accounts.proposal;
    proposal.state = ProposalState::Cancelled;
    proposal.stake = 0;
    emit!(ProposalCancelled { proposal: proposal.key(), creator: proposal.creator, stake: amount });
    Ok(())
}
