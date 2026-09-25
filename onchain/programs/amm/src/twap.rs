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
            self.starting_observation = (reserves_a as u128).saturating_mul(PRICE_SCALE) / reserves_b as u128;
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

        // Clamp observation movement toward price
        let new_obs = curr_price
            .max(prev_obs.saturating_sub(delta))
            .min(prev_obs.saturating_add(delta));

        // Accumulate weighted observation after warmup
        let warmup_end = self
            .created_at_unix_time
            .checked_add(self.warmup_duration as i64)
            .ok_or(AmmError::MathOverflow)?;

        if now > warmup_end {
            let base_time = self.last_update_unix_time.max(warmup_end);

            // Should never panic since now > warmup_end here
            let elapsed: u128 = (now - base_time).try_into().unwrap();

            self.cumulative_observations = self
                .cumulative_observations
                .wrapping_add(prev_obs.saturating_mul(elapsed));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_market_priced_at_zero_reads_a_twap_of_zero() {
        let mut oracle = TwapOracle::new(0, 0, 1, 0, 3_600);
        oracle.last_update_unix_time = 600;
        assert_eq!(oracle.fetch_twap().unwrap(), 0);
    }
}
