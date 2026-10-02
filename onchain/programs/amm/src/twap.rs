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
use crate::errors::AmmError;
use std::cmp::Ordering;

const PRICE_SCALE: u128 = 1_000_000_000_000_u128;
const MIN_RECORDING_INTERVAL: i64 = 60;

#[event]
pub struct TWAPUpdate {
    pub unix_time: i64,
    pub price: u128,
    pub observation: u128,
    pub cumulative_observations: u128,
    pub twap: u128,
}

/// TWAP oracle that tracks time-weighted average prices with manipulation resistance.
///
/// Observations are rate-limited to prevent flash loan and single-block attacks.
/// The cumulative_observations field accumulates (observation * time_elapsed) which
/// can be divided by total time to get the TWAP.
#[derive(Clone, AnchorDeserialize, AnchorSerialize, InitSpace)]
pub struct TwapOracle {
    /// Running sum of (observation * seconds_elapsed) used for TWAP calculation.
    /// On overflow, wraps back to 0 - clients should handle this edge case.
    pub cumulative_observations: u128,
    /// Unix timestamp of the most recent price recording
    pub last_update_unix_time: i64,
    /// Unix timestamp when this oracle was initialized
    pub created_at_unix_time: i64,
    /// Most recent raw price from pool reserves (reserves_a / reserves_b * PRICE_SCALE)
    pub last_price: u128,
    /// Rate-limited observation that moves toward price bounded by max_observation_delta
    pub last_observation: u128,
    /// Maximum amount observation can change per crank (manipulation resistance)
    pub max_observation_delta: u128,
    /// Initial value for last_observation when oracle is created
    pub starting_observation: u128,
    /// Seconds after creation before TWAP accumulation begins
    pub warmup_duration: u32,
    /// Minimum time in-between TWAP recordings
    pub min_recording_interval: i64,
    /// LFOwn fork: how long the market trades once funded (0: no end)
    pub trading_duration: u32,
    /// LFOwn fork: when the market stops trading and the TWAP stops counting (0: no end).
    /// Set when the market is funded.
    pub end_unix_time: i64,
}

impl TwapOracle {
    pub fn new(
        timestamp: i64,
        starting_observation: u128,
        max_observation_delta: u128,
        warmup_duration: u32,
        trading_duration: u32,
    ) -> Self {
        Self {
            trading_duration,
            end_unix_time: 0,
            created_at_unix_time: timestamp,
            last_update_unix_time: timestamp,
            last_price: 0,
            last_observation: starting_observation,
            cumulative_observations: 0,
            max_observation_delta,
            starting_observation,
            warmup_duration,
            min_recording_interval: MIN_RECORDING_INTERVAL,
        }
    }

    /// LFOwn fork: restarts the clock when the market is funded, at the price it is funded
    /// at, and sets when it ends. The proposal was created at an earlier price, perhaps
    /// much earlier; the funding amounts are the pool's price as the DAO's guard let it
    /// out.
    pub fn start(&mut self, now: i64, reserves_a: u64, reserves_b: u64) {
        if reserves_b > 0 {
            let opening = (reserves_a as u128).saturating_mul(PRICE_SCALE) / reserves_b as u128;
            // The per-interval move was sized against the price the proposal was created at:
            // keep it the same share of the price the market actually opens at.
            if self.starting_observation > 0 && opening > 0 {
                self.max_observation_delta = self
                    .max_observation_delta
                    .saturating_mul(opening)
                    .checked_div(self.starting_observation)
                    .unwrap_or(self.max_observation_delta)
                    .max(1);
            }
            self.starting_observation = opening;
        }
        self.created_at_unix_time = now;
        self.last_update_unix_time = now;
        self.cumulative_observations = 0;
        self.last_observation = self.starting_observation;
        self.end_unix_time = if self.trading_duration == 0 { 0 } else { now.saturating_add(self.trading_duration as i64) };
    }

    /// Whether the market's trading window is over.
    pub fn ended(&self, now: i64) -> bool {
        self.end_unix_time != 0 && now >= self.end_unix_time
    }

