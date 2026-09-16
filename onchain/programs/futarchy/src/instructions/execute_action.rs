// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
//
// The only instructions that sign for a DAO's treasury or its mint authority. Anyone can
// call them — the decision was the market's, running it needs nobody's permission — and
// each checks the same three things before it moves anything: the proposal is resolved,
// the option carrying the action is the one that won, and the action has not run yet.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::errors::FutarchyError;
use crate::state::actions::*;
use crate::state::dao::*;
use crate::state::moderator::*;
use crate::state::proposal::*;

/// The action at `action_index`, if its option won and it has not run. Marks it as run.
fn take_winning_action(
    proposal: &ProposalAccount,
    option_actions: &mut OptionActions,
    action_index: u8,
) -> Result<Action> {
    let winning = match proposal.state {
        ProposalState::Resolved(index) => index,
        _ => return err!(FutarchyError::ProposalNotResolved),
    };
    require!(option_actions.option_index == winning, FutarchyError::OptionDidNotWin);
    let i = action_index as usize;
    require!(i < option_actions.actions.len(), FutarchyError::InvalidAction);
    let bit = 1u8 << action_index;
    require!(option_actions.executed & bit == 0, FutarchyError::ActionAlreadyExecuted);
    option_actions.executed |= bit;
    Ok(option_actions.actions[i])
}

#[derive(Accounts)]
pub struct ExecuteTransfer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [PROPOSAL_SEED, proposal.moderator.as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
    )]
    pub proposal: Box<Account<'info, ProposalAccount>>,

    #[account(address = proposal.moderator @ FutarchyError::InvalidDAO)]
    pub moderator: Box<Account<'info, ModeratorAccount>>,

    #[account(
        seeds = [DAO_SEED, moderator.name.as_bytes()],
        bump = dao.bump,
        constraint = dao.moderator == moderator.key() @ FutarchyError::InvalidDAO,
    )]
    pub dao: Box<Account<'info, DAOAccount>>,

    #[account(
        mut,
        seeds = [ACTIONS_SEED, proposal.key().as_ref(), &[option_actions.option_index]],
        bump = option_actions.bump,
        has_one = proposal @ FutarchyError::InvalidAction,
    )]
    pub option_actions: Box<Account<'info, OptionActions>>,

    /// CHECK: the DAO's treasury PDA, checked by seeds; it signs the transfer.
    #[account(seeds = [TREASURY_SEED, dao.key().as_ref()], bump = dao.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = treasury)]
    pub treasury_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: checked against the action in the handler.
    pub recipient: UncheckedAccount<'info>,

    #[account(init_if_needed, payer = payer, associated_token::mint = mint, associated_token::authority = recipient)]
    pub recipient_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn execute_transfer_handler(ctx: Context<ExecuteTransfer>, action_index: u8) -> Result<()> {
    let action = take_winning_action(&ctx.accounts.proposal, &mut ctx.accounts.option_actions, action_index)?;
    let Action::Transfer { mint, amount, recipient } = action else {
        return err!(FutarchyError::InvalidAction);
    };
    require_keys_eq!(mint, ctx.accounts.mint.key(), FutarchyError::InvalidAction);
    require_keys_eq!(recipient, ctx.accounts.recipient.key(), FutarchyError::InvalidAction);

    let dao_key = ctx.accounts.dao.key();
    let seeds: &[&[u8]] = &[TREASURY_SEED, dao_key.as_ref(), &[ctx.accounts.dao.treasury_bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.treasury_token.to_account_info(),
                to: ctx.accounts.recipient_token.to_account_info(),
                authority: ctx.accounts.treasury.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    emit!(ActionExecuted {
        proposal: ctx.accounts.proposal.key(),
        option_index: ctx.accounts.option_actions.option_index,
        action_index,
        action,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteMint<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [PROPOSAL_SEED, proposal.moderator.as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
    )]
    pub proposal: Box<Account<'info, ProposalAccount>>,

    #[account(address = proposal.moderator @ FutarchyError::InvalidDAO)]
    pub moderator: Box<Account<'info, ModeratorAccount>>,

    #[account(
        seeds = [DAO_SEED, moderator.name.as_bytes()],
        bump = dao.bump,
        constraint = dao.moderator == moderator.key() @ FutarchyError::InvalidDAO,
    )]
    pub dao: Box<Account<'info, DAOAccount>>,

    #[account(
        mut,
        seeds = [ACTIONS_SEED, proposal.key().as_ref(), &[option_actions.option_index]],
        bump = option_actions.bump,
        has_one = proposal @ FutarchyError::InvalidAction,
    )]
    pub option_actions: Box<Account<'info, OptionActions>>,

    /// CHECK: the DAO's mint authority PDA, checked by seeds; it signs the mint.
    #[account(seeds = [MINT_AUTHORITY_SEED, dao.key().as_ref()], bump = dao.mint_authority_bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(mut, address = dao.token_mint @ FutarchyError::InvalidMint)]
    pub mint: Box<Account<'info, Mint>>,

    /// CHECK: checked against the action in the handler.
    pub recipient: UncheckedAccount<'info>,

    #[account(init_if_needed, payer = payer, associated_token::mint = mint, associated_token::authority = recipient)]
    pub recipient_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn execute_mint_handler(ctx: Context<ExecuteMint>, action_index: u8) -> Result<()> {
    let action = take_winning_action(&ctx.accounts.proposal, &mut ctx.accounts.option_actions, action_index)?;
    let Action::MintTo { amount, recipient } = action else {
        return err!(FutarchyError::InvalidAction);
    };
    require_keys_eq!(recipient, ctx.accounts.recipient.key(), FutarchyError::InvalidAction);

    let dao_key = ctx.accounts.dao.key();
    let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, dao_key.as_ref(), &[ctx.accounts.dao.mint_authority_bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.recipient_token.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    emit!(ActionExecuted {
        proposal: ctx.accounts.proposal.key(),
        option_index: ctx.accounts.option_actions.option_index,
        action_index,
        action,
    });
    Ok(())
}
