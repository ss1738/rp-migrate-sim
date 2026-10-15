import { makeClient, readNodeMinipools, readNodeRpl, sampleNodes } from '../src/chain.ts';
const client = makeClient();
const start = Number(process.argv[2] ?? 400);
const nodes = await sampleNodes(client, start, 40);
for (const n of nodes) {
  const mps = (await readNodeMinipools(client, n)).filter((m) => !m.finalised && m.status === 2);
  if (mps.length === 0) continue;
  const rpl = await readNodeRpl(client, n);
  const bonds = mps.map((m) => `${m.bondEth}@${(m.contractCommission * 100).toFixed(1)}%`).join(',');
  console.log(n, 'active', mps.length, bonds, 'rpl', rpl.totalStaked.toFixed(1), 'legacy', rpl.legacyStaked.toFixed(1));
}
