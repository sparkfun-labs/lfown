// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
//
// Moves the checkpoint the price guard measures against toward the DAO pool's current
// price, by 1% at most, and 5% in any half hour (see `price_guard.rs`). Anyone may call
// it, once a minute —
// LFOwn's keeper does, every minute, which is also what pulls it back after anyone who
// tried to drag it.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::cp_amm;
use crate::errors::FutarchyError;
use crate::price_guard::{next_checkpoint, spot_sqrt_price, within_drift};
use crate::state::dao::*;

#[event]
pub struct PriceRecorded {
    pub dao: Pubkey,
    pub sqrt_price: u128,
    pub unix_time: i64,
}

#[derive(Accounts)]
pub struct RecordPrice<'info> {
    // Not while a proposal's markets hold half the liquidity: the pool left behind is thin,
    // and a checkpoint walked along it would set the price the liquidity comes back at. The
    // markets' own TWAP sets that instead (`redeem_liquidity`).
    #[account(
        mut,
        seeds = [DAO_SEED, dao.token_mint.as_ref()],
        bump = dao.bump,
        constraint = dao.active_proposal == Pubkey::default() @ FutarchyError::MarketsRunning,
    )]
    pub dao: Box<Account<'info, DAOAccount>>,

    #[account(address = dao.pool @ FutarchyError::InvalidPool)]
    pub pool: AccountLoader<'info, cp_amm::accounts::Pool>,
}

pub fn record_price_handler(ctx: Context<RecordPrice>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let dao = &mut ctx.accounts.dao;
    // The first checkpoint is set by whoever gives the DAO its pool (bootstrap_dao, or the
    // admin attaching a position): a first record taken from spot could be placed anywhere.
    require!(dao.price_checkpoint > 0, FutarchyError::NoPriceCheckpoint);
    require!(now.saturating_sub(dao.price_checkpoint_at) >= CHECKPOINT_INTERVAL, FutarchyError::CheckpointTooRecent);
    if now.saturating_sub(dao.price_anchor_at) >= CHECKPOINT_WINDOW {
        dao.price_anchor = dao.price_checkpoint;
        dao.price_anchor_at = now;
    }
    let step = next_checkpoint(dao.price_checkpoint, spot_sqrt_price(&ctx.accounts.pool)?);
    let sqrt_price = within_drift(dao.price_anchor, step);
    dao.price_checkpoint = sqrt_price;
    dao.price_checkpoint_at = now;
    emit!(PriceRecorded { dao: dao.key(), sqrt_price, unix_time: now });
    Ok(())
}
