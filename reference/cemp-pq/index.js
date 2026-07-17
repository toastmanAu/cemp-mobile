/**
 * CEMP-PQ Protocol Library
 *
 * Implements the CKB Post-Quantum Encrypted Messaging Protocol.
 */

import { ml_kem768 } from '@noble/post-quantum/ml-kem';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa';
import { blake2b } from '@noble/hashes/blake2b';
import { ccc } from '@ckb-ccc/core';

// ── Constants ──────────────────────────────────────────────────────────────

export const ML_DSA_TESTNET = {
    CODE_HASH: '0x8984f4230ded4ac1f5efee2b67fef45fcda08bd6344c133a2f378e2f469d310d',
    HASH_TYPE: 'type',
    TX_HASH: '0xba4a6560ef719b24d170bf678611b25b799c56e6a80f18ce9c79e9561085cba7',
    INDEX: 0,
};

/**
 * Placeholder for the mainnet CEMP-PQ contract deployment. All four fields are
 * null until the upstream `~/ecms/cemp-pq/` project deploys the lock script on
 * CKB mainnet. Code consuming this should check `CODE_HASH === null` and
 * throw a clear "not deployed" error rather than building txs with null deps.
 */
export const ML_DSA_MAINNET = {
    CODE_HASH: null,
    HASH_TYPE: null,
    TX_HASH: null,
    INDEX: null,
};

/**
 * Return the ML-DSA lock constants for the given network. Throws if the
 * caller tries to use a network where the contract isn't deployed.
 */
export function getMlDsaConstants(network) {
    if (network === 'mainnet') {
        if (ML_DSA_MAINNET.CODE_HASH === null) {
            throw new Error('CEMP-PQ contract not deployed on mainnet');
        }
        return ML_DSA_MAINNET;
    }
    if (network === 'testnet') return ML_DSA_TESTNET;
    throw new Error(`Unknown CKB network: ${network}`);
}

export const CEMP_PQ_PROFILE_CODE_HASH = '0x0000000000000000000000000000000000000000000000000000000000000001'; // Placeholder for Type Script
export const CEMP_PQ_PROFILE_HASH_TYPE = 'type';

export const ARGS_VERSION  = 0x01;
export const ARGS_ALGO_ID  = 0x02;
export const ARGS_PARAM_ID = 0x02;

/** Domain separation context string passed to ML-DSA sign/verify. */
export const DOMAIN = new TextEncoder().encode('CKB-MLDSA-LOCK');

const CKB_PERSONAL = new TextEncoder().encode('ckb-default-hash');

// ── Molecule Serialization (Manual) ────────────────────────────────────────

function writeU32LE(buf, offset, value) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setUint32(offset, value, true);
}

function serializeBytes(data) {
    const buf = new Uint8Array(4 + data.length);
    writeU32LE(buf, 0, data.length);
    buf.set(data, 4);
    return buf;
}

/**
 * Profile table:
 * full_size(4) | off_dsa(4) | off_kem(4) | off_meta(4) | 
 * dsa_bytes(4+1952) | kem_bytes(4+1184) | meta_bytes(4+N)
 */
export function serializeProfile(dsaPubKey, kemPubKey, metadata = new Uint8Array(0)) {
    const dsa_ser = serializeBytes(dsaPubKey);
    const kem_ser = serializeBytes(kemPubKey);
    const meta_ser = serializeBytes(metadata);

    const HDR = 4 + 3 * 4;
    const TOTAL = HDR + dsa_ser.length + kem_ser.length + meta_ser.length;
    const buf = new Uint8Array(TOTAL);

    writeU32LE(buf, 0, TOTAL);
    writeU32LE(buf, 4, HDR);
    writeU32LE(buf, 8, HDR + dsa_ser.length);
    writeU32LE(buf, 12, HDR + dsa_ser.length + kem_ser.length);

    buf.set(dsa_ser, HDR);
    buf.set(kem_ser, HDR + dsa_ser.length);
    buf.set(meta_ser, HDR + dsa_ser.length + kem_ser.length);

    return buf;
}

/**
 * EncryptedMessage table:
 * full_size(4) | off_kem(4) | off_nonce(4) | off_ciphertext(4) | 
 * kem_bytes(4+N) | nonce_bytes(4+N) | cipher_bytes(4+N)
 */
export function serializeEncryptedMessage(kem, nonce, ciphertext) {
    const kem_ser = serializeBytes(kem);
    const nonce_ser = serializeBytes(nonce);
    const cipher_ser = serializeBytes(ciphertext);

    const HDR = 4 + 3 * 4;
    const TOTAL = HDR + kem_ser.length + nonce_ser.length + cipher_ser.length;
    const buf = new Uint8Array(TOTAL);

    writeU32LE(buf, 0, TOTAL);
    writeU32LE(buf, 4, HDR);
    writeU32LE(buf, 8, HDR + kem_ser.length);
    writeU32LE(buf, 12, HDR + kem_ser.length + nonce_ser.length);

    buf.set(kem_ser, HDR);
    buf.set(nonce_ser, HDR + kem_ser.length);
    buf.set(cipher_ser, HDR + kem_ser.length + nonce_ser.length);

    return buf;
}

/**
 * MessagePointer table:
 * full_size(4) | off_tx(4) | off_idx(4) | tx_bytes(4+32) | uint32(4)
 */
