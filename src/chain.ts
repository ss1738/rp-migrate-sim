// Read-only on-chain data layer. Function names verified against
// rocket-pool/rocketpool contracts/interface/*.sol (2026-10-15). Contract addresses are
// resolved at runtime through RocketStorage, never hard-coded except RocketStorage itself.
import { createPublicClient, http, parseAbi, parseAbiItem, encodePacked, keccak256, type Address, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';

// Source: rocket-pool/smartnode shared/services/rocketpool/assets/install/networks-default.yml
export const ROCKET_STORAGE: Address = '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46';

const storageAbi = parseAbi(['function getAddress(bytes32 key) view returns (address)']);
const minipoolManagerAbi = parseAbi([
  'function getNodeMinipoolCount(address nodeAddress) view returns (uint256)',
  'function getNodeMinipoolAt(address nodeAddress, uint256 index) view returns (address)',
]);
const minipoolAbi = parseAbi([
  'function getNodeFee() view returns (uint256)',
  'function getNodeDepositBalance() view returns (uint256)',
  'function getStatus() view returns (uint8)',
  'function getFinalised() view returns (bool)',
]);
const nodeStakingAbi = parseAbi([
  'function getNodeStakedRPL(address nodeAddress) view returns (uint256)',
  'function getNodeLegacyStakedRPL(address nodeAddress) view returns (uint256)',
  'function getNodeMegapoolStakedRPL(address nodeAddress) view returns (uint256)',
  'function getTotalMegapoolStakedRPL() view returns (uint256)',
  'function getTotalLegacyStakedRPL() view returns (uint256)',
]);
const nodeManagerAbi = parseAbi([
  'function getNodeCount() view returns (uint256)',
  'function getNodeAt(uint256 index) view returns (address)',
]);
const pricesAbi = parseAbi(['function getRPLPrice() view returns (uint256)']);
const megapoolManagerAbi = parseAbi(['function getValidatorCount() view returns (uint256)']);
const revenuesAbi = parseAbi([
  'function getCurrentNodeShare() view returns (uint256)',
  'function getCurrentVoterShare() view returns (uint256)',
]);
const nodeSettingsAbi = parseAbi([
  'function getReducedBond() view returns (uint256)',
  'function getBaseBondArray() view returns (uint256[])',
]);
const depositPoolAbi = parseAbi([
  'function getExpressQueueLength() view returns (uint256)',
  'function getStandardQueueLength() view returns (uint256)',
]);
const depositSettingsAbi = parseAbi(['function getExpressQueueRate() view returns (uint256)']);

const WAD = 1e18;
const toEth = (x: bigint): number => Number(x) / WAD;

export function makeClient(rpcUrl = 'https://ethereum-rpc.publicnode.com'): PublicClient {
  return createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
}

export async function resolveContract(client: PublicClient, name: string): Promise<Address> {
  const key = keccak256(encodePacked(['string', 'string'], ['contract.address', name]));
  const addr = await client.readContract({ address: ROCKET_STORAGE, abi: storageAbi, functionName: 'getAddress', args: [key] });
  if (/^0x0{40}$/i.test(addr)) throw new Error(`RocketStorage has no address for ${name}`);
  return addr;
}

export interface NodeMinipool {
  address: Address;
  bondEth: number;
  contractCommission: number; // fraction
  status: number;
  finalised: boolean;
}

export async function readNodeMinipools(client: PublicClient, node: Address): Promise<NodeMinipool[]> {
  const manager = await resolveContract(client, 'rocketMinipoolManager');
  const count = Number(await client.readContract({ address: manager, abi: minipoolManagerAbi, functionName: 'getNodeMinipoolCount', args: [node] }));
  const out: NodeMinipool[] = [];
  for (let i = 0; i < count; i++) {
    const address = await client.readContract({ address: manager, abi: minipoolManagerAbi, functionName: 'getNodeMinipoolAt', args: [node, BigInt(i)] });
    const [fee, bond, status, finalised] = await Promise.all([
      client.readContract({ address, abi: minipoolAbi, functionName: 'getNodeFee' }),
      client.readContract({ address, abi: minipoolAbi, functionName: 'getNodeDepositBalance' }),
      client.readContract({ address, abi: minipoolAbi, functionName: 'getStatus' }),
      client.readContract({ address, abi: minipoolAbi, functionName: 'getFinalised' }),
    ]);
    out.push({ address, bondEth: toEth(bond), contractCommission: toEth(fee), status: Number(status), finalised });
  }
  return out;
}

export interface NodeRpl {
  totalStaked: number;
  legacyStaked: number;
  megapoolStaked: number;
}

export async function readNodeRpl(client: PublicClient, node: Address): Promise<NodeRpl> {
  const staking = await resolveContract(client, 'rocketNodeStaking');
  const [t, l, m] = await Promise.all([
    client.readContract({ address: staking, abi: nodeStakingAbi, functionName: 'getNodeStakedRPL', args: [node] }),
    client.readContract({ address: staking, abi: nodeStakingAbi, functionName: 'getNodeLegacyStakedRPL', args: [node] }),
    client.readContract({ address: staking, abi: nodeStakingAbi, functionName: 'getNodeMegapoolStakedRPL', args: [node] }),
  ]);
  return { totalStaked: toEth(t), legacyStaked: toEth(l), megapoolStaked: toEth(m) };
}

export interface NetworkSnapshot {
  rplEthPrice: number;
  megapoolValidatorCount: number; // every validator ever added, including queued ones
  megapoolValidatorsStakedEstimate: number; // count minus validators still waiting in the queues
  totalMegapoolStakedRpl: number;
  nodeShare: number;
  voterShare: number;
  baseBondArray: number[];
  reducedBond: number;
  expressQueueLength: number;
  standardQueueLength: number;
  expressQueueRate: number;
}

export async function readNetwork(client: PublicClient): Promise<NetworkSnapshot> {
  const [prices, mpManager, staking, revenues, nodeSettings, pool, depSettings] = await Promise.all([
    resolveContract(client, 'rocketNetworkPrices'),
    resolveContract(client, 'rocketMegapoolManager'),
    resolveContract(client, 'rocketNodeStaking'),
    resolveContract(client, 'rocketNetworkRevenues'),
    resolveContract(client, 'rocketDAOProtocolSettingsNode'),
    resolveContract(client, 'rocketDepositPool'),
    resolveContract(client, 'rocketDAOProtocolSettingsDeposit'),
  ]);
  const [price, v, totalMp, nodeShare, voterShare, bondArr, reduced, expLen, stdLen, rate] = await Promise.all([
    client.readContract({ address: prices, abi: pricesAbi, functionName: 'getRPLPrice' }),
    client.readContract({ address: mpManager, abi: megapoolManagerAbi, functionName: 'getValidatorCount' }),
    client.readContract({ address: staking, abi: nodeStakingAbi, functionName: 'getTotalMegapoolStakedRPL' }),
    client.readContract({ address: revenues, abi: revenuesAbi, functionName: 'getCurrentNodeShare' }),
    client.readContract({ address: revenues, abi: revenuesAbi, functionName: 'getCurrentVoterShare' }),
    client.readContract({ address: nodeSettings, abi: nodeSettingsAbi, functionName: 'getBaseBondArray' }),
    client.readContract({ address: nodeSettings, abi: nodeSettingsAbi, functionName: 'getReducedBond' }),
    client.readContract({ address: pool, abi: depositPoolAbi, functionName: 'getExpressQueueLength' }),
    client.readContract({ address: pool, abi: depositPoolAbi, functionName: 'getStandardQueueLength' }),
    client.readContract({ address: depSettings, abi: depositSettingsAbi, functionName: 'getExpressQueueRate' }),
  ]);
  return {
    rplEthPrice: toEth(price),
    megapoolValidatorCount: Number(v),
    megapoolValidatorsStakedEstimate: Math.max(0, Number(v) - Number(expLen) - Number(stdLen)),
    totalMegapoolStakedRpl: toEth(totalMp),
    nodeShare: toEth(nodeShare),
    voterShare: toEth(voterShare),
    baseBondArray: bondArr.map(toEth),
    reducedBond: toEth(reduced),
    expressQueueLength: Number(expLen),
    standardQueueLength: Number(stdLen),
    expressQueueRate: Number(rate),
  };
}

export async function sampleNodes(client: PublicClient, fromIndex: number, n: number): Promise<Address[]> {
  const mgr = await resolveContract(client, 'rocketNodeManager');
  const out: Address[] = [];
  for (let i = fromIndex; i < fromIndex + n; i++) {
    out.push(await client.readContract({ address: mgr, abi: nodeManagerAbi, functionName: 'getNodeAt', args: [BigInt(i)] }));
  }
  return out;
}

const queueIndexAbi = parseAbi(['function getQueueIndex() view returns (uint256)']);
const fundsAssignedEvent = parseAbiItem('event FundsAssigned(address indexed receiver, uint256 amount, uint256 time)');

export async function readQueueIndex(client: PublicClient): Promise<number> {
  const pool = await resolveContract(client, 'rocketDepositPool');
  return Number(await client.readContract({ address: pool, abi: queueIndexAbi, functionName: 'getQueueIndex' }));
}

export interface AssignmentRate {
  windowDays: number;
  assignments: number;
  perDay: number;
}

/** Measured throughput: FundsAssigned events on RocketDepositPool over the trailing window (12 s blocks). */
export async function readAssignmentRate(client: PublicClient, windowDays = 30, chunk = 10_000n): Promise<AssignmentRate> {
  const pool = await resolveContract(client, 'rocketDepositPool');
  const head = await client.getBlockNumber();
  const span = BigInt(Math.round(windowDays * 7200));
  let from = head - span;
  let count = 0;
  while (from <= head) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    const logs = await client.getLogs({ address: pool, event: fundsAssignedEvent, fromBlock: from, toBlock: to });
    count += logs.length;
    from = to + 1n;
  }
  return { windowDays, assignments: count, perDay: count / windowDays };
}
