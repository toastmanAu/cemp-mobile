// Vendored from ~/code/key-vault-wasm crates/ckb-fips204-utils (commit 5cc0c1e),
// ML-DSA subset, dev-tool copy — do not edit semantics.
//
// Subset notes (structure-only changes vs upstream; algorithm bytes unchanged):
// - Falcon variants, Falcon hashers and the HKDF KDF helpers dropped.
// - no_std / ckb-vm cfgs stripped; this copy is std-only.
// - `Error` trimmed to the variants the harness exercises.
//
//! CKB ML-DSA (FIPS 204) utilities — single-sig v2 layout helpers.
//!
//! ## Lock args layout (37 bytes, single-sig v2)
//!
//! ```text
//! [0]    0x80              multisig header marker (extension point for k-of-n)
//! [1]    0x01              require_first_n
//! [2]    0x01              threshold
//! [3]    0x01              pubkey count
//! [4]    flag              (param_id << 1) | 0    // 0 = no embedded sig in args
//! [5..37] blake2b_256(pk)  32-byte public key hash
//! ```
//!
//! ## Witness lock layout (single-sig v2)
//!
//! ```text
//! [0]             flag              (param_id << 1) | 1  // 1 = has signature
//! [1..1+PK]       pubkey            param-id-dependent length
//! [1+PK..]        signature         param-id-dependent length
//! ```
//!
//! ## Signing message pipeline
//!
//! ```text
//! digest = blake2b_personal("ckb-mldsa-msg", ckb_tx_message_all(tx))
//! final  = build_fips204_final_message(HashAlgorithm::None, digest, Some(DOMAIN))
//! verify = ml_dsa_N::verify(pk, final, sig, &[])   // ctx empty: baked into final
//! ```

pub mod ckb_tx_message_all_host;
pub mod message;

use ckb_hash::{Blake2b, Blake2bBuilder};

// ── parameter ids ─────────────────────────────────────────────────────────────
//
// Chosen to sit immediately after the SPHINCS+ param ids (48..=59) so a future
// unified ParamId enum can absorb both without renumbering. ML-DSA gets 60..=62.

/// Post-quantum signature scheme parameter identifiers.
///
/// Encoded as a single byte and packed into the lock flag via
/// `construct_flag` / `destruct_flag`.
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum ParamId {
    Mldsa44 = 60,
    Mldsa65 = 61,
    Mldsa87 = 62,
}

impl ParamId {
    pub fn from_u8(v: u8) -> Result<Self, Error> {
        match v {
            60 => Ok(ParamId::Mldsa44),
            61 => Ok(ParamId::Mldsa65),
            62 => Ok(ParamId::Mldsa87),
            _ => Err(Error::InvalidParamId),
        }
    }
}

// ── flag packing ──────────────────────────────────────────────────────────────

/// Pack `(param_id, has_signature)` into a single byte.
///
/// Layout: `[7..1] = param_id`, `[0] = has_signature`.
pub fn construct_flag(param_id: ParamId, has_signature: bool) -> u8 {
    let value = param_id as u8;
    (value << 1) | if has_signature { 1 } else { 0 }
}

/// Unpack a flag byte. Returns `Err(InvalidParamId)` for unknown param ids.
pub fn destruct_flag(flag: u8) -> Result<(ParamId, bool), Error> {
    let has_signature = flag & 1 != 0;
    let param_id = ParamId::from_u8(flag >> 1)?;
    Ok((param_id, has_signature))
}

// ── personalised blake2b hashers ──────────────────────────────────────────────

/// Blake2b wrapper with domain-separated personalisation. Finalises to 32 bytes.
pub struct Hasher(Blake2b);

impl Hasher {
    /// Personalised hasher for script args derivation.
    /// Personalisation: `b"ckb-mldsa-sct"`.
    pub fn script_args_hasher() -> Self {
        Hasher(
            Blake2bBuilder::new(32)
                .personal(b"ckb-mldsa-sct")
                .build(),
        )
    }

    /// Personalised hasher for the ML-DSA signing digest. Feed the CighashAll
    /// stream into this and finalise → the 32-byte message wrapped by
    /// `build_fips204_final_message`.
    /// Personalisation: `b"ckb-mldsa-msg"`.
    pub fn message_hasher() -> Self {
        Hasher(
            Blake2bBuilder::new(32)
                .personal(b"ckb-mldsa-msg")
                .build(),
        )
    }

    #[inline]
    pub fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }

    pub fn hash(self) -> [u8; 32] {
        let mut out = [0u8; 32];
        self.0.finalize(&mut out);
        out
    }
}

