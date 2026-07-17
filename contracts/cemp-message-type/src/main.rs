//! CEMP message type script — on-chain entry point.
//!
//! The CKB-VM entry exists only for the riscv64 target; host builds and
//! `cargo test` compile a no-op `main` and exercise the validation logic
//! through the unit tests in `lib.rs` instead.
#![cfg_attr(target_arch = "riscv64", no_std)]
#![cfg_attr(target_arch = "riscv64", no_main)]

/// Exit code: `load_script` syscall failed (see the exit-code table in `lib.rs`).
#[cfg(target_arch = "riscv64")]
const ERROR_LOAD_SCRIPT: i8 = 3;

#[cfg(target_arch = "riscv64")]
ckb_std::entry!(program_entry);
#[cfg(target_arch = "riscv64")]
ckb_std::default_alloc!();

/// Running as a TYPE script, this executes once per group of cells carrying
/// this type; per-cell args are identical by construction (same script), so
/// validating the script's own args covers the group.
#[cfg(target_arch = "riscv64")]
fn program_entry() -> i8 {
    use ckb_std::ckb_types::prelude::Entity;

    match ckb_std::high_level::load_script() {
        Ok(script) => match cemp_message_type::validate_type_args(script.args().as_slice()) {
            Ok(()) => 0,
            Err(code) => code,
        },
        Err(_) => ERROR_LOAD_SCRIPT,
    }
}

#[cfg(not(target_arch = "riscv64"))]
fn main() {}
