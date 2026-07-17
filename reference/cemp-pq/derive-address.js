/**
 * Derive the testnet address for the live-test.js seed so it can be funded.
 */
import { MLDSASigner } from './tx-builder.js';
import { ccc } from '@ckb-ccc/core';

const testSeed = new Uint8Array(32).fill(0x07);

const client = new ccc.ClientPublicTestnet();
const signer = new MLDSASigner(client, testSeed);
const addr = await signer.getRecommendedAddressObj();

console.log('Lock script:');
console.log('  codeHash:', signer.script.codeHash);
console.log('  hashType:', signer.script.hashType);
console.log('  args    :', signer.script.args);
console.log('Testnet address:');
console.log('  ', addr.toString());

const balance = await client.getBalance([signer.script]);
console.log('Balance:', ccc.fixedPointToString(balance), 'CKB');

process.exit(0);
