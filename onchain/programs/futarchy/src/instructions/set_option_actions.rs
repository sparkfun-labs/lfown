// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
use anchor_lang::prelude::*;

use crate::constants::MAX_ACTIONS;
use crate::errors::FutarchyError;
use crate::state::actions::*;
use crate::state::proposal::*;

#[derive(Accounts)]
#[instruction(option_index: u8)]
pub struct SetOptionActions<'info> {
    #[account(mut, address = proposal.creator @ FutarchyError::Unauthorized)]
    pub creator: Signer<'info>,

    // Only before launch: once the markets open, what an option does is fixed.
    #[account(
        seeds = [PROPOSAL_SEED, proposal.moderator.as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.state == ProposalState::Setup @ FutarchyError::InvalidState,
    )]
    pub proposal: Box<Account<'info, ProposalAccount>>,

    #[account(
        init_if_needed,
        payer = creator,
        space = 8 + OptionActions::INIT_SPACE,
        seeds = [ACTIONS_SEED, proposal.key().as_ref(), &[option_index]],
        bump
    )]
    pub option_actions: Box<Account<'info, OptionActions>>,

    pub system_program: Program<'info, System>,
}

pub fn set_option_actions_handler(
    ctx: Context<SetOptionActions>,
    option_index: u8,
    actions: Vec<Action>,
) -> Result<()> {
    // Option 0 is what happens if no alternative beats the status quo: nothing.
    require!(option_index >= 1, FutarchyError::NoActionsOnStatusQuo);
    require!(option_index < ctx.accounts.proposal.num_options, FutarchyError::InvalidOptionIndex);
    require!(actions.len() <= MAX_ACTIONS as usize, FutarchyError::TooManyActions);
    for action in &actions {
        let amount = match action {
            Action::Transfer { amount, .. } | Action::MintTo { amount, .. } => *amount,
        };
        require!(amount > 0, FutarchyError::InvalidAction);
    }

    ctx.accounts.option_actions.set_inner(OptionActions {
        version: OPTION_ACTIONS_VERSION,
        bump: ctx.bumps.option_actions,
        proposal: ctx.accounts.proposal.key(),
        option_index,
        actions: actions.clone(),
        executed: 0,
    });

    emit!(OptionActionsSet { proposal: ctx.accounts.proposal.key(), option_index, actions });
    Ok(())
}
