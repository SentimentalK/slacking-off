//! Deterministic pseudo-randomness. The core takes the seed as an argument; it
//! never reads a clock or a global RNG (design §12).

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// SplitMix64.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, bound: u64) -> u64 {
        debug_assert!(bound > 0);
        self.next_u64() % bound
    }
}

/// Fisher-Yates shuffle driven by `seed` (design §3 settlement order).
pub fn shuffle<T>(items: &mut [T], seed: u64) {
    if items.len() < 2 {
        return;
    }
    let mut rng = Rng::new(seed);
    for i in (1..items.len()).rev() {
        let j = rng.below(i as u64 + 1) as usize;
        items.swap(i, j);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shuffle_is_deterministic_and_permutational() {
        let mut a: Vec<u32> = (0..16).collect();
        let mut b = a.clone();
        shuffle(&mut a, 7);
        shuffle(&mut b, 7);
        assert_eq!(a, b, "same seed, same order");
        let mut sorted = a.clone();
        sorted.sort_unstable();
        assert_eq!(
            sorted,
            (0..16).collect::<Vec<_>>(),
            "nothing lost or duplicated"
        );

        let mut c: Vec<u32> = (0..16).collect();
        shuffle(&mut c, 8);
        assert_ne!(a, c, "a different seed changes the order");
    }
}