    /// Records a new price sample and updates the TWAP accumulator.
    /// Returns the current TWAP
    ///
    /// LFOwn fork: each interval is credited with the observation that held *during* it —
    /// the one recorded at its start — and the new sample only counts from now on. Upstream
    /// credited the whole interval with the sample taken at its end, so one sample, taken
    /// after a quiet day, decided the whole day. Time stops at the market's end.
    pub fn crank_twap(&mut self, reserves_a: u64, reserves_b: u64) -> Result<u128> {
        let clock = Clock::get()?;
        let now = if self.end_unix_time != 0 { clock.unix_timestamp.min(self.end_unix_time) } else { clock.unix_timestamp };

        // Early exit: rate limit or no liquidity
        if now < self.last_update_unix_time + self.min_recording_interval
            || reserves_a == 0
            || reserves_b == 0
        {
            return self.fetch_twap();
        }

        let curr_price = (reserves_a as u128)
            .saturating_mul(PRICE_SCALE)
            .checked_div(reserves_b as u128)
            .ok_or(AmmError::MathOverflow)?;

        let prev_obs = self.last_observation;
        let delta = self.max_observation_delta;
        let interval = self.min_recording_interval.max(1) as u128;
        let last = self.last_update_unix_time;
        let since_last: u128 = (now - last).try_into().map_err(|_| AmmError::MathOverflow)?;

        // LFOwn fork: the intervals nobody cranked are caught up. Across them the observation
        // moves toward today's price by at most `delta` an interval, as if someone had cranked
        // each one, and the TWAP is credited with that path. Upstream credited the whole gap
        // at the last observation however old: pump, crank once, leave, and the pumped value
        // counted until the market closed. A market's safety must not depend on a keeper.
        let new_obs = observation_after(prev_obs, curr_price, delta, since_last / interval);

        // Accumulate after warmup: the path's integral over the part of the gap past it.
        let warmup_end = self
            .created_at_unix_time
            .checked_add(self.warmup_duration as i64)
            .ok_or(AmmError::MathOverflow)?;

        if now > warmup_end {
            let counted_from: u128 = (last.max(warmup_end) - last).try_into().map_err(|_| AmmError::MathOverflow)?;
            let credited = path_integral(prev_obs, curr_price, delta, interval, since_last)
                .saturating_sub(path_integral(prev_obs, curr_price, delta, interval, counted_from));
            self.cumulative_observations = self.cumulative_observations.wrapping_add(credited);
        }

        // Commit state
        self.last_update_unix_time = now;
        self.last_price = curr_price;
        self.last_observation = new_obs;

        // Invariant: obs is bounded by [min(price, prev_obs), max(price, prev_obs)]
        match curr_price.cmp(&prev_obs) {
            Ordering::Greater => {
                require_gte!(new_obs, prev_obs);
                require_gte!(curr_price, new_obs);
            }
            Ordering::Less => {
                require_gte!(prev_obs, new_obs);
                require_gte!(new_obs, curr_price);
            }
            Ordering::Equal => require_eq!(new_obs, curr_price),
        }

        // Get final twap
        let twap = self.fetch_twap()?;

        emit!(TWAPUpdate {
            unix_time: now,
            price: curr_price,
            observation: new_obs,
            cumulative_observations: self.cumulative_observations,
            twap: twap
        });

        Ok(twap)
    }

    /// Computes the time-weighted average price
    pub fn fetch_twap(&self) -> Result<u128> {
        let accumulation_start = self
            .created_at_unix_time
            .checked_add(self.warmup_duration as i64)
            .ok_or(AmmError::MathOverflow)?;

        if self.last_update_unix_time <= accumulation_start {
            // Still in warmup
            return Ok(self.starting_observation);
        }
        
        let elapsed = (self.last_update_unix_time - accumulation_start) as u128;

        require_neq!(elapsed, 0);

        // LFOwn fork: a market whose price rounds to zero has a TWAP of zero. Upstream
        // refused it, and with it every crank and every swap on that market.
        Ok(self.cumulative_observations / elapsed)
    }
}

/// The observation `steps` intervals after one at `prev`, each moving toward `target` by
/// `delta` at most.
pub fn observation_after(prev: u128, target: u128, delta: u128, steps: u128) -> u128 {
    let travel = delta.saturating_mul(steps);
    if target >= prev {
        prev.saturating_add(travel).min(target)
    } else {
        prev.saturating_sub(travel).max(target)
    }
}

/// The integral, over its first `elapsed` seconds, of the observation path starting at
/// `prev` and moving toward `target` by `delta` per `interval`: interval `j` holds
/// `observation_after(prev, target, delta, j)`. In closed form, however long the gap.
pub fn path_integral(prev: u128, target: u128, delta: u128, interval: u128, elapsed: u128) -> u128 {
    let full = elapsed / interval;
    let rest = elapsed % interval;
    let gap = target.abs_diff(prev);
    // Intervals spent moving before reaching the target; the rest sit on it.
    let moving = if delta == 0 { full } else { full.min(gap.div_ceil(delta)) };
    let ramp = delta.saturating_mul(moving.saturating_mul(moving.saturating_sub(1)) / 2);
    let moving_sum = if target >= prev {
        prev.saturating_mul(moving).saturating_add(ramp)
    } else {
        prev.saturating_mul(moving).saturating_sub(ramp)
    };
    let held = if delta == 0 { prev } else { target };
    let sum = moving_sum.saturating_add(held.saturating_mul(full - moving));
    sum.saturating_mul(interval)
        .saturating_add(observation_after(prev, target, delta, full).saturating_mul(rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gap_is_caught_up_toward_todays_price() {
        // One interval: the old observation for the interval, a step toward the price after.
        assert_eq!(path_integral(100, 200, 10, 60, 60), 100 * 60);
        assert_eq!(observation_after(100, 200, 10, 1), 110);
        // Ten quiet intervals: 100, 110, ... 190, then the price.
        assert_eq!(path_integral(100, 200, 10, 60, 600), (100..200).step_by(10).sum::<u128>() * 60);
        // A long gap: the walk reaches the price and holds there.
        assert_eq!(path_integral(100, 200, 10, 60, 6000), (100..200).step_by(10).sum::<u128>() * 60 + 200 * 60 * 90);
        // Downward, and a part interval at the end.
        assert_eq!(path_integral(200, 100, 50, 60, 150), 200 * 60 + 150 * 60 + 100 * 30);
    }

    #[test]
    fn a_pumped_observation_left_behind_counts_one_interval() {
        // Left one step up at 105 while the price is back at 100: a day of silence credits
        // the 105 for a single interval, not the day.
        let day = 86_400u128;
        let credited = path_integral(105, 100, 5, 60, day);
        assert_eq!(credited, 105 * 60 + 100 * (day - 60));
    }

    #[test]
    fn a_market_priced_at_zero_reads_a_twap_of_zero() {
        let mut oracle = TwapOracle::new(0, 0, 1, 0, 3_600);
        oracle.last_update_unix_time = 600;
        assert_eq!(oracle.fetch_twap().unwrap(), 0);
    }
}
