/*
 * Copyright (C) 2025 Spice Finance Inc.
 *
 * This file is part of Z Combinator.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{constants::*, errors::*, state::*, utils::transfer_tokens};

#[event]
pub struct LiquidityAdded {
    pub pool: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    // Only allow the liquidity provider (pool field) 
    #[account(
        address = pool.liquidity_provider @ AmmError::InvalidDepositor,
    )]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [
            POOL_SEED,
            pool.admin.as_ref(),
            pool.mint_a.as_ref(),
            pool.mint_b.as_ref(),
        ],
        bump = pool.bumps.pool,
    )]
    pub pool: Box<Account<'info, PoolAccount>>,

    // Pool reserves
    #[account(
        mut,
        seeds = [
            RESERVE_SEED,
            pool.key().as_ref(),
            pool.mint_a.as_ref(),
        ],
        bump = pool.bumps.reserve_a,
        token::mint = pool.mint_a,
        token::authority = pool,
    )]
    pub reserve_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [
            RESERVE_SEED,
            pool.key().as_ref(),
            pool.mint_b.as_ref(),
        ],
        bump = pool.bumps.reserve_b,
        token::mint = pool.mint_b,
        token::authority = pool,
    )]
    pub reserve_b: Account<'info, TokenAccount>,

    // Depositor token accounts for both mints
    #[account(
        mut,
        token::mint = pool.mint_a,
        token::authority = depositor,
    )]
    pub depositor_token_acc_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pool.mint_b,
        token::authority = depositor,
    )]
    pub depositor_token_acc_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn add_liquidity_handler(
    ctx: Context<AddLiquidity>,
    amount_a: u64,
    amount_b: u64,
) -> Result<()> {
    // Validate amounts are non-zero
    require!(amount_a > 0, AmmError::InvalidAmount);
    require!(amount_b > 0, AmmError::InvalidAmount);

    // LFOwn fork: the market's clock starts when it is funded, not when it was created. A
    // proposal's pools are made at `initialize_proposal` and funded at `launch_proposal`,
    // possibly much later; upstream credited all that waiting to the first observation —
    // an observation anyone could skew — and diluted every proposal that waited toward
    // its starting price.
    if ctx.accounts.reserve_a.amount == 0 && ctx.accounts.reserve_b.amount == 0 {
        let now = Clock::get()?.unix_timestamp;
        let oracle = &mut ctx.accounts.pool.oracle;
        oracle.created_at_unix_time = now;
        oracle.last_update_unix_time = now;
        oracle.cumulative_observations = 0;
        oracle.last_observation = oracle.starting_observation;
    }

    // Transfer tokens from depositor -> reserves
    transfer_tokens(
        ctx.accounts.depositor_token_acc_a.to_account_info(),
        ctx.accounts.reserve_a.to_account_info(),
        ctx.accounts.depositor.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        amount_a,
    )?;
    transfer_tokens(
        ctx.accounts.depositor_token_acc_b.to_account_info(),
        ctx.accounts.reserve_b.to_account_info(),
        ctx.accounts.depositor.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        amount_b,
    )?;

    emit!( LiquidityAdded {
        pool: ctx.accounts.pool.key(),
        amount_a,
        amount_b
    });

    Ok(())
}