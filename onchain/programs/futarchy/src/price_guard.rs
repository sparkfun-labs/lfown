// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
//
// A price the DAO's liquidity can be moved at.
//
// Every move of the DAO's liquidity happens at the pool's spot price: taking a share out
// for a proposal's markets, putting it back afterwards, and opening a market's TWAP at
// the price the pool shows. Spot is what a sandwich controls: push the price, let the DAO
// deposit or withdraw at it, push it back, keep the difference. `return_liquidity` is open
// to anyone, so the attacker could even trigger the deposit themselves, in one bundle.
//
// So spot has to agree with a checkpoint, and the checkpoint cannot be moved quickly.
// `record_price` (anyone, at most once a minute) moves it toward the pool's price by at
// most 1%, however far that price is. A price pushed and pulled back inside a transaction
// shifts it by 1% at most; shifting it 5% takes five such transactions a minute apart, one
// per minute, each one paid for against the pool — and every honest update in between
// pulls it back. The guard then accepts a spot price within 5% of a checkpoint no older
// than half an hour.
//
// A second bound caps how far it moves in any half hour, from where it stood when that
// half hour began: whoever takes every minute's update — and there is one per minute, for
// everyone — drifts it 5% at most per half hour, however many minutes they win.
//
// (The first version recorded the spot price outright and asked it to be a minute old:
// pushing the price, recording, and pulling it back in one transaction, then doing the
// same a minute later around the move itself, beat it. Clamping the step is what closes
// that: no single transaction can place the checkpoint anywhere.)

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::cp_amm;
use crate::errors::FutarchyError;
use crate::liquidity::U256;
use crate::state::dao::DAOAccount;

/// The amm's price scale: an observation is `quote / base · 10^12`, in base units.
const OBSERVATION_SCALE: u128 = 1_000_000_000_000;

/// The pool's square-root price, Q64.64, token B (the quote coin) per token A.
pub fn spot_sqrt_price(pool: &AccountLoader<cp_amm::accounts::Pool>) -> Result<u128> {
    Ok(pool.load()?.sqrt_price)
}

/// Whether `sqrt_price` may be used now, against the DAO's recorded checkpoint.
pub fn check_fair_price(dao: &DAOAccount, sqrt_price: u128, now: i64) -> Result<()> {
    let checkpoint = dao.price_checkpoint;
    let age = now.saturating_sub(dao.price_checkpoint_at);
    require!(checkpoint > 0 && age <= CHECKPOINT_MAX_AGE, FutarchyError::NoPriceCheckpoint);
    require!(within_band(sqrt_price, checkpoint), FutarchyError::PriceMovedTooFar);
    Ok(())
}

/// The next checkpoint: `spot`, but no further than `MAX_CHECKPOINT_STEP_BPS` (in price)
/// from `previous`. Square roots move by half as many basis points as prices, near enough.
pub fn next_checkpoint(previous: u128, spot: u128) -> u128 {
    if previous == 0 {
        return spot;
    }
    let step = previous / 20_000 * MAX_CHECKPOINT_STEP_BPS as u128;
    spot.clamp(previous.saturating_sub(step), previous.saturating_add(step))
}

/// The next checkpoint after `next_checkpoint`, held within `MAX_CHECKPOINT_DRIFT_BPS`
/// (in price) of the window's `anchor`.
pub fn within_drift(anchor: u128, next: u128) -> u128 {
    let drift = anchor / 20_000 * MAX_CHECKPOINT_DRIFT_BPS as u128;
    next.clamp(anchor.saturating_sub(drift), anchor.saturating_add(drift))
}

/// Whether the price `spot²` is within `MAX_PRICE_MOVE_BPS` of `checkpoint²`. Compared
/// squared, so the band is on the price itself rather than on its square root.
pub fn within_band(spot: u128, checkpoint: u128) -> bool {
    let spot2 = U256::from(spot) * U256::from(spot) * U256::from(10_000u32);
    let check2 = U256::from(checkpoint) * U256::from(checkpoint);
    let lo = check2 * U256::from(10_000u32 - MAX_PRICE_MOVE_BPS as u32);
    let hi = check2 * U256::from(10_000u32 + MAX_PRICE_MOVE_BPS as u32);
    spot2 >= lo && spot2 <= hi
}

