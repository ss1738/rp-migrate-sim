import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SATURN1_CURVE,
  RPIP83_CURVE,
  evaluateMigration,
  eligibleEth,
  idleDays,
  legacyMinipoolYield,
  totalBondFor,
  validatorsFromBond,
  voterYieldPerEligibleEth,
  type MigrationInput,
  type NetworkState,
} from '../src/model.ts';

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} +/- ${tol}, got ${a}`);

// Reference values from the RPL fee switch calculator on rocketpool.net, listed in docs/SPEC.md. Copied by a third party, not loaded directly.
const R = 0.03;
const P = 0.000734;
const V = 2159;
const NET: NetworkState = {
  megapoolValidators: V,
  networkBorrowedEth: V * 28,
  networkEligibleEth: 3_441_819 * P, // all staked RPL treated as eligible, as in the capture
};
const IDLE = { exitDays: 0, queueDays: 0, entryDays: 0, rpip79: false, gasEth: 0 };

test('bond curve matches RPIP-42 ([4,8], reduced 4)', () => {
  assert.equal(totalBondFor(1, SATURN1_CURVE), 4);
  assert.equal(totalBondFor(2, SATURN1_CURVE), 8);
  assert.equal(totalBondFor(3, SATURN1_CURVE), 12);
  assert.equal(totalBondFor(4, SATURN1_CURVE), 16);
  assert.equal(validatorsFromBond(8, SATURN1_CURVE), 2);
  assert.equal(validatorsFromBond(16, SATURN1_CURVE), 4);
  assert.equal(validatorsFromBond(3.9, SATURN1_CURVE), 0);
});

test('bond curve for RPIP-83 draft ([6,12], reduced 6)', () => {
  assert.equal(validatorsFromBond(8, RPIP83_CURVE), 1);
  assert.equal(validatorsFromBond(16, RPIP83_CURVE), 2);
  assert.equal(totalBondFor(3, RPIP83_CURVE), 18);
});

test('node-operator income per 28 days, one validator (capture: 0.0124)', () => {
  const r = evaluateMigration({
    r: R, rplEthPrice: P, minipools: [{ bondEth: 4, contractCommission: 0 }], stakedRpl: 0, network: NET, idle: IDLE,
  });
  // bond 4 for one validator; evaluateMigration frees 4 ETH -> 1 validator
  close((r.megapoolNoYield * 28) / 365, 0.01243, 0.00002);
});

test('voter pool per 28 days (capture: 12.52 ETH)', () => {
  const pool = 0.09 * NET.networkBorrowedEth * R * (28 / 365);
  close(pool, 12.52, 0.01);
});

test('node voter income per 28 days with 3815 RPL (capture: 0.0139)', () => {
  const e = eligibleEth(4, 3815, P);
  close((e * voterYieldPerEligibleEth(NET, 0.09, R) * 28) / 365, 0.01388, 0.0001);
});

test('max eligible RPL uses bonded ETH cap (capture: 8176)', () => {
  close(6 / P, 8176, 8176 * 0.001);
});

test('8 ETH minipool at 14%: migrating loses yield without RPL (spec section 4)', () => {
  const inp: MigrationInput = {
    r: R, rplEthPrice: P, minipools: [{ bondEth: 8, contractCommission: 0.14 }], stakedRpl: 0, network: NET, idle: IDLE,
  };
  const res = evaluateMigration(inp);
  close(res.legacyYield, 0.3408, 1e-9);
  assert.equal(res.validators, 2);
  close(res.megapoolNoYield, 0.324, 1e-9);
  close(res.deltaEth, -0.0168, 1e-9);
  assert.equal(res.breakevenYears, null);
  close(res.rplNeededEth!, 0.26, 0.001);
  close(res.rplNeededRpl!, 354.2, 0.5);
});

test('8 ETH at 14% flips positive once enough RPL is staked', () => {
  const res = evaluateMigration({
    r: R, rplEthPrice: P, minipools: [{ bondEth: 8, contractCommission: 0.14 }], stakedRpl: 400, network: NET,
    idle: { exitDays: 10, queueDays: 20, entryDays: 30, rpip79: false, gasEth: 0.02 },
  });
  assert.ok(res.deltaEth > 0);
  assert.ok(res.breakevenYears! > 0);
});

test('16 ETH minipool at 15%: migrating gains yield (spec section 4)', () => {
  const res = evaluateMigration({
    r: R, rplEthPrice: P, minipools: [{ bondEth: 16, contractCommission: 0.15 }], stakedRpl: 0, network: NET, idle: IDLE,
  });
  close(res.legacyYield, 0.552, 1e-9);
  assert.equal(res.validators, 4);
  close(res.megapoolNoYield, 0.648, 1e-9);
  close(res.deltaEth, 0.096, 1e-9);
  assert.equal(res.rplNeededEth, 0);
});

test('legacy yield formula and unused bond', () => {
  close(legacyMinipoolYield({ bondEth: 8, contractCommission: 0.14 }, R), 0.3408, 1e-9);
  const res = evaluateMigration({
    r: R, rplEthPrice: P, minipools: [{ bondEth: 8, contractCommission: 0.14 }], stakedRpl: 0, network: NET,
    curve: RPIP83_CURVE, idle: IDLE,
  });
  assert.equal(res.validators, 1);
  close(res.unusedBond, 2, 1e-9);
});

test('idle days: RPIP-79 replaces two entry queues with one plus 0.5 day', () => {
  const base = { exitDays: 5, queueDays: 10, entryDays: 57, gasEth: 0 };
  assert.equal(idleDays({ ...base, rpip79: false }), 5 + 10 + 114);
  assert.equal(idleDays({ ...base, rpip79: true }), 5 + 10 + 57.5);
});

test('unreachable RPL threshold returns null', () => {
  // deficit so large that 1.5x bonded cap cannot cover it
  const res = evaluateMigration({
    r: R, rplEthPrice: P, minipools: [{ bondEth: 8, contractCommission: 0.2 }], stakedRpl: 0,
    network: { ...NET, networkEligibleEth: 1e9 }, idle: IDLE,
  });
  assert.equal(res.rplNeededEth, null);
});

import { assignmentsUntilServed, queueWaitDays } from '../src/model.ts';

test('queue sim: empty queues -> served immediately', () => {
  assert.equal(assignmentsUntilServed(0, 0, 4, 0, true), 1);
  assert.equal(assignmentsUntilServed(0, 0, 4, 0, false), 1);
});

test('queue sim: standard entry waits for express entries first (rate 4)', () => {
  // 8 express ahead, 0 standard ahead, index 0: slots E E E E S E E E E S...
  // standard slot at idx 4 is taken by us (standard queue otherwise empty besides us) -> served at assignment 5
  assert.equal(assignmentsUntilServed(8, 0, 4, 0, false), 5);
});

test('queue sim: express entry with 4 express ahead', () => {
  assert.equal(assignmentsUntilServed(4, 10, 4, 0, true), 6); // slots 0-3 serve the 4 ahead, slot 4 is the standard slot, ours at slot 5 -> 6th assignment
});

test('queue sim: falls through when express queue empty', () => {
  // no express entries, 3 standard ahead: every slot serves standard
  assert.equal(assignmentsUntilServed(0, 3, 4, 0, false), 4);
});

test('queueWaitDays', () => {
  assert.equal(queueWaitDays(300, 10), 30);
  assert.equal(queueWaitDays(5, 0), Infinity);
});

test('16 ETH minipool at 5% (live commission): migrating gains yield', () => {
  const res = evaluateMigration({
    r: R, rplEthPrice: P, minipools: [{ bondEth: 16, contractCommission: 0.05 }], stakedRpl: 0, network: NET, idle: IDLE,
  });
  close(res.legacyYield, 0.504, 1e-9);
  close(res.deltaEth, 0.144, 1e-9);
});

test('8 ETH minipool at 5%: migrating gains yield', () => {
  const res = evaluateMigration({
    r: R, rplEthPrice: P, minipools: [{ bondEth: 8, contractCommission: 0.05 }], stakedRpl: 0, network: NET, idle: IDLE,
  });
  close(res.legacyYield, 0.276, 1e-9);
  close(res.deltaEth, 0.048, 1e-9);
});
