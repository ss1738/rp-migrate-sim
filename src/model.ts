// Pure formula module for rp-migrate-sim. No I/O. See docs/SPEC.md for sources.
// All ETH amounts are in ETH, rates are fractions per year, times are in days.

export interface LegacyMinipool {
  bondEth: number; // 8 or 16
  contractCommission: number; // fraction, read from chain (getNodeFee)
}

export interface BondCurve {
  baseBondArray: number[]; // RPIP-42: [4, 8]; RPIP-83 (Draft): [6, 12]
  reducedBond: number; // RPIP-42: 4; RPIP-83 (Draft): 6
}

export const SATURN1_CURVE: BondCurve = { baseBondArray: [4, 8], reducedBond: 4 };
export const RPIP83_CURVE: BondCurve = { baseBondArray: [6, 12], reducedBond: 6 };

export interface NetworkState {
  megapoolValidators: number; // V
  networkBorrowedEth: number; // total borrowed ETH across megapools (V * 28 when bond is 4)
  networkEligibleEth: number; // sum over nodes of min(1.5*bonded, rpl*price), in ETH value
}

export interface Shares {
  nodeOperator: number; // RPIP-46 node_operator_commission_share, default 0.05
  councilAdder: number; // RPIP-46 council adder, 0..0.01
  voter: number; // RPIP-46 voter_share, default 0.09
}

export const RPIP46_SHARES: Shares = { nodeOperator: 0.05, councilAdder: 0, voter: 0.09 };

export interface IdleInputs {
  exitDays: number; // Beacon Chain exit queue + sweep
  queueDays: number; // Rocket Pool deposit queue wait
  entryDays: number; // Beacon Chain entry queue for one deposit
  rpip79: boolean; // false: two entry queues; true: one plus 0.5 day challenge window
  gasEth: number;
}

export interface MigrationInput {
  r: number; // annual yield per ETH staked
  rplEthPrice: number; // p
  minipools: LegacyMinipool[];
  stakedRpl: number; // RPL the node would stake as megapool voter stake
  network: NetworkState;
  curve?: BondCurve;
  shares?: Shares;
  legacyRplYieldEth?: number; // OPEN in spec: user input, default 0
  megapoolRplYieldEth?: number; // OPEN in spec: user input, default 0
  idle: IdleInputs;
}

export interface MigrationResult {
  legacyYield: number; // ETH/yr
  validators: number; // N
  bondUsed: number;
  unusedBond: number;
  megapoolNoYield: number;
  megapoolVoterYield: number;
  megapoolYield: number;
  deltaEth: number; // ETH/yr
  idleDays: number;
  costEth: number;
  breakevenYears: number | null; // null = never
  rplNeededEth: number | null; // eligible-RPL value (ETH) needed for delta >= 0; null = unreachable
  rplNeededRpl: number | null;
}

export const BORROW_TOTAL = 32;
export const VOTE_ELIGIBLE_MULTIPLE = 1.5; // RPIP-46: 1.5 * bonded ETH

/** Legacy minipool yield, per year. RPIP-62 (Final): commission = contract commission after the dynamic window. */
export function legacyMinipoolYield(m: LegacyMinipool, r: number): number {
  return r * (m.bondEth + (BORROW_TOTAL - m.bondEth) * m.contractCommission);
}

/** Total node bond required for n megapool validators (RPIP-42 lines 57-58). */
export function totalBondFor(n: number, curve: BondCurve): number {
  if (n <= 0) return 0;
  const arr = curve.baseBondArray;
  if (n <= arr.length) return arr[n - 1];
  return arr[arr.length - 1] + (n - arr.length) * curve.reducedBond;
}

/** Largest N whose total bond fits in the freed ETH. */
export function validatorsFromBond(freedEth: number, curve: BondCurve): number {
  let n = 0;
  while (totalBondFor(n + 1, curve) <= freedEth + 1e-9) n++;
  return n;
}

export function eligibleEth(bondedEth: number, stakedRpl: number, rplEthPrice: number): number {
  return Math.min(VOTE_ELIGIBLE_MULTIPLE * bondedEth, stakedRpl * rplEthPrice);
}

export function voterYieldPerEligibleEth(net: NetworkState, voterShare: number, r: number): number {
  return (voterShare * net.networkBorrowedEth * r) / net.networkEligibleEth;
}