export function serializeMessagePointer(txHash, index) {
    const tx_ser = serializeBytes(txHash);
    const HDR = 4 + 2 * 4;
    const TOTAL = HDR + tx_ser.length + 4;
    const buf = new Uint8Array(TOTAL);

    writeU32LE(buf, 0, TOTAL);
    writeU32LE(buf, 4, HDR);
    writeU32LE(buf, 8, HDR + tx_ser.length);

    buf.set(tx_ser, HDR);
    writeU32LE(buf, HDR + tx_ser.length, index);

    return buf;
}

// ── Cryptography ────────────────────────────────────────────────────────────

export function ckbBlake2b(data) {
    return blake2b(data, { dkLen: 32, personalization: CKB_PERSONAL });
}

/**
 * Compute the CKB-MLDSA signing digest:
 *   blake2b_256("CKB-MLDSA-LOCK" || txHash)
 */
export function signingMessage(txHash) {
    const h = blake2b.create({ dkLen: 32, personalization: CKB_PERSONAL });
    h.update(DOMAIN);
    h.update(txHash);
    return h.digest();
}

/**
 * Serialize an MldsaWitness Molecule table (6 fields).
 */
export function serializeMldsaWitness(pubkey, sig) {
    const HDR = 4 + 6 * 4; 
    const TOTAL = HDR + 1 + 1 + 1 + 1 + 4 + 1952 + 4 + 3309;

    const buf = new Uint8Array(TOTAL);
    const view = new DataView(buf.buffer);

    writeU32LE(buf, 0, TOTAL);

    let off = HDR;
    writeU32LE(buf, 4,  off); off += 1; // version
    writeU32LE(buf, 8,  off); off += 1; // algo_id
    writeU32LE(buf, 12, off); off += 1; // param_id
    writeU32LE(buf, 16, off); off += 1; // flags
    writeU32LE(buf, 20, off); off += 4 + 1952; // pubkey
    writeU32LE(buf, 24, off);            // sig

    let cursor = HDR;
    buf[cursor++] = ARGS_VERSION;
    buf[cursor++] = ARGS_ALGO_ID;
    buf[cursor++] = ARGS_PARAM_ID;
    buf[cursor++] = 0x00; // flags

    writeU32LE(buf, cursor, 1952); cursor += 4;
    buf.set(pubkey, cursor); cursor += 1952;

    writeU32LE(buf, cursor, 3309); cursor += 4;
    buf.set(sig, cursor);

    return buf;
}

/**
 * Wrap lock data in a WitnessArgs Molecule table (lock field only).
 */
export function buildWitness(pubkey, sig) {
    const lockData = serializeMldsaWitness(pubkey, sig);
    const HDR = 4 + 3 * 4; 
    const TOTAL = HDR + 4 + lockData.length;

    const buf = new Uint8Array(TOTAL);
    const view = new DataView(buf.buffer);

    writeU32LE(buf, 0, TOTAL);
    writeU32LE(buf, 4, HDR);                    
    writeU32LE(buf, 8, TOTAL); 
    writeU32LE(buf, 12, TOTAL); 

    writeU32LE(buf, HDR, lockData.length);
    buf.set(lockData, HDR + 4);

    return buf;
}

export class CEMPPQ {
    /**
     * Encrypt a message for a recipient using ML-KEM-768.
     */
    static async encrypt(message, recipientPublicKey) {
        const { cipherText: kemCiphertext, sharedSecret } = ml_kem768.encapsulate(recipientPublicKey);
        
        // Use the shared secret to derive a symmetric key (simple Blake2b for now)
        const symKey = blake2b(sharedSecret, { dkLen: 32, personalization: new TextEncoder().encode('CEMP-PQ-SYM-KEY_') });
        
        const key = await globalThis.crypto.subtle.importKey(
            "raw",
            symKey,
            { name: "AES-GCM" },
            false,
            ["encrypt"]
        );
        const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const encryptedBuffer = await globalThis.crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv: nonce
            },
            key,
            message
        );
        const ciphertext = new Uint8Array(encryptedBuffer);

        return serializeEncryptedMessage(kemCiphertext, nonce, ciphertext);
    }

    /**
     * Decrypt a message using ML-KEM-768.
     */
    static async decrypt(encryptedData, recipientSecretKey) {
        const view = new DataView(encryptedData.buffer, encryptedData.byteOffset, encryptedData.byteLength);
        const off_kem = view.getUint32(4, true);
        const off_nonce = view.getUint32(8, true);
        const off_cipher = view.getUint32(12, true);

        const kemLen = view.getUint32(off_kem, true);
        const kemCiphertext = encryptedData.slice(off_kem + 4, off_kem + 4 + kemLen);

        const nonceLen = view.getUint32(off_nonce, true);
        const nonce = encryptedData.slice(off_nonce + 4, off_nonce + 4 + nonceLen);

        const cipherLen = view.getUint32(off_cipher, true);
        const ciphertext = encryptedData.slice(off_cipher + 4, off_cipher + 4 + cipherLen);

        const sharedSecret = ml_kem768.decapsulate(kemCiphertext, recipientSecretKey);
        const symKey = blake2b(sharedSecret, { dkLen: 32, personalization: new TextEncoder().encode('CEMP-PQ-SYM-KEY_') });

        const key = await globalThis.crypto.subtle.importKey(
            "raw",
            symKey,
            { name: "AES-GCM" },
            false,
            ["decrypt"]
        );

        const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: nonce
            },
            key,
            ciphertext
        );

        return new Uint8Array(decryptedBuffer);
    }
}

// Re-export tx-builder symbols so downstream code can import from "cemp-pq" (root).
export { MLDSASigner, CEMPTransactionBuilder } from './tx-builder.js';
