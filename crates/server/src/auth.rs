//! Account credentials (contract §1): usernames, passwords, account tokens and
//! web-session ids.
//!
//! Passwords are argon2id PHC strings; account tokens and web-session ids are
//! 32 random bytes as lowercase hex, and the database only ever stores
//! `sha256(value)`. Plaintext exists only in the response that created it.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

pub const USERNAME_MIN_LEN: usize = 2;
pub const USERNAME_MAX_LEN: usize = 16;
pub const PASSWORD_MIN_BYTES: usize = 8;
pub const PASSWORD_MAX_BYTES: usize = 128;

/// `^[a-z0-9-]{2,16}$`, byte counted, uppercase rejected.
pub fn validate_username(raw: &str) -> Result<(), String> {
    if !(USERNAME_MIN_LEN..=USERNAME_MAX_LEN).contains(&raw.len()) {
        return Err(format!(
            "username must be {USERNAME_MIN_LEN}-{USERNAME_MAX_LEN} bytes long, got {}: {raw:?}",
            raw.len()
        ));
    }
    if !raw
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(format!(
            "username must match ^[a-z0-9-]{{2,16}}$, got {raw:?}"
        ));
    }
    Ok(())
}

pub fn validate_password(raw: &str) -> Result<(), String> {
    if !(PASSWORD_MIN_BYTES..=PASSWORD_MAX_BYTES).contains(&raw.len()) {
        return Err(format!(
            "password must be {PASSWORD_MIN_BYTES}-{PASSWORD_MAX_BYTES} bytes long, got {}",
            raw.len()
        ));
    }
    Ok(())
}

/// argon2id with `Argon2::default()` parameters, returned as a PHC string.
pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| format!("hashing the password failed: {error}"))
}

pub fn verify_password(password: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// Argon2 is deliberately slow; callers on the async runtime use these wrappers
/// so hashing never blocks a worker thread.
pub async fn hash_password_async(password: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|error| format!("password hashing task failed: {error}"))?
}

pub async fn verify_password_async(password: String, phc: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || verify_password(&password, &phc))
        .await
        .map_err(|error| format!("password verification task failed: {error}"))
}

/// 32 random bytes as 64 lowercase hex characters.
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn sha256_hex(raw: &str) -> String {
    hex::encode(Sha256::digest(raw.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_accept_two_to_sixteen_lowercase() {
        assert!(validate_username("ab").is_ok());
        assert!(validate_username("a0123456789bcdef").is_ok(), "16 bytes");
        assert!(validate_username("good-name-1").is_ok());
    }

    #[test]
    fn usernames_reject_bad_shapes() {
        assert!(validate_username("a").is_err(), "one byte");
        assert!(validate_username("a0123456789bcdefg").is_err(), "17 bytes");
        assert!(validate_username("Upper").is_err());
        assert!(validate_username("under_score").is_err());
        assert!(validate_username("has space").is_err());
        assert!(validate_username("").is_err());
    }

    #[test]
    fn passwords_are_eight_to_128_bytes() {
        assert!(validate_password("1234567").is_err(), "7 bytes");
        assert!(validate_password("12345678").is_ok(), "8 bytes");
        assert!(validate_password(&"a".repeat(128)).is_ok(), "128 bytes");
        assert!(validate_password(&"a".repeat(129)).is_err(), "129 bytes");
    }

    #[test]
    fn hashes_are_argon2id_phc_and_verify() {
        let hash = hash_password("correct horse").expect("hash");
        assert!(hash.starts_with("$argon2id$"), "{hash}");
        assert!(verify_password("correct horse", &hash));
        assert!(!verify_password("wrong horse", &hash));
        assert!(!verify_password("correct horse", "not-a-phc-string"));
    }

    #[tokio::test]
    async fn async_wrappers_match_the_sync_ones() {
        let hash = hash_password_async("secret-password".to_string())
            .await
            .expect("hash");
        assert!(
            verify_password_async("secret-password".to_string(), hash.clone())
                .await
                .unwrap()
        );
        assert!(!verify_password_async("other".to_string(), hash)
            .await
            .unwrap());
    }

    #[test]
    fn tokens_are_64_lowercase_hex_and_unique() {
        let first = new_token();
        let second = new_token();
        assert_eq!(first.len(), 64);
        assert!(first
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        assert_ne!(first, second);
    }

    #[test]
    fn sha256_is_lowercase_hex() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_hex("abc").len(), 64);
    }
}
