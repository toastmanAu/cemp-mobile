//! signing-harness — golden-vector generator and external-signature verifier
//! for the v2 ML-DSA-65 CKB signing pipeline (`mldsa65-lock-v2-rust`).
//!
//! Subcommands (parsed manually, no clap):
//!
//!   signing-harness vectors --out <path>
//!       Write the deterministic golden-vector JSON (keygen / cighash / sign).
//!
//!   signing-harness verify --pubkey <hex> --signature <hex> --stream <hex>
//!       Recompute the FIPS-204 final message from the CighashAll stream and
//!       verify the ML-DSA-65 signature against it. Prints OK / FAIL, exit 0/1.
//!
//! The algorithm code lives in the vendored library modules (src/lib.rs,
//! src/message.rs, src/ckb_tx_message_all_host.rs). Keygen and the
//! CighashAll stream mirror ~/code/key-vault-wasm
//! crates/ckb-fips204-utils/src/signing.rs (keygen_from_seed →
//! PrivateKey::try_from_bytes → try_sign_with_seed(rnd = 0x00*32, …)).
//!
//! FRAMING WARNING — sign/verify here deliberately do NOT mirror
//! key-vault-wasm's ctx handling. key-vault-wasm pre-wraps the digest into
//! final_msg = 0x00||0x0E||DOMAIN||digest and then calls fips204 with
//! ctx = [], which wraps AGAIN internally (double wrap). That matches the
//! sibling `mldsa65-lock-v2` (fips204 backend, type_id da3e5dc1…) but is
//! rejected by the DEPLOYED `mldsa65-lock-v2-rust` (ml-dsa crate backend,
//! type_id d70653f7…, cell dep 0x1074b1ac…0cb1 index 3), which calls
//! ml_dsa::VerifyingKey::verify_with_context(digest, DOMAIN, sig) — standard
//! FIPS-204 pure mode, single wrap. This harness signs/verifies the way the
//! deployed contract does: pass the RAW digest as msg and DOMAIN as ctx and
//! let the crate apply the M' framing once. Do not "fix" this back.

use std::process::ExitCode;

use ckb_types::{
    bytes::Bytes,
    core::{ScriptHashType, TransactionBuilder, TransactionView},
    packed::{Byte32, CellInput, CellOutput, OutPoint, Script, WitnessArgs},
    prelude::*,
    H256,
};
use fips204::ml_dsa_65 as ml;
use fips204::traits::{KeyGen, SerDes, Signer as _, Verifier as _};
use serde::Serialize;
use signing_harness::{
    ckb_tx_message_all_host::generate_ckb_tx_message_all_host,
    construct_flag, lock_args,
    message::{build_fips204_final_message, HashAlgorithm},
    Hasher, ParamId, DOMAIN,
};

/// Witness-lock length for single-sig ML-DSA-65: 1 flag + 1952 pk + 3309 sig.
const WITNESS_LOCK_LEN: usize = 5262;
/// ML-DSA-65 public key length (FIPS 204 §4 Table 1).
const PK_LEN: usize = 1952;
/// ML-DSA-65 secret key length.
const SK_LEN: usize = 4032;
/// ML-DSA-65 signature length.
const SIG_LEN: usize = 3309;

