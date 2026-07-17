// Vendored from ~/code/key-vault-wasm crates/ckb-fips204-utils (commit 5cc0c1e),
// ML-DSA subset, dev-tool copy — do not edit semantics.
//
// Verbatim copy of the upstream host-side CighashAll streamer (the `host-hashing`
// feature gate was dropped; this dev tool is always host-side).
//
//! Host-side CighashAll byte-stream generator.
//!
//! Produces the **exact same byte stream** as the on-chain
//! `generate_ckb_tx_message_all_with_witness` produces from CKB-VM syscalls —
//! but takes the tx and its resolved inputs as function arguments instead of
//! calling CKB-VM `load_cell` / `load_witness` etc.
//!
//! The streams must match byte-for-byte: any drift between the on-chain
//! version and this host version would produce a signature the contract
//! rejects with `Error::SignatureVerifyFailed` and there would be no way
//! to diagnose it apart from manual diffing of two opaque byte logs.
//!
//! # Algorithm (mirrors `ckb_tx_message_all_in_ckb_vm`)
//!
//! ```text
//! stream = tx_hash
//!        || for each input in tx.inputs():
//!              cell_output.as_slice() || u32_le(cell_data.len()) || cell_data
//!        || first witness of current group, split:
//!              u32_le(input_type.as_slice().len()) || input_type.as_slice()
//!              u32_le(output_type.as_slice().len()) || output_type.as_slice()
//!              (lock field deliberately excluded — it is the signature)
//!        || for each remaining group-input witness (skip 1):
//!              u32_le(len) || full witness bytes
//!        || for each witness at index >= input count:
//!              u32_le(len) || full witness bytes
//! ```

use std::io::{self, Write};

use ckb_types::{
    bytes::Bytes,
    core::TransactionView,
    packed::{CellOutput, WitnessArgsReader},
    prelude::*,
};

/// Errors returned by [`generate_ckb_tx_message_all_host`].
#[derive(Debug)]
pub enum HostHashError {
    /// Caller did not provide a resolved `CellOutput`/`Bytes` pair for every
    /// input in `tx.inputs()`. Returned as `(tx_input_count, provided)`.
    MissingResolvedInput {
        tx_input_count: usize,
        provided: usize,
    },
    /// `group_input_indices` was empty — every script execution is against a
    /// non-empty group.
    EmptyGroupInput,
    /// `group_input_indices` contained a value outside `0..witnesses.len()`.
    GroupIndexOutOfRange { index: usize, witness_count: usize },
    /// First group witness did not parse as a `WitnessArgs` molecule.
    WitnessArgsParse,
    /// Writer returned an I/O error mid-stream.
    Io(io::Error),
}

impl From<io::Error> for HostHashError {
    fn from(e: io::Error) -> Self {
        HostHashError::Io(e)
    }
}

/// Generate the CighashAll byte stream from a resolved transaction, writing
/// into `writer`.
///
/// # Arguments
///
/// * `writer` — typically [`crate::Hasher::message_hasher`], which implements
///   `std::io::Write`.
/// * `tx` — the transaction being signed. The *lock* field of
///   `witnesses[group_input_indices[0]]` is **not** inspected.
/// * `resolved_inputs` — one entry per `tx.inputs()` entry, in the same order,
///   giving the `CellOutput` + cell data that each input references.
/// * `group_input_indices` — indices into `tx.inputs()` (equivalently into
///   `tx.witnesses()`) for the inputs in the current script group.
pub fn generate_ckb_tx_message_all_host<W: Write>(
    writer: &mut W,
    tx: &TransactionView,
    resolved_inputs: &[(CellOutput, Bytes)],
    group_input_indices: &[usize],
) -> Result<(), HostHashError> {
    // ── Sanity checks at the boundary ────────────────────────────────────
    let input_count = tx.inputs().len();
    if resolved_inputs.len() != input_count {
        return Err(HostHashError::MissingResolvedInput {
            tx_input_count: input_count,
            provided: resolved_inputs.len(),
        });
    }
    if group_input_indices.is_empty() {
        return Err(HostHashError::EmptyGroupInput);
    }
    let witness_count = tx.witnesses().len();
    for &idx in group_input_indices {
        if idx >= witness_count {
            return Err(HostHashError::GroupIndexOutOfRange {
                index: idx,
                witness_count,
            });
        }
    }

    // ── 1. tx_hash (32 bytes) ────────────────────────────────────────────
    writer.write_all(tx.hash().as_slice())?;

    // ── 2. Input cells: CellOutput bytes + length-prefixed cell_data ─────
    for (cell_output, cell_data) in resolved_inputs {
        writer.write_all(cell_output.as_slice())?;
        write_length(writer, cell_data.len())?;
        writer.write_all(cell_data)?;
    }

    // ── 3. First group-input witness, SPLIT ─────────────────────────────
    //
    // Extracts `input_type` and `output_type` slice-form (molecule BytesOpt
    // bytes including any header) and writes each with a 4-byte LE length
    // prefix. The `lock` field is deliberately excluded — that's what we're
    // signing.
    let first_group_idx = group_input_indices[0];
    let first_witness_bytes: Bytes = tx.witnesses().get(first_group_idx).unwrap().unpack();
    let first_witness = WitnessArgsReader::from_slice(&first_witness_bytes)
        .map_err(|_| HostHashError::WitnessArgsParse)?;

    let input_type_slice = first_witness.input_type().as_slice();
    write_length(writer, input_type_slice.len())?;
    writer.write_all(input_type_slice)?;

    let output_type_slice = first_witness.output_type().as_slice();
    write_length(writer, output_type_slice.len())?;
    writer.write_all(output_type_slice)?;

    // ── 4. Rest of the group-input witnesses (skip the first one) ───────
    for &idx in group_input_indices.iter().skip(1) {
        let wit_bytes: Bytes = tx.witnesses().get(idx).unwrap().unpack();
        write_length(writer, wit_bytes.len())?;
        writer.write_all(&wit_bytes)?;
    }

    // ── 5. Witnesses with no matching input cell ────────────────────────
    for i in input_count..witness_count {
        let wit_bytes: Bytes = tx.witnesses().get(i).unwrap().unpack();
        write_length(writer, wit_bytes.len())?;
        writer.write_all(&wit_bytes)?;
    }

    writer.flush()?;
    Ok(())
}

/// Write a 4-byte little-endian length prefix. Matches the on-chain
/// `write_length` helper.
#[inline]
fn write_length<W: Write>(writer: &mut W, length: usize) -> Result<(), HostHashError> {
    let length: u32 = length
        .try_into()
        .expect("CighashAll segment length exceeds u32");
    writer.write_all(&length.to_le_bytes())?;
    Ok(())
}
