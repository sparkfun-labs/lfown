use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::*,
    errors::*,
    state::PoolAccount,
    utils::{transfer_signed, transfer_tokens},
    PoolState,
};

#[event]
pub struct CondSwap {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub swap_a_to_b: bool,
    pub input_amount: u64,
    pub output_amount: u64,
    pub fee_amount: u64,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [
            POOL_SEED,
            pool.admin.as_ref(),
            pool.mint_a.as_ref(),
            pool.mint_b.as_ref(),
        ],
        bump = pool.bumps.pool,
        constraint = pool.state == PoolState::Trading @ AmmError::InvalidState
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

    /// Fee vault with hardcoded fee authority wallet
    #[account(
        mut,
        seeds = [
            FEE_VAULT_SEED,
            pool.key().as_ref(),
        ],
        bump = pool.bumps.fee_vault,
    )]
    pub fee_vault: Account<'info, TokenAccount>,

    // Trader accounts
    #[account(
        mut,
        token::mint = pool.mint_a,
        token::authority = trader,
    )]
    pub trader_account_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pool.mint_b,
        token::authority = trader,
    )]
    pub trader_account_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

impl<'info> Swap<'info> {
    /// Constant product invariant: k = reserve_a * reserve_b
    pub fn invariant(reserve_a: u128, reserve_b: u128) -> Result<u128> {
        reserve_a
            .checked_mul(reserve_b)
            .ok_or(AmmError::MathOverflow.into())
    }

    /// AMM output formula: output = (input * reserve_out) / (reserve_in + input)
    pub fn compute_output(input: u64, reserve_in: u64, reserve_out: u64) -> Result<u64> {
        let numerator = (input as u128)
            .checked_mul(reserve_out as u128)
            .ok_or(AmmError::MathOverflow)?;
        let denominator = (reserve_in as u128)
            .checked_add(input as u128)
            .ok_or(AmmError::MathOverflow)?;
        let output = numerator
            .checked_div(denominator)
            .ok_or(AmmError::MathOverflow)?
            .try_into()
            .map_err(|_| AmmError::MathOverflow)?;
        Ok(output)
    }
}

