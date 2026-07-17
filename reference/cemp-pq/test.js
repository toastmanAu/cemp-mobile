import { CEMPPQ, serializeEncryptedMessage, serializeMessagePointer } from './index.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem';

async function test() {
    console.log("Starting CEMP-PQ Protocol Tests...");

    // 1. Key Generation
    const seed = new Uint8Array(64).fill(0x01);
    const keys = ml_kem768.keygen(seed);
    console.log("✔ Keys generated");

    // 2. Encryption/Decryption
    const message = new TextEncoder().encode("Hello, this is a post-quantum encrypted message on CKB!");
    const encrypted = await CEMPPQ.encrypt(message, keys.publicKey);
    console.log("✔ Message encrypted, size:", encrypted.length);

    const decrypted = await CEMPPQ.decrypt(encrypted, keys.secretKey);
    const decryptedStr = new TextDecoder().decode(decrypted);
    console.log("✔ Message decrypted:", decryptedStr);

    if (decryptedStr === "Hello, this is a post-quantum encrypted message on CKB!") {
        console.log("✔ Integrity check PASSED");
    } else {
        console.error("✘ Integrity check FAILED");
        process.exit(1);
    }

    // 3. Pointer Serialization
    const txHash = new Uint8Array(32).fill(0x42);
    const pointer = serializeMessagePointer(txHash, 5);
    console.log("✔ Pointer serialized, size:", pointer.length);

    console.log("\nAll library tests PASSED!");
}

test()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