// ── JSON schema ───────────────────────────────────────────────────────────────
//
// Hex strings are lowercase, no 0x prefix — matches the existing
// packages/cemp-test-vectors convention (see vectors/hkdf-sha256.json).

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VectorFile {
    vector_format_version: u32,
    suite: &'static str,
    source: &'static str,
    keygen: Vec<KeygenCase>,
    cighash: Vec<CighashCase>,
    sign: Vec<SignCase>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeygenCase {
    name: String,
    seed: String,
    pubkey: String,
    secret_key: String,
    lock_args: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CighashCase {
    name: String,
    /// Molecule-packed transaction (raw tx + witnesses), hex.
    tx: String,
    resolved_inputs: Vec<ResolvedInput>,
    group_input_indices: Vec<usize>,
    /// Full CighashAll byte stream, hex.
    stream: String,
    /// blake2b-256 personal "ckb-mldsa-msg" over the stream, hex.
    digest: String,
    /// 0x00 || 0x0E || "CKB-MLDSA-LOCK" || digest, hex.
    final_message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedInput {
    /// Molecule-packed CellOutput, hex.
    cell_output: String,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignCase {
    name: String,
    seed: String,
    stream: String,
    /// blake2b-256 personal "ckb-mldsa-msg" over the stream — the `msg`
    /// argument passed to sign/verify with ctx = DOMAIN.
    digest: String,
    /// 0x00 || 0x0E || "CKB-MLDSA-LOCK" || digest — the M' the FIPS-204
    /// implementation computes internally; informational, not signed directly.
    final_message: String,
    pubkey: String,
    signature: String,
    /// [0x7B flag, pubkey, signature] — 5262 bytes, hex.
    witness_lock: String,
}

// ── fixed fixtures ────────────────────────────────────────────────────────────

fn byte32(fill: u8) -> Byte32 {
    H256([fill; 32]).pack()
}

/// Distinctive fixture script: code_hash = `fill` repeated, single-byte args.
fn fixture_script(code_fill: u8, args: &[u8]) -> Script {
    Script::new_builder()
        .code_hash(byte32(code_fill))
        .hash_type(ScriptHashType::Data1.into())
        .args(Bytes::copy_from_slice(args).pack())
        .build()
}

fn fixture_outpoint(tx_fill: u8, index: u32) -> OutPoint {
    OutPoint::new_builder()
        .tx_hash(byte32(tx_fill))
        .index(index.pack())
        .build()
}

fn fixture_cell(capacity: u64, lock: Script, type_: Option<Script>) -> CellOutput {
    CellOutput::new_builder()
        .capacity(capacity.pack())
        .lock(lock)
        .type_(type_.pack())
        .build()
}

struct Scenario {
    name: &'static str,
    tx: TransactionView,
    resolved_inputs: Vec<(CellOutput, Bytes)>,
    group_input_indices: Vec<usize>,
}

/// (a) 1 input (resolved cell has lock + type + nonempty data), 1 output,
/// witnesses = [WitnessArgs{ lock = Some(5262 zero bytes) }], group = [0].
fn scenario_single_input_empty_witness_fields() -> Scenario {
    let lock = fixture_script(0x01, &[0xaa]);
    let type_ = fixture_script(0x02, &[0xbb]);
    let resolved = fixture_cell(10_000_000_000, lock.clone(), Some(type_));
    let data = Bytes::from_static(b"first-input-cell-data");

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(fixture_outpoint(0x11, 0)).build())
        .output(fixture_cell(9_000_000_000, fixture_script(0x01, &[0xcc]), None))
        .output_data(Bytes::new().pack())
        .witness(
            WitnessArgs::new_builder()
                .lock(Some(Bytes::from(vec![0u8; WITNESS_LOCK_LEN])).pack())
                .build()
                .as_bytes()
                .pack(),
        )
        .build();

    Scenario {
        name: "single-input-empty-witness-fields",
        tx,
        resolved_inputs: vec![(resolved, data)],
        group_input_indices: vec![0],
    }
}

/// (b) 2 inputs (distinct resolved data), 2 outputs, witnesses =
/// [WitnessArgs{lock=Some(5262 zeros)},
///  WitnessArgs{lock=None, input_type=Some(b"second-it"), output_type=Some(b"second-ot")},
///  raw bytes b"extra-witness-payload"], group = [0, 1].
fn scenario_two_inputs_extra_witness() -> Scenario {
    let lock = fixture_script(0x01, &[0xaa]);
    let resolved0 = fixture_cell(11_000_000_000, lock.clone(), Some(fixture_script(0x02, &[0xbb])));
    let resolved1 = fixture_cell(12_000_000_000, lock.clone(), Some(fixture_script(0x02, &[0xdd])));
    let data0 = Bytes::from_static(b"input-zero-data");
    let data1 = Bytes::from_static(b"input-one-data-different");

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(fixture_outpoint(0x21, 0)).build())
        .input(CellInput::new_builder().previous_output(fixture_outpoint(0x22, 1)).build())
        .output(fixture_cell(20_000_000_000, fixture_script(0x01, &[0xcc]), None))
        .output(fixture_cell(2_900_000_000, fixture_script(0x03, &[0xee]), None))
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .witness(
            WitnessArgs::new_builder()
                .lock(Some(Bytes::from(vec![0u8; WITNESS_LOCK_LEN])).pack())
                .build()
                .as_bytes()
                .pack(),
        )
        .witness(
            WitnessArgs::new_builder()
                .input_type(Some(Bytes::from_static(b"second-it")).pack())
                .output_type(Some(Bytes::from_static(b"second-ot")).pack())
                .build()
                .as_bytes()
                .pack(),
        )
        // Extra witness beyond input count — raw bytes, NOT a WitnessArgs
        // molecule; hashed in full with a u32-LE length prefix.
        .witness(Bytes::from_static(b"extra-witness-payload").pack())
        .build();

    Scenario {
        name: "two-inputs-extra-witness",
        tx,
        resolved_inputs: vec![(resolved0, data0), (resolved1, data1)],
        group_input_indices: vec![0, 1],
    }
}

/// (c) 1 input, 1 output, first witness = WitnessArgs{ lock=Some(5262 zeros),
/// input_type=Some(b"it-payload"), output_type=Some(b"ot-payload") }, group=[0].
fn scenario_first_witness_input_output_type() -> Scenario {
    let lock = fixture_script(0x01, &[0xaa]);
    let resolved = fixture_cell(13_000_000_000, lock.clone(), Some(fixture_script(0x02, &[0xbb])));
    let data = Bytes::from_static(b"third-scenario-data");

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(fixture_outpoint(0x31, 2)).build())
        .output(fixture_cell(12_000_000_000, fixture_script(0x01, &[0xcc]), None))
        .output_data(Bytes::new().pack())
        .witness(
            WitnessArgs::new_builder()
                .lock(Some(Bytes::from(vec![0u8; WITNESS_LOCK_LEN])).pack())
                .input_type(Some(Bytes::from_static(b"it-payload")).pack())
                .output_type(Some(Bytes::from_static(b"ot-payload")).pack())
                .build()
                .as_bytes()
                .pack(),
        )
        .build();

    Scenario {
        name: "first-witness-input-output-type",
        tx,
        resolved_inputs: vec![(resolved, data)],
        group_input_indices: vec![0],
    }
}

// ── pipeline helpers ──────────────────────────────────────────────────────────

/// CighashAll stream → personalised blake2b digest → FIPS-204 M' final message.
/// Returns (stream, digest, final_message).
fn run_pipeline(scenario: &Scenario) -> Result<(Vec<u8>, [u8; 32], Vec<u8>), String> {
    let mut stream = Vec::new();
    generate_ckb_tx_message_all_host(
        &mut stream,
        &scenario.tx,
        &scenario.resolved_inputs,
        &scenario.group_input_indices,
    )
    .map_err(|e| format!("cighash stream ({}): {:?}", scenario.name, e))?;
    let (digest, final_message) = final_message_from_stream(&stream)?;
    Ok((stream, digest, final_message))
}

/// digest = blake2b-256 personal "ckb-mldsa-msg" over stream;
/// final = 0x00 || 0x0E || "CKB-MLDSA-LOCK" || digest.
///
/// `final_message` is emitted into the vectors for documentation only — it
/// equals the M' that a FIPS-204 implementation computes internally when
/// called as sign/verify(digest, ctx = DOMAIN). It is NOT passed to
/// sign/verify directly (that would double-wrap — see the file header).
fn final_message_from_stream(stream: &[u8]) -> Result<([u8; 32], Vec<u8>), String> {
    let mut h = Hasher::message_hasher();
    h.update(stream);
    let digest = h.hash();
    let final_message = build_fips204_final_message(HashAlgorithm::None, &digest, Some(DOMAIN))
        .map_err(|e| format!("build final message: {:?}", e))?;
    Ok((digest, final_message))
}

/// ML-DSA-65 keygen from a raw 32-byte seed (FIPS-204 deterministic keygen —
/// mirrors signing.rs::derive_keypair_raw, minus the upstream HKDF step: the
/// harness takes the child seed directly).
fn keygen_from_seed(seed: &[u8; 32]) -> ([u8; PK_LEN], [u8; SK_LEN]) {
    let (pk, sk) = ml::KG::keygen_from_seed(seed);
    (pk.into_bytes(), sk.into_bytes())
}

/// Deterministic ML-DSA-65 sign of the raw 32-byte digest with ctx = DOMAIN —
/// standard FIPS-204 pure mode (single M' wrap applied by the crate), matching
/// the deployed `mldsa65-lock-v2-rust` on-chain verifier. rnd = 0x00*32.
fn sign_deterministic(sk_bytes: &[u8; SK_LEN], digest: &[u8; 32]) -> Result<[u8; SIG_LEN], String> {
    let sk =
        ml::PrivateKey::try_from_bytes(*sk_bytes).map_err(|e| format!("sk parse: {:?}", e))?;
    sk.try_sign_with_seed(&[0u8; 32], digest, DOMAIN)
        .map_err(|e| format!("sign: {:?}", e))
}

/// Verify the way the deployed `mldsa65-lock-v2-rust` does: raw digest as the
/// message, DOMAIN as the FIPS-204 context (single M' wrap).
fn verify_mldsa65(pubkey: &[u8], signature: &[u8], digest: &[u8; 32]) -> Result<bool, String> {
    if pubkey.len() != PK_LEN {
        return Err(format!("pubkey length {} != {}", pubkey.len(), PK_LEN));
    }
    if signature.len() != SIG_LEN {
        return Err(format!("signature length {} != {}", signature.len(), SIG_LEN));
    }
    let mut pk_buf = [0u8; PK_LEN];
    pk_buf.copy_from_slice(pubkey);
    let pk = ml::PublicKey::try_from_bytes(pk_buf).map_err(|e| format!("pk parse: {:?}", e))?;
    let mut sig_buf = [0u8; SIG_LEN];
    sig_buf.copy_from_slice(signature);
    Ok(pk.verify(digest, &sig_buf, DOMAIN))
}

// ── vectors subcommand ────────────────────────────────────────────────────────

fn build_vectors() -> Result<VectorFile, String> {
    // keygen: three fixed seeds → (pubkey, secretKey, lockArgs).
    let keygen_seeds: [(&str, [u8; 32]); 3] = [
        ("seed-0x07", [0x07u8; 32]),
        ("seed-0x11", [0x11u8; 32]),
        ("seed-0x42", [0x42u8; 32]),
    ];
    let mut keygen = Vec::new();
    for (name, seed) in &keygen_seeds {
        let (pk_bytes, sk_bytes) = keygen_from_seed(seed);
        let args = lock_args(ParamId::Mldsa65, &pk_bytes);
        keygen.push(KeygenCase {
            name: name.to_string(),
            seed: hex::encode(seed),
            pubkey: hex::encode(pk_bytes),
            secret_key: hex::encode(sk_bytes),
            lock_args: hex::encode(args),
        });
    }

    // cighash: three fixed scenarios → (tx, resolved inputs, stream, digest, final).
    let scenarios = vec![
        scenario_single_input_empty_witness_fields(),
        scenario_two_inputs_extra_witness(),
        scenario_first_witness_input_output_type(),
    ];
    let mut cighash = Vec::new();
    let mut scenario_streams = Vec::new();
    for s in &scenarios {
        let (stream, digest, final_message) = run_pipeline(s)?;
        cighash.push(CighashCase {
            name: s.name.to_string(),
            tx: hex::encode(s.tx.data().as_slice()),
            resolved_inputs: s
                .resolved_inputs
                .iter()
                .map(|(co, data)| ResolvedInput {
                    cell_output: hex::encode(co.as_slice()),
                    data: hex::encode(data),
                })
                .collect(),
            group_input_indices: s.group_input_indices.clone(),
            stream: hex::encode(&stream),
            digest: hex::encode(digest),
            final_message: hex::encode(&final_message),
        });
        scenario_streams.push((stream, digest, final_message));
    }

    // sign: seed 0x07*32 over scenario (a)'s stream.
    let seed = [0x07u8; 32];
    let (pk_bytes, sk_bytes) = keygen_from_seed(&seed);
    let (stream, digest, final_message) = &scenario_streams[0];
    let sig_bytes = sign_deterministic(&sk_bytes, digest)?;

    // Self-verify before emitting — mirrors signing.rs's sanity check.
    if !verify_mldsa65(&pk_bytes, &sig_bytes, digest)? {
        return Err("self-verify failed on generated sign vector".to_string());
    }

    let mut witness_lock = Vec::with_capacity(WITNESS_LOCK_LEN);
    witness_lock.push(construct_flag(ParamId::Mldsa65, true)); // 0x7B
    witness_lock.extend_from_slice(&pk_bytes);
    witness_lock.extend_from_slice(&sig_bytes);
    if witness_lock.len() != WITNESS_LOCK_LEN {
        return Err(format!(
            "witness lock length {} != {}",
            witness_lock.len(),
            WITNESS_LOCK_LEN
        ));
    }

    let sign = vec![SignCase {
        name: "seed-0x07-single-input-empty-witness-fields".to_string(),
        seed: hex::encode(seed),
        stream: hex::encode(stream),
        digest: hex::encode(digest),
        final_message: hex::encode(final_message),
        pubkey: hex::encode(pk_bytes),
        signature: hex::encode(sig_bytes),
        witness_lock: hex::encode(witness_lock),
    }];

    Ok(VectorFile {
        vector_format_version: 1,
        suite: "mldsa-v2-signing",
        source: "tools/signing-harness (vendored key-vault-wasm ckb-fips204-utils @ 5cc0c1e, ML-DSA-65; FIPS-204 pure-mode framing ctx = DOMAIN, single wrap, matching deployed mldsa65-lock-v2-rust)",
        keygen,
        cighash,
        sign,
    })
}

fn cmd_vectors(args: &[String]) -> Result<(), String> {
    let out = opt_value(args, "--out").ok_or("vectors: missing --out <path>")?;
    let vectors = build_vectors()?;
    let json = serde_json::to_string_pretty(&vectors)
        .map_err(|e| format!("json serialize: {}", e))?;
    std::fs::write(&out, format!("{}\n", json)).map_err(|e| format!("write {}: {}", out, e))?;
    eprintln!("wrote {} ({} keygen, {} cighash, {} sign cases)", out, 3, 3, 1);
    Ok(())
}

// ── verify subcommand ─────────────────────────────────────────────────────────

fn cmd_verify(args: &[String]) -> Result<bool, String> {
    let pubkey_hex = opt_value(args, "--pubkey").ok_or("verify: missing --pubkey <hex>")?;
    let sig_hex = opt_value(args, "--signature").ok_or("verify: missing --signature <hex>")?;
    let stream_hex = opt_value(args, "--stream").ok_or("verify: missing --stream <hex>")?;

    let pubkey = decode_hex(&pubkey_hex).map_err(|e| format!("--pubkey: {}", e))?;
    let signature = decode_hex(&sig_hex).map_err(|e| format!("--signature: {}", e))?;
    let stream = decode_hex(&stream_hex).map_err(|e| format!("--stream: {}", e))?;

    // Recompute the digest from the stream, then verify with ctx = DOMAIN —
    // the exact framing the deployed mldsa65-lock-v2-rust applies on-chain.
    let (digest, _final_message) = final_message_from_stream(&stream)?;
    verify_mldsa65(&pubkey, &signature, &digest)
}

// ── tiny CLI plumbing ─────────────────────────────────────────────────────────

fn opt_value(args: &[String], name: &str) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().cloned();
        }
    }
    None
}

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).map_err(|e| e.to_string())
}

fn usage() {
    eprintln!(
        "usage:\n  \
         signing-harness vectors --out <path>\n  \
         signing-harness verify --pubkey <hex> --signature <hex> --stream <hex>"
    );
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("vectors") => match cmd_vectors(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {}", e);
                ExitCode::from(2)
            }
        },
        Some("verify") => match cmd_verify(&args[1..]) {
            Ok(true) => {
                println!("OK");
                ExitCode::SUCCESS
            }
            Ok(false) => {
                println!("FAIL");
                ExitCode::FAILURE
            }
            Err(e) => {
                eprintln!("error: {}", e);
                ExitCode::from(2)
            }
        },
        _ => {
            usage();
            ExitCode::from(2)
        }
    }
}