pub fn swap_handler(
    ctx: Context<Swap>,
    swap_a_to_b: bool,
    input_amount: u64,
    min_output_amount: u64,
) -> Result<()> {
    require!(input_amount > 0, AmmError::InvalidAmount);

    // LFOwn fork: the pool's own reserves (see PoolAccount), and no trading once the
    // market's window is over: its TWAP has stopped counting.
    let reserve_a = ctx.accounts.pool.reserve_a;
    let reserve_b = ctx.accounts.pool.reserve_b;
    let fee_bps = ctx.accounts.pool.fee as u64;
    require!(!ctx.accounts.pool.oracle.ended(Clock::get()?.unix_timestamp), AmmError::TradingEnded);

    // Crank TWAP oracle, on the reserves before this swap
    ctx.accounts.pool.oracle.crank_twap(reserve_a, reserve_b)?;

    // Prevent swaps on empty pool
    require!(reserve_a > 0 && reserve_b > 0, AmmError::EmptyPool);

    // Store invariant before swap
    let invariant_before = Swap::invariant(reserve_a as u128, reserve_b as u128)?;

    // Calculate fee and output based on swap direction
    // Fee is always collected in token A
    let (input_to_reserve, output_to_user, fee_amount) = if swap_a_to_b {
        // A -> B: fee on input (A), then swap
        let mut fee = (input_amount as u128)
            .checked_mul(fee_bps as u128)
            .ok_or(AmmError::MathOverflow)?
            .checked_div(10000)
            .ok_or(AmmError::MathOverflow)? as u64;

        // Prevent dust swaps from avoiding fees via integer truncation
        if fee_bps > 0 && fee == 0 {
            fee = 1;
        }

        let taxed_input = input_amount
            .checked_sub(fee)
            .ok_or(AmmError::MathUnderflow)?;

        let out = Swap::compute_output(taxed_input, reserve_a, reserve_b)?;
        require!(reserve_b >= out, AmmError::InsufficientReserve);

        (taxed_input, out, fee)
    } else {
        // B -> A: swap first, then fee on output (A)
        let gross_output = Swap::compute_output(input_amount, reserve_b, reserve_a)?;
        require!(reserve_a >= gross_output, AmmError::InsufficientReserve);

        let mut fee = (gross_output as u128)
            .checked_mul(fee_bps as u128)
            .ok_or(AmmError::MathOverflow)?
            .checked_div(10000)
            .ok_or(AmmError::MathOverflow)? as u64;
        // Prevent dust swaps from avoiding fees via integer truncation
        if fee_bps > 0 && fee == 0 {
            fee = 1;
        }
        let net_output = gross_output
            .checked_sub(fee)
            .ok_or(AmmError::MathUnderflow)?;

        (input_amount, net_output, fee)
    };

    // Slippage check
    require!(output_to_user >= min_output_amount, AmmError::SlippageExceeded);

    // Ensure output is non-zero
    // We allow user to disregard slippage (min_output_amount = 0), but a swap with no output should still be invalid
    require!(output_to_user > 0, AmmError::OutputTooSmall);


    // Build pool signer seeds
    let pool = &ctx.accounts.pool;
    let seeds = &[
        POOL_SEED,
        pool.admin.as_ref(),
        pool.mint_a.as_ref(),
        pool.mint_b.as_ref(),
        &[pool.bumps.pool],
    ];
    let signer_seeds = &[&seeds[..]];

    if swap_a_to_b {
        // A -> B
        // 1. Transfer input A (minus fee) to reserve
        transfer_tokens(
            ctx.accounts.trader_account_a.to_account_info(),
            ctx.accounts.reserve_a.to_account_info(),
            ctx.accounts.trader.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            input_to_reserve,
        )?;
        // 2. Transfer fee to fee vault (skip if zero)
        if fee_amount > 0 {
            transfer_tokens(
                ctx.accounts.trader_account_a.to_account_info(),
                ctx.accounts.fee_vault.to_account_info(),
                ctx.accounts.trader.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                fee_amount,
            )?;
        }
        // 3. Transfer output B to trader
        transfer_signed(
            ctx.accounts.reserve_b.to_account_info(),
            ctx.accounts.trader_account_b.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            output_to_user,
            signer_seeds,
        )?;
    } else {
        // B -> A
        // 1. Transfer input B to reserve
        transfer_tokens(
            ctx.accounts.trader_account_b.to_account_info(),
            ctx.accounts.reserve_b.to_account_info(),
            ctx.accounts.trader.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            input_to_reserve,
        )?;
        // 2. Transfer output A to trader
        transfer_signed(
            ctx.accounts.reserve_a.to_account_info(),
            ctx.accounts.trader_account_a.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            output_to_user,
            signer_seeds,
        )?;
        // 3. Transfer fee from reserve A to fee vault (skip if zero)
        if fee_amount > 0 {
            transfer_signed(
                ctx.accounts.reserve_a.to_account_info(),
                ctx.accounts.fee_vault.to_account_info(),
                ctx.accounts.pool.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                fee_amount,
                signer_seeds,
            )?;
        }
    }

    // The pool's count follows the swap: A -> B adds the taxed input to A and takes the
    // output from B; B -> A adds the input to B and takes the output and its fee from A.
    let pool = &mut ctx.accounts.pool;
    if swap_a_to_b {
        pool.reserve_a = reserve_a.checked_add(input_to_reserve).ok_or(AmmError::MathOverflow)?;
        pool.reserve_b = reserve_b.checked_sub(output_to_user).ok_or(AmmError::MathUnderflow)?;
    } else {
        pool.reserve_b = reserve_b.checked_add(input_to_reserve).ok_or(AmmError::MathOverflow)?;
        pool.reserve_a = reserve_a
            .checked_sub(output_to_user)
            .and_then(|a| a.checked_sub(fee_amount))
            .ok_or(AmmError::MathUnderflow)?;
    }
    let invariant_after = Swap::invariant(pool.reserve_a as u128, pool.reserve_b as u128)?;
    require!(
        invariant_after >= invariant_before,
        AmmError::InvariantViolated
    );

    emit!(CondSwap {
        pool: ctx.accounts.pool.key(),
        trader: ctx.accounts.trader.key(),
        swap_a_to_b,
        input_amount,
        output_amount: output_to_user,
        fee_amount,
    });

    Ok(())
}
