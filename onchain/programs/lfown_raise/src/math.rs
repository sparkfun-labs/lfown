//! What each backer is owed. Pure arithmetic, so it can be proven on its own.
//!
//! Everyone pays the same price: `goal` USDC for `tokens_for_investors` tokens. When more
//! than `goal` is committed, each backer's commitment is accepted in proportion and the
//! rest comes back to them.
//!
//! The rounding is chosen so the vault can never be short:
//!
//! - tokens round **down**, so the tokens paid out never exceed `tokens_for_investors`;
//! - the accepted USDC rounds **up**, so the accepted amounts add up to at least `goal` —
//!   which means the refunds add up to at most `total - goal`, exactly what is left in the
//!   vault once `goal` has gone to the pool and the treasury.
//!
//! The cost of that guarantee is a few base units of dust per backer left in the vaults.

/// Tokens owed for a commitment of `amount` out of `total` committed.
pub fn tokens_for(amount: u64, total: u64, tokens_for_investors: u64) -> u64 {
    if total == 0 {
        return 0;
    }
    ((amount as u128 * tokens_for_investors as u128) / total as u128) as u64
}

/// The part of a commitment the raise keeps. All of it unless the raise is oversubscribed.
pub fn accepted_for(amount: u64, total: u64, goal: u64) -> u64 {
    if total <= goal {
        return amount;
    }
    let numerator = amount as u128 * goal as u128;
    let accepted = numerator.div_ceil(total as u128);
    // goal < total, so this is never above `amount`; the min is belt and braces.
    (accepted as u64).min(amount)
}

/// What comes back to a backer of a successful raise.
pub fn refund_for(amount: u64, total: u64, goal: u64) -> u64 {
    amount - accepted_for(amount, total, goal)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOAL: u64 = 5_000 * 1_000_000;
    const TOKENS: u64 = 10_000_000 * 1_000_000;

    /// A small deterministic generator: the test must be reproducible, and pulling in a
    /// random crate for it is not worth a dependency.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 11
        }
    }

    fn check(amounts: &[u64]) {
        let total: u64 = amounts.iter().sum();
        assert!(total >= GOAL, "only successful raises pay out");
        let tokens: u128 = amounts.iter().map(|&a| tokens_for(a, total, TOKENS) as u128).sum();
        let accepted: u128 = amounts.iter().map(|&a| accepted_for(a, total, GOAL) as u128).sum();
        let refunds: u128 = amounts.iter().map(|&a| refund_for(a, total, GOAL) as u128).sum();

        assert!(tokens <= TOKENS as u128, "paid {tokens} tokens out of {TOKENS}");
        assert!(accepted >= GOAL as u128, "accepted {accepted}, below the goal");
        assert!(refunds <= (total - GOAL) as u128, "refunds {refunds} exceed what the vault keeps");
        assert_eq!(accepted + refunds, total as u128, "every unit is either accepted or refunded");

        // Dust stays small: at most one base unit per backer on each side.
        assert!(TOKENS as u128 - tokens <= amounts.len() as u128);
        assert!(accepted - GOAL as u128 <= amounts.len() as u128);

        // One price for everyone: what each backer paid and what they got differ from the
        // exact price by at most one base unit of each token. Measured in integers, since
        // a relative tolerance fails for a backer whose accepted share is a few cents —
        // there one base unit is a large fraction and still only one base unit.
        for &a in amounts {
            let paid = accepted_for(a, total, GOAL) as i128;
            let got = tokens_for(a, total, TOKENS) as i128;
            let gap = (paid * TOKENS as i128 - got * GOAL as i128).abs();
            assert!(gap <= TOKENS as i128 + GOAL as i128, "a backer of {a} paid {paid} for {got}: off by more than one unit");
        }
    }

    #[test]
    fn exactly_the_goal_is_all_accepted_and_nothing_refunded() {
        let amounts = [2_000 * 1_000_000, 2_500 * 1_000_000, 500 * 1_000_000];
        check(&amounts);
        for a in amounts {
            assert_eq!(refund_for(a, GOAL, GOAL), 0);
        }
        assert_eq!(tokens_for(2_500 * 1_000_000, GOAL, TOKENS), 5_000_000 * 1_000_000);
    }

    #[test]
    fn oversubscribed_twice_over_keeps_half_of_everyone() {
        let amounts = [6_000 * 1_000_000, 4_000 * 1_000_000];
        check(&amounts);
        assert_eq!(accepted_for(6_000 * 1_000_000, 10_000 * 1_000_000, GOAL), 3_000 * 1_000_000);
        assert_eq!(refund_for(4_000 * 1_000_000, 10_000 * 1_000_000, GOAL), 2_000 * 1_000_000);
        assert_eq!(tokens_for(6_000 * 1_000_000, 10_000 * 1_000_000, TOKENS), 6_000_000 * 1_000_000);
    }

    #[test]
    fn awkward_amounts_never_leave_the_vault_short() {
        // Primes and single base units, where rounding bites hardest.
        check(&[1, 1, 1, GOAL]);
        check(&[3, 7, 11, 13, GOAL + 17]);
        check(&[GOAL / 3, GOAL / 3, GOAL / 3 + 2, 1]);
    }

    #[test]
    fn ten_thousand_random_raises_never_leave_the_vault_short() {
        let mut rng = Lcg(0x5eed);
        for _ in 0..10_000 {
            let backers = 1 + (rng.next() % 300) as usize;
            let mut amounts: Vec<u64> = (0..backers).map(|_| 1 + rng.next() % (3_000 * 1_000_000)).collect();
            let total: u64 = amounts.iter().sum();
            if total < GOAL {
                amounts.push(GOAL - total + rng.next() % 1_000);
            }
            check(&amounts);
        }
    }
}
