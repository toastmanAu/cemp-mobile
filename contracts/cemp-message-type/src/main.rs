//! CEMP message type script — on-chain entry point.
//!
//! The CKB-VM entry exists only for the riscv64 target; host builds and
//! `cargo test` compile a no-op `main` and exercise the validation logic
//! through the unit tests in `lib.rs` instead.
//!
//! ⚠ This entry point deliberately does NOT use `ckb_std::high_level` /
//! `ckb-gen-types` molecule entities: those clone `bytes::Bytes` refcounts,
//! which compile to RISC-V A-extension instructions (`lr.d`/`sc.d`/`amoadd.d`)
//! — and CKB-VM has no A extension, so the script dies with
//! `VM Internal Error: InvalidInstruction` (observed on testnet, first
//! deployment). Instead the script buffer is loaded with the raw syscall and
//! the `Script` molecule table is parsed by hand. The binary must stay free
//! of A-extension instructions (check with
//! `riscv64-unknown-elf-objdump -d` — no `lr.*`, `sc.*`, `amo*` mnemonics).
#![cfg_attr(target_arch = "riscv64", no_std)]
#![cfg_attr(target_arch = "riscv64", no_main)]

/// Exit code: `load_script` syscall failed (see the exit-code table in `lib.rs`).
#[cfg(target_arch = "riscv64")]
const ERROR_LOAD_SCRIPT: i8 = 3;
/// Exit code: the loaded script buffer is not a well-formed molecule `Script`.
#[cfg(target_arch = "riscv64")]
const ERROR_MALFORMED_SCRIPT: i8 = 4;

#[cfg(target_arch = "riscv64")]
ckb_std::entry!(program_entry);
#[cfg(target_arch = "riscv64")]
ckb_std::default_alloc!();

/// Script buffer cap. A v1 script is 32 (code_hash) + 1 (hash_type) +
/// 4+81 (args Bytes) + 16 table header = 134 bytes; 512 is generous.
#[cfg(target_arch = "riscv64")]
const SCRIPT_BUF_LEN: usize = 512;

#[cfg(target_arch = "riscv64")]
fn read_u32_le(buf: &[u8], at: usize) -> Option<usize> {
    let bytes = buf.get(at..at + 4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
}

/// Running as a TYPE script, this executes once per group of cells carrying
/// this type; per-cell args are identical by construction (same script), so
/// validating the script's own args covers the group.
#[cfg(target_arch = "riscv64")]
fn program_entry() -> i8 {
    let mut buf = [0u8; SCRIPT_BUF_LEN];
    let len = match ckb_std::syscalls::load_script(&mut buf, 0) {
        Ok(len) => len,
        Err(_) => return ERROR_LOAD_SCRIPT,
    };
    let Some(script) = parse_script_args(&buf[..len.min(SCRIPT_BUF_LEN)], len) else {
        return ERROR_MALFORMED_SCRIPT;
    };
    match cemp_message_type::validate_type_args(script) {
        Ok(()) => 0,
        Err(code) => code,
    }
}

/// Extract the `args` payload from a raw molecule `Script` table:
/// `u32 total_size | u32 offset[3] | code_hash(32) | hash_type(1) | args(Bytes)`.
/// `reported_len` is the syscall's return value (the true buffer length).
#[cfg(target_arch = "riscv64")]
fn parse_script_args<'a>(buf: &'a [u8], reported_len: usize) -> Option<&'a [u8]> {
    if reported_len > buf.len() || reported_len < 4 + 3 * 4 {
        return None;
    }
    let total_size = read_u32_le(buf, 0)?;
    if total_size != reported_len {
        return None;
    }
    // Three field offsets; args is the third field, spanning [off2, total).
    let off0 = read_u32_le(buf, 4)?;
    let off1 = read_u32_le(buf, 8)?;
    let off2 = read_u32_le(buf, 12)?;
    if off0 < 4 + 3 * 4 || off1 < off0 || off2 < off1 || off2 > reported_len {
        return None;
    }
    let args_len = read_u32_le(buf, off2)?;
    let args_end = off2.checked_add(4)?.checked_add(args_len)?;
    if args_end > reported_len {
        return None;
    }
    buf.get(off2 + 4..args_end)
}

#[cfg(not(target_arch = "riscv64"))]
fn main() {}