// ── io::Write impl for streaming CighashAll into the hasher ──────────────────

impl std::io::Write for Hasher {
    fn write(&mut self, data: &[u8]) -> Result<usize, std::io::Error> {
        self.0.update(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> Result<(), std::io::Error> {
        Ok(())
    }
}

// ── domain separator ──────────────────────────────────────────────────────────

/// FIPS-204 context string passed through `build_fips204_final_message`.
pub const DOMAIN: &[u8] = b"CKB-MLDSA-LOCK";

// ── ML-DSA parameter sizes ────────────────────────────────────────────────────
//
// Sourced from FIPS 204 §4 (Table 1).

/// `(pubkey_len, signature_len, secret_key_len)` for a given variant.
///
/// Source: FIPS 204 §4 Table 1.
pub const fn lengths(param_id: ParamId) -> (usize, usize, usize) {
    match param_id {
        ParamId::Mldsa44 => (1312, 2420, 2560),
        ParamId::Mldsa65 => (1952, 3309, 4032),
        ParamId::Mldsa87 => (2592, 4627, 4896),
    }
}

// ── lock args ─────────────────────────────────────────────────────────────────

/// Length of a single-sig v2 lock args field:
/// `[0x80, 0x01, 0x01, 0x01, flag, blake2b_256(pk)]` = 5 + 32 = 37.
pub const LOCK_ARGS_LEN: usize = 37;

/// Construct the 37-byte v2 lock args from a pubkey.
///
/// The pubkey is hashed with a domain-separated blake2b:
/// `Hasher::script_args_hasher` (personalisation `b"ckb-mldsa-sct"`).
///
/// The on-chain lock script re-computes the same hash during verification —
/// any divergence between signer-side `lock_args()` and the on-chain hasher
/// surfaces as a pubkey-hash mismatch at spend time.
pub fn lock_args(param_id: ParamId, pubkey: &[u8]) -> [u8; LOCK_ARGS_LEN] {
    let pk_hash = {
        let mut h = Hasher::script_args_hasher();
        h.update(pubkey);
        h.hash()
    };
    let mut args = [0u8; LOCK_ARGS_LEN];
    args[0] = 0x80; // multisig header marker
    args[1] = 0x01; // require_first_n
    args[2] = 0x01; // threshold
    args[3] = 0x01; // pubkey count (single-sig)
    args[4] = construct_flag(param_id, false);
    args[5..].copy_from_slice(&pk_hash);
    args
}

// ── errors ────────────────────────────────────────────────────────────────────

/// Error codes returned by on-chain verifying. Values chosen to sit above the
/// CKB / ckb-std reserved range.
#[repr(i8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidParamId = 40,
    InvalidPubkeyLength = 41,
    InvalidSignatureLength = 42,
    SignatureVerifyFailed = 46,
    ContextTooLong = 47,
}

impl From<Error> for i8 {
    fn from(e: Error) -> i8 {
        e as i8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_roundtrip() {
        for pid in [ParamId::Mldsa44, ParamId::Mldsa65, ParamId::Mldsa87] {
            let f_no_sig = construct_flag(pid, false);
            let f_sig = construct_flag(pid, true);
            assert_eq!(destruct_flag(f_no_sig).unwrap(), (pid, false));
            assert_eq!(destruct_flag(f_sig).unwrap(), (pid, true));
        }
    }

    #[test]
    fn lock_args_layout_is_37_bytes_and_starts_with_multisig_header() {
        let pk = [0xABu8; 1952];
        let args = lock_args(ParamId::Mldsa65, &pk);
        assert_eq!(args.len(), 37);
        assert_eq!(&args[0..4], &[0x80, 0x01, 0x01, 0x01]);
        let (pid, has_sig) = destruct_flag(args[4]).unwrap();
        assert_eq!(pid, ParamId::Mldsa65);
        assert!(!has_sig);
    }

    #[test]
    fn lengths_match_fips204_table_1() {
        assert_eq!(lengths(ParamId::Mldsa44), (1312, 2420, 2560));
        assert_eq!(lengths(ParamId::Mldsa65), (1952, 3309, 4032));
        assert_eq!(lengths(ParamId::Mldsa87), (2592, 4627, 4896));
    }

    #[test]
    fn hashers_have_distinct_personalisation() {
        let mut a = Hasher::script_args_hasher();
        let mut b = Hasher::message_hasher();
        a.update(b"same input");
        b.update(b"same input");
        assert_ne!(a.hash(), b.hash());
    }

    #[test]
    fn domain_separator_is_ckb_mldsa_lock() {
        assert_eq!(DOMAIN, b"CKB-MLDSA-LOCK");
    }
}
