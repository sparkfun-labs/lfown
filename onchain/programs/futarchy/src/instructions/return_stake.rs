// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
//
// Gives a proposer their stake back once the proposal is decided, whatever it decided:
// the stake is there to make proposing cost something while the DAO's liquidity sits in
// the markets, not to punish a proposal the market turned down. Anyone may call it; the
// tokens and the escrow's rent can only go to the proposer.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::errors::FutarchyError;
use crate::state::proposal::*;

#[event]
pub struct StakeReturned {
    pub proposal: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}

#[derive(Accounts)]
pub struct ReturnStake<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.moderator.as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
        constraint = matches!(proposal.state, ProposalState::Resolved(_)) @ FutarchyError::ProposalNotResolved,
    )]
    pub proposal: Box<Account<'info, ProposalAccount>>,

    #[account(
        mut,
        seeds = [STAKE_SEED, proposal.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = proposal,
    )]
    pub stake_escrow: Box<Account<'info, TokenAccount>>,

    /// CHECK: the proposer; receives the stake and the escrow's rent.
    #[account(mut, address = proposal.creator @ FutarchyError::Unauthorized)]
    pub creator: UncheckedAccount<'info>,

    #[account(address = proposal.base_mint @ FutarchyError::InvalidMint)]
    pub token_mint: Box<Account<'info, Mint>>,

    #[account(init_if_needed, payer = payer, associated_token::mint = token_mint, associated_token::authority = creator)]
    pub creator_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn return_stake_handler(ctx: Context<ReturnStake>) -> Result<()> {
    let proposal = &ctx.accounts.proposal;
    let id = proposal.id.to_le_bytes();
    let bump = [proposal.bump];
    let seeds: [&[u8]; 4] = [PROPOSAL_SEED, proposal.moderator.as_ref(), &id, &bump];
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
                &[&seeds],
            ),
            amount,
        )?;
    }
    // Closed, so the same stake can never be returned twice.
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.stake_escrow.to_account_info(),
            destination: ctx.accounts.creator.to_account_info(),
            authority: ctx.accounts.proposal.to_account_info(),
        },
        &[&seeds],
    ))?;

    let proposal = &mut ctx.accounts.proposal;
    proposal.stake = 0;
    emit!(StakeReturned { proposal: proposal.key(), creator: proposal.creator, amount });
    Ok(())
}
