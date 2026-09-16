// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
//
// Concentrated-liquidity arithmetic for returning tokens to a Meteora DAMM v2 pool,
// written here from the standard formulas rather than taken from Meteora's source, which
// is under a noncommercial licence.
//
// Prices are square roots in Q64.64. For liquidity L in the range [lo, hi] at price p:
//
//   amount_a = L · (hi − p) / (p · hi)
//   amount_b = L · (p − lo) / 2^128
//
// so the most liquidity that `a` and `b` can fund is the smaller of
//
//   L_a = a · (p · hi / (hi − p))      L_b = b · 2^128 / (p − lo)
//
// L_a is taken in that order so every intermediate fits 256 bits: p · hi is at most 2^192,
// and a times the quotient at most 2^160. Dividing before the last multiplication can only
// round the liquidity down, which is the safe direction.
//
// Everything rounds toward the pool: liquidity down, and the pool rounds the amounts it
// asks for up, so a deposit sized this way never asks for more than it was given.

use uint::construct_uint;

construct_uint! {
    /// 256 bits: every intermediate below stays within it. (512 bits would too, but its
    /// generated code overflows a Solana program's 4 KB stack frame.)
    pub struct U256(4);
}

/// The liquidity `amount_a` of token A and `amount_b` of token B can fund at `sqrt_price`,
/// or `None` when that is nothing — including when the price sits on the edge of the range,
/// where one side cannot be deposited at all.
pub fn liquidity_for_amounts(
    amount_a: u64,
    amount_b: u64,
    sqrt_price: u128,
    sqrt_min_price: u128,
    sqrt_max_price: u128,
) -> Option<u128> {
    if !(sqrt_min_price < sqrt_price && sqrt_price < sqrt_max_price) {
        return None;
    }
    let p = U256::from(sqrt_price);
    let lo = U256::from(sqrt_min_price);
    let hi = U256::from(sqrt_max_price);

    let from_a = U256::from(amount_a) * (p * hi / (hi - p));
    let from_b = (U256::from(amount_b) << 128) / (p - lo);
    let liquidity = from_a.min(from_b);

    // One unit below the exact figure, so the pool's own rounding can never tip a deposit
    // over the amounts on hand.
    if liquidity <= U256::one() {
        return None;
    }
    let liquidity = liquidity - U256::one();
    Some(if liquidity > U256::from(u128::MAX) { u128::MAX } else { liquidity.low_u128() })
}

/// What the pool will ask for to add `liquidity`, rounded up as the pool rounds it.
pub fn amounts_for_liquidity(
    liquidity: u128,
    sqrt_price: u128,
    sqrt_min_price: u128,
    sqrt_max_price: u128,
) -> (u128, u128) {
    let l = U256::from(liquidity);
    let p = U256::from(sqrt_price);
    let lo = U256::from(sqrt_min_price);
    let hi = U256::from(sqrt_max_price);
    let ceil_div = |n: U256, d: U256| (n + d - U256::one()) / d;
    let a = ceil_div(l * (hi - p), p * hi);
    let b = ceil_div(l * (p - lo), U256::one() << 128);
    (a.low_u128(), b.low_u128())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Meteora DAMM v2's full-range bounds.
    const MIN: u128 = 4_295_048_016;
    const MAX: u128 = 79_226_673_521_066_979_257_578_248_091;

    /// √(b/a) in Q64.64, for a price given as b per a.
    fn sqrt_price(b_per_a: f64) -> u128 {
        (b_per_a.sqrt() * 18_446_744_073_709_551_616f64) as u128
    }

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 11
        }
    }

    fn check(a: u64, b: u64, p: u128) {
        let Some(l) = liquidity_for_amounts(a, b, p, MIN, MAX) else { return };
        let (need_a, need_b) = amounts_for_liquidity(l, p, MIN, MAX);
        assert!(need_a <= a as u128, "asked {need_a} of A with {a} on hand");
        assert!(need_b <= b as u128, "asked {need_b} of B with {b} on hand");
        // And it is the most it can be: one side is used almost entirely.
        let used_a = need_a as f64 / a.max(1) as f64;
        let used_b = need_b as f64 / b.max(1) as f64;
        assert!(used_a.max(used_b) > 0.999, "left most of both sides unused: a {used_a}, b {used_b}");
    }

    #[test]
    fn a_launch_sized_deposit_fits_exactly() {
        // 8M tokens and 4,000 of the quote coin: 0.0005 quote per token.
        check(8_000_000_000_000, 4_000_000_000, sqrt_price(0.0005));
    }

    #[test]
    fn a_lopsided_deposit_uses_one_side_and_keeps_the_rest() {
        let p = sqrt_price(0.0005);
        let l = liquidity_for_amounts(8_000_000_000_000, 10_000_000_000, p, MIN, MAX).unwrap();
        let (a, b) = amounts_for_liquidity(l, p, MIN, MAX);
        assert!(a <= 8_000_000_000_000 && a > 7_999_000_000_000, "token side nearly all used: {a}");
        assert!(b < 4_100_000_000, "quote side only what the price needs: {b}");
    }

    #[test]
    fn nothing_to_deposit_is_none() {
        assert_eq!(liquidity_for_amounts(0, 0, sqrt_price(1.0), MIN, MAX), None);
        assert_eq!(liquidity_for_amounts(1_000, 0, sqrt_price(1.0), MIN, MAX), None);
        assert_eq!(liquidity_for_amounts(1_000, 1_000, MIN, MIN, MAX), None, "price on the lower edge");
    }

    #[test]
    fn random_deposits_never_ask_for_more_than_is_on_hand() {
        let mut rng = Lcg(0xfee5);
        for _ in 0..20_000 {
            let a = 1 + rng.next() % 50_000_000_000_000;
            let b = 1 + rng.next() % 50_000_000_000;
            let price = 10f64.powf(-9.0 + (rng.next() % 1_200) as f64 / 100.0); // 1e-9 .. 1e3
            check(a, b, sqrt_price(price));
        }
    }

    #[test]
    fn extreme_amounts_and_prices_do_not_overflow() {
        check(u64::MAX, u64::MAX, MAX - 1);
        check(u64::MAX, u64::MAX, MIN + 1);
        check(u64::MAX, 1, sqrt_price(1.0));
    }
}
