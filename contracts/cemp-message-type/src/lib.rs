//! CEMP message type script — placeholder crate.
//!
//! The on-chain script will be built here once the Phase 1 protocol
//! specification has pinned the byte-level cell format (see ckd.txt §6 and
//! docs/protocol/). Until then this crate only carries shared constants so
//! the Rust and TypeScript sides can be kept in sync via tests.

/// CEMP wire protocol version (mirrors packages/cemp-core CEMP_PROTOCOL_VERSION).
pub const CEMP_PROTOCOL_VERSION: u16 = 1;

/// Length of a recipient route tag in bytes (BLAKE2b-256 output, ckd.txt §6.1).
pub const ROUTE_TAG_LEN: usize = 32;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_is_v1() {
        assert_eq!(CEMP_PROTOCOL_VERSION, 1);
    }

    #[test]
    fn route_tag_is_blake2b_sized() {
        assert_eq!(ROUTE_TAG_LEN, 32);
    }
}
