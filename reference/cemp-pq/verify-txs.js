/**
 * Confirm the two live-test txs landed on chain.
 */
import { ccc } from '@ckb-ccc/core';

const txs = {
    profile: '0x765d3d9019335ea221590f61b0ce9c82cd29b7514b6cc638af6584f19a15e7ed',
    message: '0x224eee0549fac21f063bd5d971bb0eb779da8d5c7125e95825cd784f3c579a7d',
};

const client = new ccc.ClientPublicTestnet();

for (const [phase, hash] of Object.entries(txs)) {
    const resp = await client.getTransaction(hash);
    if (!resp) {
        console.log(phase, hash, '→ NOT FOUND');
        continue;
    }
    console.log(phase, hash);
    console.log('  status:', resp.status);
    if (resp.blockHash) console.log('  block :', resp.blockHash);
}

process.exit(0);
