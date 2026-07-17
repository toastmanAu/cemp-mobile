/**
 * CEMP-PQ Transaction Builder
 */

import { CEMPPQ, ML_DSA_TESTNET, getMlDsaConstants, serializeMessagePointer, serializeProfile, signingMessage, buildWitness } from './index.js';
import { ccc } from '@ckb-ccc/core';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa';

/**
 * Custom CCC Signer for ML-DSA-65
 */
export class MLDSASigner extends ccc.Signer {
    constructor(client, secretKey, publicKey, network = "testnet") {
        super(client);
        this.network = network;
        if (secretKey.length === 32) {
            const keys = ml_dsa65.keygen(secretKey);
            this.secretKey = keys.secretKey;
            this.publicKey = keys.publicKey;
        } else {
            this.secretKey = secretKey;
            this.publicKey = publicKey;
        }

        const mlDsa = getMlDsaConstants(network);

        // Derive lock args
        const pubkeyHash = ccc.bytesFrom(ccc.hashCkb(this.publicKey));
        const args = new Uint8Array(36);
        args[0] = 0x01; // version
        args[1] = 0x02; // algo_id
        args[2] = 0x02; // param_id
        args[3] = 0x00;
        args.set(pubkeyHash, 4);

        this.script = {
            codeHash: mlDsa.CODE_HASH,
            hashType: mlDsa.HASH_TYPE,
            args: ccc.hexFrom(args),
        };
    }

    async getAddressObjs() {
        return [await ccc.Address.fromScript(this.script, this.client)];
    }

    async getRecommendedAddressObj() {
        return (await this.getAddressObjs())[0];
    }

    get type() { return ccc.SignerType.CKB; }
    get signType() { return ccc.SignerSignType.Unknown; }
    async isConnected() { return true; }
    async connect() {}

    async prepareTransaction(tx) {
        const mlDsa = getMlDsaConstants(this.network);
        tx.addCellDeps({
            outPoint: {
                txHash: mlDsa.TX_HASH,
                index: mlDsa.INDEX,
            },
            depType: "code",
        });
        // ML-DSA signatures are large (~3300 bytes), we need to reserve space in witnesses
        await tx.prepareSighashAllWitness(this.script, 5300, this.client); // ~5300 for full WitnessArgs with ML-DSA
        return tx;
    }

    async signOnlyTransaction(tx) {
        const hasher = new ccc.HasherCkb();
        const txHash = ccc.bytesFrom(tx.hash());
        const msg = signingMessage(txHash);
        
        const sig = ml_dsa65.sign(this.secretKey, msg, new TextEncoder().encode('CKB-MLDSA-LOCK'));
        const witness = buildWitness(this.publicKey, sig);
        
        tx.witnesses[0] = ccc.hexFrom(witness);
        
        return tx;
    }
}

export class CEMPTransactionBuilder {
    constructor(client, network = "testnet") {
        this.client = client;
        this.network = network;
    }

    /**
     * Discovery: Fetch the recipient's Profile Cell.
     * Returns { mlDsaPubKey, mlKemPubKey, metadata } on hit, null on miss.
     * Profile molecule (per serializeProfile in index.js):
     *   total(4) | off_dsa(4)=16 | off_kem(4) | off_meta(4)
     *   | dsa_len(4) + dsa | kem_len(4) + kem | meta_len(4) + meta
     */
    async fetchRecipientProfile(recipientLock) {
        const typeIdCodeHash = "0x00000000000000000000000000000000000000000000000000545950455f4944";
        const cells = await this.client.findCells({
            script: recipientLock,
            scriptType: "lock",
            withData: true,
        });

        for await (const cell of cells) {
            if (cell.cellOutput.type && cell.cellOutput.type.codeHash === typeIdCodeHash) {
                const data = ccc.bytesFrom(cell.outputData);
                const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                const off_dsa = view.getUint32(4, true);
                const off_kem = view.getUint32(8, true);
                const off_meta = view.getUint32(12, true);
                const dsaLen = view.getUint32(off_dsa, true);
                const kemLen = view.getUint32(off_kem, true);
                const metaLen = view.getUint32(off_meta, true);
                return {
                    mlDsaPubKey: data.slice(off_dsa + 4, off_dsa + 4 + dsaLen),
                    mlKemPubKey: data.slice(off_kem + 4, off_kem + 4 + kemLen),
                    metadata: data.slice(off_meta + 4, off_meta + 4 + metaLen),
                };
            }
        }
        return null;
    }