/// The amm observation for a pool at `sqrt_price`: (√p)² / 2¹²⁸ · 10¹², the same units
/// `crank_twap` reads out of a market's reserves.
pub fn observation_for(sqrt_price: u128) -> u128 {
    let scaled = U256::from(sqrt_price) * U256::from(sqrt_price) * U256::from(OBSERVATION_SCALE);
    let observation = scaled >> 128;
    if observation > U256::from(u128::MAX) { u128::MAX } else { observation.low_u128() }
}

/// The square-root price, Q64.64, for an amm observation: the inverse of `observation_for`.
pub fn sqrt_price_for(observation: u128) -> u128 {
    let scaled = (U256::from(observation) << 128) / U256::from(OBSERVATION_SCALE);
    let root = scaled.integer_sqrt();
    if root > U256::from(u128::MAX) { u128::MAX } else { root.low_u128() }
}

/// How far an observation may move per update: `bps` of where the market opened, and
/// never less than one unit, or the TWAP could not move at all.
pub fn max_observation_delta(starting_observation: u128, bps: u16) -> u128 {
    (starting_observation / 10_000 * bps as u128).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: u128 = 1u128 << 64; // √1 in Q64.64

    #[test]
    fn a_price_of_one_is_an_observation_of_one() {
        assert_eq!(observation_for(ONE), OBSERVATION_SCALE);
    }

    #[test]
    fn the_band_is_five_percent_of_the_price() {
        // √1.049 and √1.051 around √1
        let up_ok = (ONE as f64 * 1.049f64.sqrt()) as u128;
        let up_bad = (ONE as f64 * 1.051f64.sqrt()) as u128;
        let down_ok = (ONE as f64 * 0.951f64.sqrt()) as u128;
        let down_bad = (ONE as f64 * 0.949f64.sqrt()) as u128;
        assert!(within_band(up_ok, ONE));
        assert!(!within_band(up_bad, ONE));
        assert!(within_band(down_ok, ONE));
        assert!(!within_band(down_bad, ONE));
    }

    #[test]
    fn a_checkpoint_moves_one_percent_at_most() {
        let up = next_checkpoint(ONE, ONE * 2);
        let price = |s: u128| (s as f64 / ONE as f64).powi(2);
        assert!((price(up) - 1.01).abs() < 0.0002, "{}", price(up));
        let down = next_checkpoint(ONE, ONE / 2);
        assert!((price(down) - 0.99).abs() < 0.0002, "{}", price(down));
        assert_eq!(next_checkpoint(ONE, ONE + 5), ONE + 5, "a small move is taken whole");
        assert_eq!(next_checkpoint(0, ONE), ONE, "the first one is the price");
    }

    #[test]
    fn a_sqrt_price_and_its_observation_round_trip() {
        for sqrt in [ONE, ONE / 3, ONE * 7] {
            let back = sqrt_price_for(observation_for(sqrt));
            assert!(back.abs_diff(sqrt) * 1_000_000 < sqrt, "{sqrt} -> {back}");
        }
    }

    #[test]
    fn a_window_drifts_five_percent_at_most() {
        let price = |s: u128| (s as f64 / ONE as f64).powi(2);
        let mut checkpoint = ONE;
        for _ in 0..30 {
            checkpoint = within_drift(ONE, next_checkpoint(checkpoint, ONE * 2));
        }
        assert!((price(checkpoint) - 1.05).abs() < 0.001, "{}", price(checkpoint));
    }

    #[test]
    fn the_extremes_of_damm_prices_do_not_overflow() {
        assert!(within_band(DAMM_MAX_SQRT_PRICE, DAMM_MAX_SQRT_PRICE));
        assert!(within_band(DAMM_MIN_SQRT_PRICE, DAMM_MIN_SQRT_PRICE));
        let _ = observation_for(DAMM_MAX_SQRT_PRICE);
        assert_eq!(max_observation_delta(0, 500), 1);
    }
}
