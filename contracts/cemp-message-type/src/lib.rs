//! CEMP message type script.
//!
//! Validates the 81-byte type args of CEMP message cells
//! (`docs/protocol/CEMP-PROTOCOL-V1.md` §6). A dedicated type script exists so
//! malformed cells cannot squat under the CEMP code hash. The pure validation
//! logic lives here as a platform-neutral function so it is callable from both
//! the on-chain entry point (`main.rs`, riscv64 only) and host-side unit
//! tests.
//!
//! Script exit codes:
//!
//! | code | meaning                                          |
//! |------|--------------------------------------------------|
//! | 0    | success                                          |
//! | 1    | type args length != 81 bytes                     |
//! | 2    | unsupported protocol version byte (args[0] != 1) |
//! | 3    | failed to load own script (on-chain entry only)  |
//! | 4    | own script buffer is not a well-formed molecule `Script` (on-chain only) |
#![no_std]

#[cfg(test)]
extern crate std;

/// CEMP wire protocol version (mirrors packages/cemp-core CEMP_PROTOCOL_VERSION).
pub const CEMP_PROTOCOL_VERSION: u16 = 1;

/// Length of a recipient route tag in bytes (BLAKE2b-256 output, ckd.txt §6.1).
pub const ROUTE_TAG_LEN: usize = 32;

/// Length of a conversation tag in bytes (protocol spec §6).
pub const CONVERSATION_TAG_LEN: usize = 16;

/// Length of a message nonce in bytes (protocol spec §6).
pub const MESSAGE_NONCE_LEN: usize = 16;

/// Fixed length of the message cell type args, normatively pinned by spec §6
/// ("Type args (81 bytes, fixed)"). The layout is
/// `version || route_tag || conversation_tag || message_nonce`.
///
/// Note: the per-field sizes in the spec §2 table (1 + 32 + 16 + 16) sum to
/// 65, not 81; the remaining 16 bytes are treated as reserved. The 81-byte
/// total is the on-chain rule this script enforces — tightening the field
/// split is a spec-level change (AGENTS.md rule 1).
pub const TYPE_ARGS_LEN: usize = 81;

/// The only protocol version byte this script accepts (args[0], spec §6).
pub const TYPE_ARGS_VERSION_V1: u8 = 1;

/// Exit code: type args are not exactly [`TYPE_ARGS_LEN`] bytes.
pub const ERROR_TYPE_ARGS_LEN: i8 = 1;

/// Exit code: args[0] is not [`TYPE_ARGS_VERSION_V1`].
pub const ERROR_PROTOCOL_VERSION: i8 = 2;

/// Validate the type args of a CEMP message cell.
///
/// Deployed as a TYPE script, this runs once per group of cells sharing the
/// type (on cell creation and on spending). Every cell in the group carries
/// the same script — and therefore identical args — by construction, so
/// validating the script's own args covers the whole group.
///
/// v1 deliberately does not load cell data: envelope shape is checked
/// client-side (protocol spec §12 — malformed on-chain data is rejected by the
/// receiving client), and skipping data loads keeps the cycle cost near zero.
/// Later versions may additionally validate the `CempEnvelopeV1` shape.
pub fn validate_type_args(args: &[u8]) -> Result<(), i8> {
    if args.len() != TYPE_ARGS_LEN {
        return Err(ERROR_TYPE_ARGS_LEN);
    }
    if args[0] != TYPE_ARGS_VERSION_V1 {
        return Err(ERROR_PROTOCOL_VERSION);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_args() -> [u8; TYPE_ARGS_LEN] {
        let mut args = [0u8; TYPE_ARGS_LEN];
        args[0] = TYPE_ARGS_VERSION_V1;
        args
    }

    #[test]
    fn protocol_version_is_v1() {
        assert_eq!(CEMP_PROTOCOL_VERSION, 1);
    }

    #[test]
    fn route_tag_is_blake2b_sized() {
        assert_eq!(ROUTE_TAG_LEN, 32);
    }

    #[test]
    fn type_args_layout_is_81_bytes() {
        // Spec §6 normative total; see the TYPE_ARGS_LEN doc comment for the
        // field-size discrepancy.
        assert_eq!(TYPE_ARGS_LEN, 81);
        assert_eq!(1 + ROUTE_TAG_LEN + CONVERSATION_TAG_LEN + MESSAGE_NONCE_LEN, 65);
    }

    #[test]
    fn valid_v1_args_accepted() {
        assert_eq!(validate_type_args(&valid_args()), Ok(()));
    }

    #[test]
    fn wrong_lengths_rejected() {
        assert_eq!(validate_type_args(&[]), Err(ERROR_TYPE_ARGS_LEN));
        assert_eq!(validate_type_args(&[1u8; 80]), Err(ERROR_TYPE_ARGS_LEN));
        assert_eq!(validate_type_args(&[1u8; 82]), Err(ERROR_TYPE_ARGS_LEN));
    }

    #[test]
    fn wrong_version_byte_rejected() {
        let mut args = valid_args();
        args[0] = 0;
        assert_eq!(validate_type_args(&args), Err(ERROR_PROTOCOL_VERSION));
        args[0] = 2;
        assert_eq!(validate_type_args(&args), Err(ERROR_PROTOCOL_VERSION));
    }

    #[test]
    fn error_codes_are_nonzero_and_distinct() {
        assert_ne!(ERROR_TYPE_ARGS_LEN, 0);
        assert_ne!(ERROR_PROTOCOL_VERSION, 0);
        assert_ne!(ERROR_TYPE_ARGS_LEN, ERROR_PROTOCOL_VERSION);
    }
}
