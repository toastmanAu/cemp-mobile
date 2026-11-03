//! `envelope-v3` subcommand: independent cross-runtime check of the CEMP
//! protocol v3 envelope signature vectors (ADR 0007), written by the
//! TypeScript implementation to
//! `packages/cemp-test-vectors/vectors/cemp-v3-envelope.json`.
//!
//! For every signature case it
//!   1. verifies `signature` over `transcript` with `publicKey` and
//!      `verifyContext` using the Rust `fips204` crate (FIPS 204 pure mode,
//!      the context as the crate's ctx argument — single M' wrap), and
//!   2. for known-answer cases, regenerates the key from `signerSeed`, signs
//!      `signedMessage ?? transcript` with `signContext` and rnd = 0x00*32,
//!      and compares the result with `signature` byte for byte.
//!
//! For every accepted envelope case it REBUILDS the signing transcript from
//! the envelope and inner bytes with its own Molecule table parser/encoder
//! (no shared code with the TypeScript side) and checks that the rebuilt
//! transcript equals the vector's transcript and verifies under the sender
//! key. Decryption is not reproduced here (no ML-KEM/AES in this crate).
//!
//! Output: one line per case, `<kind> <name> verify=<OK|FAIL> <check>=<...>`.
//! The TypeScript interop test compares these lines with the recorded
//! expectations; this program does not decide pass/fail itself.

use fips204::ml_dsa_65 as ml;
use fips204::traits::{KeyGen, SerDes, Signer as _, Verifier as _};
use serde::Deserialize;

const PK_LEN: usize = 1952;
const SIG_LEN: usize = 3309;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignatureCase {
    name: String,
    signer_seed: String,
    sign_context: String,
    public_key: String,
    verify_context: String,
    transcript: String,
    signature: String,
    signed_message: Option<String>,
    known_answer: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvelopeCase {
    name: String,
    envelope_bytes: String,
    expect: String,
    sender_public_key: Option<String>,
    inner_bytes: Option<String>,
    transcript: Option<String>,
}

#[derive(Deserialize)]
struct VectorFile {
    signature: Vec<SignatureCase>,
    envelope: Vec<EnvelopeCase>,
}

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    hex::decode(s).map_err(|e| e.to_string())
}

/// Total verifier: any malformed input is a FAIL, never an error.
fn verify(pk: &[u8], msg: &[u8], sig: &[u8], ctx: &[u8]) -> bool {
    if pk.len() != PK_LEN || sig.len() != SIG_LEN {
        return false;
    }
    let mut pk_buf = [0u8; PK_LEN];
    pk_buf.copy_from_slice(pk);
    let Ok(pk) = ml::PublicKey::try_from_bytes(pk_buf) else {
        return false;
    };
    let mut sig_buf = [0u8; SIG_LEN];
    sig_buf.copy_from_slice(sig);
    pk.verify(msg, &sig_buf, ctx)
}

fn sign_deterministic(seed: &[u8], msg: &[u8], ctx: &[u8]) -> Result<Vec<u8>, String> {
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| "seed must be 32 bytes".to_string())?;
    let (_pk, sk) = ml::KG::keygen_from_seed(&seed);
    let sig = sk
        .try_sign_with_seed(&[0u8; 32], msg, ctx)
        .map_err(|e| format!("sign: {:?}", e))?;
    Ok(sig.to_vec())
}

// ── minimal Molecule table handling (independent of the TS codec) ─────────────

fn u32_le(b: &[u8], at: usize) -> Result<usize, String> {
    let s = b.get(at..at + 4).ok_or("truncated u32")?;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize)
}