/** Idle days: exit + queue + entry (RPIP-79 reduces two entry queues to one plus a 0.5 day window). */
export function idleDays(i: IdleInputs): number {
  const entry = i.rpip79 ? i.entryDays + 0.5 : 2 * i.entryDays;
  return i.exitDays + i.queueDays + entry;
}

export function evaluateMigration(inp: MigrationInput): MigrationResult {
  const curve = inp.curve ?? SATURN1_CURVE;
  const shares = inp.shares ?? RPIP46_SHARES;
  const { r } = inp;

  const legacyYield =
    inp.minipools.reduce((s, m) => s + legacyMinipoolYield(m, r), 0) + (inp.legacyRplYieldEth ?? 0);

  const freed = inp.minipools.reduce((s, m) => s + m.bondEth, 0);
  const n = validatorsFromBond(freed, curve);
  const bondUsed = totalBondFor(n, curve);
  const borrowed = BORROW_TOTAL * n - bondUsed;

  const noShare = shares.nodeOperator + shares.councilAdder;
  const megapoolNoYield = r * (bondUsed + borrowed * noShare);

  const eNode = eligibleEth(bondUsed, inp.stakedRpl, inp.rplEthPrice);
  const perEligible = voterYieldPerEligibleEth(inp.network, shares.voter - shares.councilAdder, r);
  const megapoolVoterYield = eNode * perEligible;

  const megapoolYield = megapoolNoYield + megapoolVoterYield + (inp.megapoolRplYieldEth ?? 0);
  const deltaEth = megapoolYield - legacyYield;

  const days = idleDays(inp.idle);
  const costEth = (legacyYield * days) / 365 + inp.idle.gasEth;
  const breakevenYears = deltaEth > 0 ? costEth / deltaEth : null;

  const baseDelta = megapoolNoYield + (inp.megapoolRplYieldEth ?? 0) - legacyYield;
  let rplNeededEth: number | null;
  if (baseDelta >= 0) rplNeededEth = 0;
  else {
    const need = -baseDelta / perEligible;
    rplNeededEth = need <= VOTE_ELIGIBLE_MULTIPLE * bondUsed ? need : null;
  }
  const rplNeededRpl = rplNeededEth === null ? null : rplNeededEth / inp.rplEthPrice;

  return {
    legacyYield,
    validators: n,
    bondUsed,
    unusedBond: freed - bondUsed,
    megapoolNoYield,
    megapoolVoterYield,
    megapoolYield,
    deltaEth,
    idleDays: days,
    costEth,
    breakevenYears,
    rplNeededEth,
    rplNeededRpl,
  };
}

/**
 * Assignments that happen up to and including ours when we join the back of a queue.
 * Mirrors RocketDepositPool._assignMegapools (contracts/contract/deposit/RocketDepositPool.sol):
 * slot is express unless queueIndex % (rate + 1) == rate; an empty preferred queue falls through to the other.
 * Ignores ETH availability; convert to days with a measured assignments-per-day rate.
 */
export function assignmentsUntilServed(
  expressAhead: number,
  standardAhead: number,
  expressRate: number,
  startQueueIndex: number,
  joinExpress: boolean,
): number {
  let e = expressAhead;
  let s = standardAhead;
  let idx = startQueueIndex;
  let n = 0;
  // our entry is served when the queue we joined has 0 entries ahead and we get the slot
  for (let guard = 0; guard < 10_000_000; guard++) {
    n++;
    let express = idx % (expressRate + 1) !== expressRate;
    const exL = joinExpress ? e + 1 : e; // include ourselves in our queue
    const stL = joinExpress ? s : s + 1;
    if (express && exL === 0) express = false;
    if (!express && stL === 0) express = true;
    if (express) {
      if (joinExpress && e === 0) return n;
      e = joinExpress ? e - 1 : Math.max(0, e - 1);
    } else {
      if (!joinExpress && s === 0) return n;
      s = joinExpress ? Math.max(0, s - 1) : s - 1;
    }
    idx++;
  }
  throw new Error('queue simulation did not terminate');
}

export function queueWaitDays(assignments: number, assignmentsPerDay: number): number {
  if (assignmentsPerDay <= 0) return Infinity;
  return assignments / assignmentsPerDay;
}
