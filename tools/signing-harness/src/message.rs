// Vendored from ~/code/key-vault-wasm crates/ckb-fips204-utils (commit 5cc0c1e),
// ML-DSA subset, dev-tool copy — do not edit semantics.
//
// Subset note: the `#[cfg(not(feature = "std"))] use alloc::vec::Vec;` line was
// dropped; this copy is std-only. The M' construction below is verbatim.
//
//! FIPS-204 final-message (M') construction.
//!
//! FIPS-204 §5.4 defines two signing-mode framings of the user message M
//! before it reaches the ML-DSA core:
//!
//! - **Pure mode:**    M' = 0x00 || |ctx| || ctx || M
//! - **Prehash mode:** M' = 0x01 || |ctx| || ctx || OID(PH) || PH(M)
//!
//! where ctx is an up-to-255-byte domain-separator and PH is an external
//! hash function identified by its ASN.1 OID.
//!
//! # Usage
//!
//! ```ignore
//! let digest = {
//!     let mut h = Hasher::message_hasher();
//!     h.update(ckb_tx_message_all_bytes);
//!     h.hash()
//! };
//! let final_msg = build_fips204_final_message(
//!     HashAlgorithm::None,
//!     &digest,
//!     Some(DOMAIN),
//! );
//! ```

use crate::Error;

/// External hash function identifier for FIPS-204 prehash mode.
///
/// `None` selects pure mode (no prehash). The other variants name a specific
/// approved hash function and contribute its ASN.1 OID to the framing.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum HashAlgorithm {
    /// Pure mode — no external prehash.
    None,
    /// SHA2-256 (OID 2.16.840.1.101.3.4.2.1).
    Sha2256,
    /// SHA2-512 (OID 2.16.840.1.101.3.4.2.3).
    Sha2512,
    /// SHAKE-128 (OID 2.16.840.1.101.3.4.2.11).
    Shake128,
    /// SHAKE-256 (OID 2.16.840.1.101.3.4.2.12).
    Shake256,
}

impl HashAlgorithm {
    /// Returns the DER-encoded ASN.1 OID bytes for the hash function, or an
    /// empty slice for `None`.
    pub fn oid(self) -> &'static [u8] {
        match self {
            HashAlgorithm::None => &[],
            HashAlgorithm::Sha2256 => &[
                0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
            ],
            HashAlgorithm::Sha2512 => &[
                0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03,
            ],
            HashAlgorithm::Shake128 => &[
                0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x0B,
            ],
            HashAlgorithm::Shake256 => &[
                0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x0C,
            ],
        }
    }
}

/// Build a FIPS-204 final message M'.
///
/// - `algo == None` selects pure mode; `message` is the user message verbatim.
/// - `algo != None` selects prehash mode; **the caller is responsible for
///   hashing** the user message with `algo` before passing it here, and `message`
///   is expected to be that digest (not the raw message).
///
/// `context` is optional and capped at 255 bytes per FIPS-204 §5.4.
pub fn build_fips204_final_message(
    algo: HashAlgorithm,
    message: &[u8],
    context: Option<&[u8]>,
) -> Result<Vec<u8>, Error> {
    let ctx = context.unwrap_or(&[]);
    if ctx.len() > 255 {
        return Err(Error::ContextTooLong);
    }

    let prehash_byte: u8 = if algo == HashAlgorithm::None { 0x00 } else { 0x01 };
    let oid = algo.oid();

    let mut out = Vec::with_capacity(1 + 1 + ctx.len() + oid.len() + message.len());
    out.push(prehash_byte);
    out.push(ctx.len() as u8);
    out.extend_from_slice(ctx);
    out.extend_from_slice(oid);
    out.extend_from_slice(message);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_mode_no_context_no_oid() {
        let m = build_fips204_final_message(HashAlgorithm::None, b"hello", None).unwrap();
        assert_eq!(m, b"\x00\x00hello");
    }

    #[test]
    fn pure_mode_with_context() {
        let m = build_fips204_final_message(
            HashAlgorithm::None,
            b"msg",
            Some(b"CKB-MLDSA-LOCK"),
        )
        .unwrap();
        let mut expected = vec![0x00, 14u8];
        expected.extend_from_slice(b"CKB-MLDSA-LOCK");
        expected.extend_from_slice(b"msg");
        assert_eq!(m, expected);
    }

    #[test]
    fn prehash_mode_includes_oid_byte_and_prehash_prefix() {
        let digest = [0xAAu8; 32];
        let m =
            build_fips204_final_message(HashAlgorithm::Sha2256, &digest, Some(b"ctx")).unwrap();
        assert_eq!(m[0], 0x01);
        assert_eq!(m[1], 3);
        assert_eq!(&m[2..5], b"ctx");
        // OID (11 bytes) then the digest
        assert_eq!(&m[5..16], HashAlgorithm::Sha2256.oid());
        assert_eq!(&m[16..], &digest);
    }

    #[test]
    fn context_longer_than_255_is_rejected() {
        let long_ctx = vec![0u8; 256];
        let err = build_fips204_final_message(HashAlgorithm::None, b"", Some(&long_ctx));
        assert_eq!(err, Err(Error::ContextTooLong));
    }

    #[test]
    fn pure_mode_matches_fips204_section_5_4_framing() {
        // FIPS-204 §5.4: M' = 0x00 || |ctx| || ctx || M
        let m =
            build_fips204_final_message(HashAlgorithm::None, b"message", Some(b"dom")).unwrap();
        assert_eq!(m[0], 0x00, "prehash byte must be 0x00 for pure mode");
        assert_eq!(m[1], 3, "ctx length byte");
        assert_eq!(&m[2..5], b"dom");
        assert_eq!(&m[5..], b"message");
    }
}
