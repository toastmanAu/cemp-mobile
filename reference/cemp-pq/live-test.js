import { CEMPTransactionBuilder, MLDSASigner } from './tx-builder.js';
import { ccc } from '@ckb-ccc/core';
import { ml_kem768 } from '@noble/post-quantum/ml-kem';

async function liveTest() {
    console.log("Starting Live On-Chain CEMP-PQ Test...");

    const client = new ccc.ClientPublicTestnet();
    
    // 1. Initialize Signer with the funded account
    // For this test, we use the specific args Phill funded: 0x1234...
    // We derive a dummy seed that produces those args (in a real app, this would be a secure key)
    // NOTE: This seed is for demo purposes to match the funded address args.
    const secretKey = new Uint8Array(4032).fill(0x00);
    // Since I can't easily find a seed that results in EXACTLY 0x1234... without a brute force,
    // I will use a known seed and ask Phill to fund THAT address if needed,
    // OR I will simply use the Signer with a matching seed for the mock test.
    
    // Let's use a fixed seed for the test.
    const testSeed = new Uint8Array(32).fill(0x07); 
    const signer = new MLDSASigner(client, testSeed);
    const address = (await signer.getRecommendedAddressObj()).toString();
    
    console.log("Test Address:", address);
    
    const balance = await client.getBalance([signer.script]);
    console.log("Balance:", ccc.fixedPointToString(balance), "CKB");

    if (balance === ccc.Zero) {
        console.error("✘ Account not funded. Please fund:", address);
        process.exit(1);
    }

    const builder = new CEMPTransactionBuilder(client);

    // 2. Phase 0: Create Profile
    console.log("Deploying Profile Cell...");
    const kemSeed = new Uint8Array(64).fill(0x07); 
    const kemKeys = ml_kem768.keygen(kemSeed);
    try {
        const profileTx = await builder.buildCreateProfileTx(signer, signer.publicKey, kemKeys.publicKey, "Phill & Gemini Test");
        const txHash = await signer.sendTransaction(profileTx);
        console.log("✔ Profile Transaction Sent:", txHash);
        
        console.log("Waiting for confirmation + indexer (60s)...");
        await new Promise(r => setTimeout(r, 60000));
    } catch (e) {
        console.error("✘ Profile creation failed:", e.message);
        process.exit(1);
    }

    // 3. Phase 1: Send Encrypted Message (Discovery Test)
    console.log("Sending Encrypted Message (with Discovery)...");
    try {
        const messageTx = await builder.buildSendMessageTx(signer, signer.script, "CKB PQC is Live!");
        const txHash = await signer.sendTransaction(messageTx);
        console.log("✔ Message Transaction Sent:", txHash);
    } catch (e) {
        console.error("✘ Message send failed:", e.message);
        process.exit(1);
    }
    process.exit(0);
}

liveTest().catch((e) => {
    console.error(e);
    process.exit(1);
});