    /**
     * Phase 0: Create a Profile Cell (One-time setup for users)
     */
    async buildCreateProfileTx(signer, mlDSAPubKey, mlKEMPubKey, metadata = "", feeRate = 1200n) {
        const lock = await signer.getRecommendedAddressObj();
        const profileData = serializeProfile(mlDSAPubKey, mlKEMPubKey, new TextEncoder().encode(metadata));

        const placeholderType = {
            codeHash: "0x00000000000000000000000000000000000000000000000000545950455f4944",
            hashType: "type",
            args: "0x0000000000000000000000000000000000000000000000000000000000000000",
        };

        const tx = ccc.Transaction.from({
            outputs: [{
                lock: lock.script,
                type: placeholderType,
                capacity: ccc.fixedPointFrom(0),
            }],
            outputsData: [ccc.hexFrom(profileData)]
        });

        await tx.completeInputsByCapacity(signer);

        // Compute deterministic Type ID and replace placeholder
        const typeIdArgs = ccc.hashTypeId(tx.inputs[0], 0);
        tx.outputs[0].type.args = typeIdArgs;

        await tx.completeFeeBy(signer, feeRate);
        return tx;
    }

    async buildSendMessageTx(senderSigner, recipientLock, message, feeRate = 1200n, recipientMLKEMPubKey = null) {
        const { script: senderLock } = await senderSigner.getRecommendedAddressObj();
        
        // 1. Discover Recipient's Public Key
        if (!recipientMLKEMPubKey) {
            const profile = await this.fetchRecipientProfile(recipientLock);
            if (!profile) {
                throw new Error("Recipient profile not found on-chain.");
            }
            recipientMLKEMPubKey = profile.mlKemPubKey;
        }

        // 2. Encrypt Message
        const encryptedData = await CEMPPQ.encrypt(new TextEncoder().encode(message), recipientMLKEMPubKey);

        // Phase 2.7b-1 fix (smoke iteration 2): the notification cell must be sized
        // for the MessagePointer before completeFeeBy runs, otherwise the cell capacity
        // gets pinned to the empty-data minimum (~77 CKB) and any post-completion
        // attempt to write the 52-byte pointer leaves the cell under-capacity. The
        // late mutation then gets silently dropped before serialization, and the
        // notification ships with empty data — invisible to receivers.
        //
        // Fix: pre-fill outputsData[1] with a 52-byte zero placeholder so
        // completeFeeBy sizes the cell to fit (~129 CKB). After fee completion we
        // overwrite the placeholder with the real pointer; the data length is
        // unchanged so the cell stays valid.
        const POINTER_PLACEHOLDER = new Uint8Array(52);

        const tx = ccc.Transaction.from({
            outputs: [
                // Output 1: Message Cell (Owned by Sender)
                {
                    lock: senderLock,
                    capacity: ccc.fixedPointFrom(0), // Will be calculated
                    type: null,
                },
                // Output 2: Notification Cell (Owned by Recipient)
                {
                    lock: recipientLock,
                    capacity: ccc.fixedPointFrom(0), // Will be calculated
                    type: null,
                }
            ],
            outputsData: [
                ccc.hexFrom(encryptedData),
                ccc.hexFrom(POINTER_PLACEHOLDER), // 52-byte placeholder — overwritten with real pointer after fee completion
            ]
        });

        // Add CellDeps for ML-DSA
        const mlDsa = getMlDsaConstants(this.network);
        tx.addCellDeps({
            outPoint: {
                txHash: mlDsa.TX_HASH,
                index: mlDsa.INDEX,
            },
            depType: "code",
        });

        // Complete the transaction (find inputs, calculate fees, etc.)
        await tx.completeInputsByCapacity(senderSigner);
        await tx.completeFeeBy(senderSigner, feeRate);

        // Overwrite the placeholder with the real pointer. Same byte length →
        // cell capacity stays valid; tx hash is stable through signing because
        // signOnlyTransaction only fills the witness, which is excluded from
        // tx.hash() per CCC's hashing rule.
        const messageTxHash = tx.hash();
        const messagePointer = serializeMessagePointer(messageTxHash, 0);
        if (messagePointer.length !== POINTER_PLACEHOLDER.length) {
            throw new Error(
                `serializeMessagePointer produced ${messagePointer.length} bytes, ` +
                `expected ${POINTER_PLACEHOLDER.length} — placeholder size out of sync.`,
            );
        }
        tx.outputsData[1] = ccc.hexFrom(messagePointer);

        return tx;
    }
}
