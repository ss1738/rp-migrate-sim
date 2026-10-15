import { makeClient, readNetwork, readNodeMinipools, readNodeRpl } from '../src/chain.ts';
import { evaluateMigration } from '../src/model.ts';
import type { Address } from 'viem';

const client = makeClient();
const net = await readNetwork(client);
const nodes = process.argv.slice(2) as Address[];
const r = 0.03; // illustrative yield, user input in the real tool
const V = net.megapoolValidatorCount;
const network = {
  megapoolValidators: V,
  networkBorrowedEth: V * 28, // approximation: every counted validator at 4 ETH bond
  networkEligibleEth: net.totalMegapoolStakedRpl * net.rplEthPrice, // upper bound on eligible ETH
};
const idle = { exitDays: 7, queueDays: Number(process.env.QUEUE_DAYS ?? 30), entryDays: 57, rpip79: false, gasEth: 0.02 }; // illustrative
console.log('network', { rplEthPrice: net.rplEthPrice, V, bondArray: net.baseBondArray, shares: [net.nodeShare, net.voterShare], express: net.expressQueueLength, standard: net.standardQueueLength });
for (const node of nodes) {
  const mps = (await readNodeMinipools(client, node)).filter((m) => !m.finalised && m.status === 2);
  const rpl = await readNodeRpl(client, node);
  for (const [label, stakedRpl] of [['no RPL as voter stake', 0], ['all legacy RPL moved to megapool', rpl.legacyStaked]] as const) {
    const res = evaluateMigration({
      r, rplEthPrice: net.rplEthPrice, stakedRpl, network, idle,
      minipools: mps.map((m) => ({ bondEth: m.bondEth, contractCommission: m.contractCommission })),
    });
    const f = (x: number | null, d = 4) => (x === null ? 'never/unreachable' : x.toFixed(d));
    console.log(node.slice(0, 10), `${mps.length}x minipools`, `[${label}]`, {
      legacy: f(res.legacyYield), mega: f(res.megapoolYield), delta: f(res.deltaEth), cost: f(res.costEth),
      breakevenYears: f(res.breakevenYears, 2), rplNeeded: f(res.rplNeededRpl, 0), validators: res.validators,
    });
  }
}