/// Split a Molecule table into exactly `n` raw field slices (strict).
fn table_fields(b: &[u8], n: usize) -> Result<Vec<&[u8]>, String> {
    let total = u32_le(b, 0)?;
    if total != b.len() {
        return Err("table total size mismatch".into());
    }
    let first = u32_le(b, 4)?;
    if first != 4 + 4 * n {
        return Err(format!(
            "table has {} fields, expected {}",
            (first - 4) / 4,
            n
        ));
    }
    let mut offsets = Vec::with_capacity(n + 1);
    for i in 0..n {
        offsets.push(u32_le(b, 4 + 4 * i)?);
    }
    offsets.push(total);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        if offsets[i] > offsets[i + 1] || offsets[i + 1] > total {
            return Err("bad table offsets".into());
        }
        out.push(&b[offsets[i]..offsets[i + 1]]);
    }
    Ok(out)
}

fn table_encode(fields: &[&[u8]]) -> Vec<u8> {
    let header = 4 + 4 * fields.len();
    let total = header + fields.iter().map(|f| f.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(total as u32).to_le_bytes());
    let mut offset = header;
    for f in fields {
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += f.len();
    }
    for f in fields {
        out.extend_from_slice(f);
    }
    out
}

/// CempSigningTranscriptV3 from CempEnvelopeV3 (4 fields) + CempInnerV3 (7 fields).
fn rebuild_transcript(envelope: &[u8], inner: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let env = table_fields(envelope, 4)?;
    let inn = table_fields(inner, 7)?;
    if inn[5] != [0x01u8, 61] {
        return Err("sig_algorithm is not ML-DSA-65".into());
    }
    if inn[6].len() != SIG_LEN {
        return Err("signature field is not 3309 bytes".into());
    }
    // header, kem_ciphertext, nonce | sender, conversation, content_type,
    // created_at_client, payload
    let transcript = table_encode(&[
        env[0], env[1], env[2], inn[0], inn[1], inn[2], inn[3], inn[4],
    ]);
    Ok((transcript, inn[6].to_vec()))
}

pub fn cmd_envelope_v3(
    args: &[String],
    opt_value: fn(&[String], &str) -> Option<String>,
) -> Result<(), String> {
    let path = opt_value(args, "--vectors").ok_or("envelope-v3: missing --vectors <path>")?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path, e))?;
    let file: VectorFile = serde_json::from_str(&text).map_err(|e| format!("parse: {}", e))?;

    for c in &file.signature {
        let pk = unhex(&c.public_key)?;
        let transcript = unhex(&c.transcript)?;
        let sig = unhex(&c.signature)?;
        let ok = verify(&pk, &transcript, &sig, c.verify_context.as_bytes());
        let resign = if c.known_answer {
            let msg = match &c.signed_message {
                Some(m) => unhex(m)?,
                None => transcript.clone(),
            };
            let again =
                sign_deterministic(&unhex(&c.signer_seed)?, &msg, c.sign_context.as_bytes())?;
            if again == sig {
                "MATCH"
            } else {
                "MISMATCH"
            }
        } else {
            "SKIP"
        };
        println!(
            "signature {} verify={} resign={}",
            c.name,
            if ok { "OK" } else { "FAIL" },
            resign
        );
    }

    for c in &file.envelope {
        if c.expect != "accept" {
            println!("envelope {} verify=SKIP transcript=SKIP", c.name);
            continue;
        }
        let envelope = unhex(&c.envelope_bytes)?;
        let inner = unhex(
            c.inner_bytes
                .as_deref()
                .ok_or("accept case without innerBytes")?,
        )?;
        let expected = unhex(
            c.transcript
                .as_deref()
                .ok_or("accept case without transcript")?,
        )?;
        let pk = unhex(
            c.sender_public_key
                .as_deref()
                .ok_or("accept case without key")?,
        )?;
        let (rebuilt, sig) = rebuild_transcript(&envelope, &inner)?;
        let ok = verify(&pk, &rebuilt, &sig, b"CEMP-ENVELOPE-V3");
        println!(
            "envelope {} verify={} transcript={}",
            c.name,
            if ok { "OK" } else { "FAIL" },
            if rebuilt == expected {
                "MATCH"
            } else {
                "MISMATCH"
            }
        );
    }
    Ok(())
}
