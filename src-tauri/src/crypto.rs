// Nex Pass — Crypto module
// Handles turning a master password into an encryption key, and using
// that key to encrypt/decrypt vault data. The master password itself
// is NEVER stored anywhere — only a verification hash to check unlock
// attempts, and the derived key lives in memory only while unlocked.

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// A derived encryption key, held in memory only while the vault is
/// unlocked. Automatically wiped from memory when dropped.
#[derive(ZeroizeOnDrop)]
pub struct VaultKey(#[zeroize(drop)] Vec<u8>);

impl VaultKey {
    fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

/// Everything needed to re-derive the same key from the same master
/// password later, plus the hash used to verify an unlock attempt.
/// This struct is safe to store on disk / in Firebase later — it
/// contains no secrets, only parameters and a one-way hash.
#[derive(Serialize, Deserialize, Clone)]
pub struct MasterKeyMaterial {
    /// Argon2id salt, stored so the same key can be re-derived later.
    pub salt: String,
    /// PHC-format hash used only to verify unlock attempts — this is
    /// NOT the encryption key and cannot be reversed into one.
    pub verification_hash: String,
}

#[derive(Debug)]
pub enum CryptoError {
    HashingFailed,
    WrongPassword,
    EncryptionFailed,
    DecryptionFailed,
    InvalidCiphertext,
}

/// Called once, when the user first sets their master password
/// (initial vault setup). Returns the material to persist plus the
/// derived key to use immediately for the current session.
pub fn create_master_key(master_password: &str) -> Result<(MasterKeyMaterial, VaultKey), CryptoError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();

    let hash = argon2
        .hash_password(master_password.as_bytes(), &salt)
        .map_err(|_| CryptoError::HashingFailed)?;

    let key_bytes = derive_key_bytes(master_password, salt.as_str())?;

    Ok((
        MasterKeyMaterial {
            salt: salt.as_str().to_string(),
            verification_hash: hash.to_string(),
        },
        VaultKey(key_bytes),
    ))
}

/// Called every time the user unlocks the vault. Verifies the entered
/// password against the stored hash, and if correct, re-derives the
/// same encryption key (deterministic given the same salt).
pub fn unlock(
    master_password: &str,
    material: &MasterKeyMaterial,
) -> Result<VaultKey, CryptoError> {
    let parsed_hash =
        PasswordHash::new(&material.verification_hash).map_err(|_| CryptoError::HashingFailed)?;

    Argon2::default()
        .verify_password(master_password.as_bytes(), &parsed_hash)
        .map_err(|_| CryptoError::WrongPassword)?;

    let key_bytes = derive_key_bytes(master_password, &material.salt)?;
    Ok(VaultKey(key_bytes))
}

/// Derives a raw 32-byte AES-256 key from the password + salt.
/// Separate from the verification hash above — this is the actual
/// encryption key material and is never persisted anywhere.
fn derive_key_bytes(master_password: &str, salt: &str) -> Result<Vec<u8>, CryptoError> {
    let salt = SaltString::from_b64(salt).map_err(|_| CryptoError::HashingFailed)?;
    let argon2 = Argon2::default();

    let mut output = vec![0u8; 32]; // 32 bytes = 256 bits for AES-256
    argon2
        .hash_password_into(master_password.as_bytes(), salt.as_str().as_bytes(), &mut output)
        .map_err(|_| CryptoError::HashingFailed)?;

    Ok(output)
}

/// Encrypts a plaintext string (e.g. a JSON-serialized credential
/// entry) with the given vault key. Returns ciphertext + nonce,
/// both base64-encoded so they're easy to store in SQLite as TEXT.
pub struct ExportBlob {
    pub salt: String,
    pub ciphertext_b64: String,
    pub nonce_b64: String,
}

pub fn encrypt_with_password(plaintext: &str, password: &str) -> Result<ExportBlob, CryptoError> {
    let salt = SaltString::generate(&mut OsRng);
    let key = VaultKey(derive_key_bytes(password, salt.as_str())?);
    let p = encrypt(plaintext, &key)?;
    Ok(ExportBlob { salt: salt.as_str().to_string(), ciphertext_b64: p.ciphertext_b64, nonce_b64: p.nonce_b64 })
}

pub fn decrypt_with_password(blob: &ExportBlob, password: &str) -> Result<String, CryptoError> {
    let key = VaultKey(derive_key_bytes(password, &blob.salt)?);
    decrypt(&EncryptedPayload { ciphertext_b64: blob.ciphertext_b64.clone(), nonce_b64: blob.nonce_b64.clone() }, &key)
}

pub struct EncryptedPayload {
    pub ciphertext_b64: String,
    pub nonce_b64: String,
}

pub fn encrypt(plaintext: &str, key: &VaultKey) -> Result<EncryptedPayload, CryptoError> {
    let cipher_key = Key::<Aes256Gcm>::from_slice(key.as_bytes());
    let cipher = Aes256Gcm::new(cipher_key);

    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|_| CryptoError::EncryptionFailed)?;

    Ok(EncryptedPayload {
        ciphertext_b64: base64_encode(&ciphertext),
        nonce_b64: base64_encode(&nonce),
    })
}

pub fn decrypt(payload: &EncryptedPayload, key: &VaultKey) -> Result<String, CryptoError> {
    let cipher_key = Key::<Aes256Gcm>::from_slice(key.as_bytes());
    let cipher = Aes256Gcm::new(cipher_key);

    let ciphertext = base64_decode(&payload.ciphertext_b64)
        .map_err(|_| CryptoError::InvalidCiphertext)?;
    let nonce_bytes =
        base64_decode(&payload.nonce_b64).map_err(|_| CryptoError::InvalidCiphertext)?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext_bytes = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| CryptoError::DecryptionFailed)?;

    String::from_utf8(plaintext_bytes).map_err(|_| CryptoError::DecryptionFailed)
}

// --- small base64 helpers (no extra crate needed beyond what we use) ---

fn base64_encode(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(bytes)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, ()> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.decode(s).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let (material, key) = create_master_key("correct-horse-battery-staple").unwrap();
        let payload = encrypt("my-secret-password-123", &key).unwrap();
        let decrypted = decrypt(&payload, &key).unwrap();
        assert_eq!(decrypted, "my-secret-password-123");

        // Unlocking again with the right password re-derives a working key.
        let key2 = unlock("correct-horse-battery-staple", &material).unwrap();
        let decrypted2 = decrypt(&payload, &key2).unwrap();
        assert_eq!(decrypted2, "my-secret-password-123");
    }

    #[test]
    fn wrong_password_fails() {
        let (material, _key) = create_master_key("correct-horse-battery-staple").unwrap();
        let result = unlock("wrong-password", &material);
        assert!(result.is_err());
    }
}
