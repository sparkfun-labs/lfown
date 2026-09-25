// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
//
// Moves the checkpoint the price guard measures against toward the DAO pool's current
// price, by 1% at most (see `price_guard.rs`). Anyone may call it, once a minute —
// LFOwn's keeper does, every minute, which is also what pulls it back after anyone who
// tried to drag it.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::cp_amm;
use crate::errors::FutarchyError;
use crate::price_guard::{next_checkpoint, spot_sqrt_price};
use crate::state::dao::*;

#[event]
pub struct PriceRecorded {
    pub dao: Pubkey,
    pub sqrt_price: u128,
    pub unix_time: i64,
}

#[derive(Accounts)]
pub struct RecordPrice<'info> {
    #[account(mut, seeds = [DAO_SEED, dao.token_mint.as_ref()], bump = dao.bump)]
    pub dao: Box<Account<'info, DAOAccount>>,

    #[account(address = dao.pool @ FutarchyError::InvalidPool)]
    pub pool: AccountLoader<'info, cp_amm::accounts::Pool>,
}

pub fn record_price_handler(ctx: Context<RecordPrice>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let dao = &mut ctx.accounts.dao;
    require!(
        dao.price_checkpoint == 0 || now.saturating_sub(dao.price_checkpoint_at) >= CHECKPOINT_INTERVAL,
        FutarchyError::CheckpointTooRecent
    );
    let sqrt_price = next_checkpoint(dao.price_checkpoint, spot_sqrt_price(&ctx.accounts.pool)?);
    dao.price_checkpoint = sqrt_price;
    dao.price_checkpoint_at = now;
    emit!(PriceRecorded { dao: dao.key(), sqrt_price, unix_time: now });
    Ok(())
}
