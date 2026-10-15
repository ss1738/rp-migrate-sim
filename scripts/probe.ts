import { makeClient, readNetwork, readNodeMinipools, readNodeRpl, sampleNodes } from '../src/chain.ts';
const client = makeClient();
const net = await readNetwork(client);
console.log('NETWORK', JSON.stringify(net));
const nodes = await sampleNodes(client, 0, 5);
for (const n of nodes) {
  const mps = await readNodeMinipools(client, n);
  const rpl = await readNodeRpl(client, n);
  console.log(n, 'minipools', mps.length, JSON.stringify(mps.slice(0, 2)), 'rpl', JSON.stringify(rpl));
}
