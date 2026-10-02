// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
//
// A proposal's two markets, created once its vault exists. Upstream created them inside
// `initialize_proposal`; with them that instruction made some twenty accounts at addresses
// anyone can derive, and a few lamports sent to each beforehand turned every creating CPI
// into three and ran the transaction past Solana's 64-instruction trace (4th audit, M3).
// Anyone may call it: there is nothing left to choose.
use amm::cpi::accounts::CreatePool;
use amm::program::Amm;
use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::errors::FutarchyError;
use crate::state::dao::{DAOAccount, DAO_SEED};
use crate::state::proposal::*;

#[derive(Accounts)]
pub struct CreateProposalMarkets<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.moderator.as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.state == ProposalState::Setup @ FutarchyError::InvalidState,
        constraint = !proposal.markets_open @ FutarchyError::MarketsAlreadyOpen,
    )]
    pub proposal: Box<Account<'info, ProposalAccount>>,

    #[account(seeds = [DAO_SEED, proposal.base_mint.as_ref()], bump = dao.bump, constraint = dao.moderator == proposal.moderator @ FutarchyError::InvalidDAO)]
    pub dao: Box<Account<'info, DAOAccount>>,

    pub system_program: Program<'info, System>,
    pub amm_program: Program<'info, Amm>,
    pub token_program: Program<'info, Token>,

    // Remaining accounts (in order), per option i in 0..2:
    // cond_quote_mint_i, cond_base_mint_i, pool_i, reserve_a_i, reserve_b_i, fee_vault_i;
    // then the amm's fee authority.
}

pub fn create_proposal_markets_handler<'info>(ctx: Context<'_, '_, 'info, 'info, CreateProposalMarkets<'info>>) -> Result<()> {
    let ra = ctx.remaining_accounts;
    require!(ra.len() == 13, FutarchyError::InvalidRemainingAccounts);
    let proposal = &ctx.accounts.proposal;
    let vault = proposal.vault;
    let seeds: &[&[u8]] = &[PROPOSAL_SEED, proposal.moderator.as_ref(), &proposal.id.to_le_bytes(), &[proposal.bump]];
    // Each market trades, and its TWAP counts, for the proposal's length from the moment
    // it is funded (`launch_proposal`), and not a second past it.
    let trading_seconds = proposal.config.length as u32 * 60;

    for i in 0..2usize {
        let at = i * 6;
        let cmint = |kind: u8| Pubkey::find_program_address(&[b"cmint", vault.as_ref(), &[kind], &[i as u8]], &vault::ID).0;
        // The vault's own conditional mints, and the pool recorded when the proposal opened.
        require_keys_eq!(ra[at].key(), cmint(1), FutarchyError::InvalidAccount);
        require_keys_eq!(ra[at + 1].key(), cmint(0), FutarchyError::InvalidAccount);
        require_keys_eq!(ra[at + 2].key(), proposal.pools[i], FutarchyError::InvalidPools);
        amm::cpi::create_pool(
            CpiContext::new_with_signer(
                ctx.accounts.amm_program.to_account_info(),
                CreatePool {
                    payer: ctx.accounts.payer.to_account_info(),
                    admin: proposal.to_account_info(),
                    mint_a: ra[at].to_account_info(),
                    mint_b: ra[at + 1].to_account_info(),
                    pool: ra[at + 2].to_account_info(),
                    reserve_a: ra[at + 3].to_account_info(),
                    reserve_b: ra[at + 4].to_account_info(),
                    fee_authority: ra[12].to_account_info(),
                    fee_vault: ra[at + 5].to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
                &[seeds],
            ),
            proposal.config.fee,
            proposal.config.starting_observation,
            proposal.config.max_observation_delta,
            proposal.config.warmup_duration,
            trading_seconds,
            Some(ctx.accounts.dao.liquidity_authority),
        )?;
    }
    ctx.accounts.proposal.markets_open = true;
    Ok(())
}
