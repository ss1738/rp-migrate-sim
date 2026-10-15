import { makeClient, readNetwork, readQueueIndex, readAssignmentRate } from '../src/chain.ts';
import { assignmentsUntilServed, queueWaitDays } from '../src/model.ts';
const client = makeClient();
const net = await readNetwork(client);
const idx = await readQueueIndex(client);
const t0 = Date.now();
const logsClient = makeClient('https://rpc.mevblocker.io'); // free RPC that serves historical logs
const rate = await readAssignmentRate(logsClient, Number(process.argv[2] ?? 30));
console.log('measured', rate, `(${((Date.now() - t0) / 1000).toFixed(1)}s)`, 'queueIndex', idx, 'express', net.expressQueueLength, 'standard', net.standardQueueLength, 'rate', net.expressQueueRate);
for (const joinExpress of [true, false]) {
  const a = assignmentsUntilServed(net.expressQueueLength, net.standardQueueLength, net.expressQueueRate, idx, joinExpress);
  console.log(joinExpress ? 'new EXPRESS entry' : 'new STANDARD entry', 'assignments ahead incl. self:', a, 'wait days:', queueWaitDays(a, rate.perDay).toFixed(1));
}
