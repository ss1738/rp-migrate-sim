import { isAddress, type Address } from 'viem';
import {
  makeClient, readAssignmentRate, readNetwork, readNodeMinipools, readNodeRpl, readQueueIndex,
  type NetworkSnapshot, type NodeMinipool, type NodeRpl,
} from './chain.ts';
import {
  RPIP83_CURVE, SATURN1_CURVE, assignmentsUntilServed, evaluateMigration, queueWaitDays, type MigrationResult,
} from './model.ts';

const DEFAULT_RPC = 'https://ethereum-rpc.publicnode.com';
const DEFAULT_LOGS_RPC = 'https://rpc.mevblocker.io';
const SATURN1_LAUNCH = '2026-02-18'; // search-reported, not from a primary source; editable

interface Loaded {
  node: Address;
  net: NetworkSnapshot;
  queueIndex: number;
  minipools: NodeMinipool[];
  rpl: NodeRpl;
  rate30: number | null; // assignments per day, null until measured
}

let loaded: Loaded | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const f = (x: number, d = 4) => x.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
const years = (y: number | null) => (y === null ? 'never' : y > 50 ? '> 50 years' : `${f(y, 1)} years`);

document.getElementById('app')!.innerHTML = `
  <h1>Minipool to megapool: break-even</h1>
  <p class="sub">Enter a node address. The tool reads your active legacy minipools and the live queue, then estimates whether exiting to run 4 ETH megapool validators pays off, and when. Read-only: no wallet, no transactions. An estimate, not advice.</p>

  <section class="card">
    <h2>1. Node address</h2>
    <div class="row">
      <input type="text" id="addr" placeholder="0x… node address" spellcheck="false" autocomplete="off" />
      <button id="load">Load</button>
    </div>
    <p class="status" id="status"></p>
    <details><summary>RPC settings</summary>
      <div class="grid" style="margin-top:8px">
        <label>Read RPC<input type="text" id="rpc" value="${DEFAULT_RPC}" /></label>
        <label>Log RPC (needs history)<input type="text" id="logsrpc" value="${DEFAULT_LOGS_RPC}" /></label>
      </div>
      <p class="note">Free public RPCs often refuse old log queries. If the 30-day rate fails, set your own archive RPC.</p>
    </details>
  </section>

  <section class="card" id="mpcard" hidden>
    <h2>2. Your active legacy minipools</h2>
    <div id="mptable"></div>
  </section>

  <section class="card" id="inputs" hidden>
    <h2>3. Assumptions</h2>
    <div class="grid">
      <label>Network yield per ETH (%/yr)<span class="tag assumed">assumed</span><input type="number" id="r" value="3" step="0.1" min="0" /></label>
      <label>Beacon exit + sweep (days)<span class="tag assumed">assumed</span><input type="number" id="exitd" value="7" min="0" /></label>
      <label>Beacon entry queue per deposit (days)<span class="tag assumed">assumed</span><input type="number" id="entryd" value="57" min="0" /></label>
      <label>Gas for the whole move (ETH)<span class="tag assumed">assumed</span><input type="number" id="gas" value="0.02" step="0.005" min="0" /></label>
      <label>RPL staked as megapool voter stake<select id="rplmode"><option value="none">None</option><option value="legacy">All current legacy RPL</option><option value="custom">Custom</option></select></label>
      <label>Custom RPL amount<input type="number" id="rplcustom" value="0" min="0" /></label>
      <label>Legacy RPL rewards you would lose (ETH/yr)<span class="tag assumed">not modelled</span><input type="number" id="legrpl" value="0" step="0.01" min="0" /></label>
      <label>Join queue as<select id="joinq"><option value="express">Express (uses a ticket)</option><option value="standard">Standard</option></select></label>
      <label>Saturn 1 launch date<span class="tag assumed">editable</span><input type="text" id="launch" value="${SATURN1_LAUNCH}" /></label>
      <label>Custom assignments/day<input type="number" id="customrate" value="10" step="0.5" min="0.1" /></label>
    </div>
    <div class="row" style="margin-top:10px">
      <label><input type="checkbox" id="rpip79" /> RPIP-79 single entry queue <span class="tag draft">Review</span></label>
      <label><input type="checkbox" id="rpip83" /> RPIP-83 6 ETH bond <span class="tag draft">Draft</span></label>
    </div>
  </section>

  <section class="card" id="results" hidden>
    <h2>4. Result by queue speed</h2>
    <p class="note">The queue is limited by ETH arriving, so its speed is the biggest unknown. Pick the scenario you believe; all are shown.</p>
    <div id="restable"></div>
  </section>

  <section class="card" id="detail" hidden></section>

  <section class="card note">
    <strong>Sources.</strong> Formulas follow RPIP-42, 46, 59, 62, 75 (Final/Living); RPIP-79, 80 (Review) and RPIP-83 (Draft) are optional toggles.
    Network values are read live from the Rocket Pool contracts. Yield, exit and entry times, gas, legacy RPL rewards are assumptions you can change.
    Network eligible stake is an upper bound (all megapool RPL counted), so voter income is understated if some RPL is not vote-eligible.
  </section>
`;

function setStatus(msg: string, error = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (error ? ' err' : '');
}

async function load() {
  const raw = $<HTMLInputElement>('addr').value.trim();
  if (!isAddress(raw)) return setStatus('That is not a valid address.', true);
  $('load').setAttribute('disabled', '');
  try {
    setStatus('Reading network and node…');
    const client = makeClient($<HTMLInputElement>('rpc').value.trim() || DEFAULT_RPC);
    const [net, queueIndex, mpAll, rpl] = await Promise.all([
      readNetwork(client), readQueueIndex(client), readNodeMinipools(client, raw), readNodeRpl(client, raw),
    ]);
    const minipools = mpAll.filter((m) => !m.finalised && m.status === 2);
    loaded = { node: raw, net, queueIndex, minipools, rpl, rate30: null };
    if (minipools.length === 0) {
      setStatus('No active legacy minipools found for this address (finalised or exited minipools are ignored).', true);
      for (const id of ['mpcard', 'inputs', 'results', 'detail']) $(id).hidden = true;
      return;
    }
    renderMinipools();
    for (const id of ['mpcard', 'inputs', 'results', 'detail']) $(id).hidden = false;
    recompute();
    setStatus('Measuring the 30-day queue rate (about 15 seconds)…');
    try {
      const logs = makeClient($<HTMLInputElement>('logsrpc').value.trim() || DEFAULT_LOGS_RPC);
      loaded.rate30 = (await readAssignmentRate(logs, 30)).perDay;
      setStatus('Loaded. 30-day rate measured.');
    } catch {
      setStatus('Loaded. Could not measure the 30-day rate (RPC refused log history); other scenarios still work.', true);
    }
    recompute();
  } catch (e) {
    setStatus(`Failed: ${(e as Error).message.split('\n')[0]}`, true);
  } finally {
    $('load').removeAttribute('disabled');
  }
}

function renderMinipools() {
  const { minipools, rpl } = loaded!;
  const rows = minipools.map((m) => `<tr><td>${esc(m.address.slice(0, 10))}…</td><td class="num">${f(m.bondEth, 0)} ETH</td><td class="num">${f(m.contractCommission * 100, 1)}%</td></tr>`).join('');
  const bond = minipools.reduce((s, m) => s + m.bondEth, 0);
  $('mptable').innerHTML = `
    <table><thead><tr><th>Minipool</th><th class="num">Bond</th><th class="num">Commission (on chain)</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="note">Total bond ${f(bond, 0)} ETH. Legacy RPL staked: ${f(rpl.legacyStaked, 1)}. Express tickets under RPIP-59: bonded ETH ÷ 4 = ${f(bond / 4, 0)} (consumed one per validator).</p>`;
}

interface Scenario { name: string; perDay: number | null; }

function scenarios(): Scenario[] {
  const l = loaded!;
  const launch = new Date($<HTMLInputElement>('launch').value).getTime();
  const days = Number.isFinite(launch) ? Math.max(1, (Date.now() - launch) / 86_400_000) : NaN;
  return [
    { name: 'Measured last 30 days', perDay: l.rate30 },
    { name: 'Average since Saturn 1', perDay: Number.isFinite(days) ? l.queueIndex / days : null },
    { name: 'Custom', perDay: Number($<HTMLInputElement>('customrate').value) || null },
  ];
}

function runFor(perDay: number): { res: MigrationResult; queueDays: number } {
  const l = loaded!;
  const express = $<HTMLSelectElement>('joinq').value === 'express';
  const useCurve83 = $<HTMLInputElement>('rpip83').checked;
  const a = assignmentsUntilServed(l.net.expressQueueLength, l.net.standardQueueLength, l.net.expressQueueRate, l.queueIndex, express);
  const queueDays = queueWaitDays(a, perDay);
  const mode = $<HTMLSelectElement>('rplmode').value;
  const stakedRpl = mode === 'legacy' ? l.rpl.legacyStaked : mode === 'custom' ? Number($<HTMLInputElement>('rplcustom').value) || 0 : 0;
  const V = l.net.megapoolValidatorCount;
  const res = evaluateMigration({
    r: (Number($<HTMLInputElement>('r').value) || 0) / 100,
    rplEthPrice: l.net.rplEthPrice,
    minipools: l.minipools.map((m) => ({ bondEth: m.bondEth, contractCommission: m.contractCommission })),
    stakedRpl,
    network: { megapoolValidators: V, networkBorrowedEth: V * 28, networkEligibleEth: l.net.totalMegapoolStakedRpl * l.net.rplEthPrice },
    curve: useCurve83 ? RPIP83_CURVE : SATURN1_CURVE,
    legacyRplYieldEth: Number($<HTMLInputElement>('legrpl').value) || 0,
    idle: {
      exitDays: Number($<HTMLInputElement>('exitd').value) || 0,
      queueDays,
      entryDays: Number($<HTMLInputElement>('entryd').value) || 0,
      rpip79: $<HTMLInputElement>('rpip79').checked,
      gasEth: Number($<HTMLInputElement>('gas').value) || 0,
    },
  });
  return { res, queueDays };
}

function recompute() {
  if (!loaded) return;
  const sc = scenarios();
  const rows = sc.map((s) => {
    if (s.perDay === null) return `<tr><td>${esc(s.name)}</td><td colspan="4" class="muted">not available</td></tr>`;
    const { res, queueDays } = runFor(s.perDay);
    const cls = res.deltaEth > 0 ? 'good' : 'bad';
    return `<tr><td>${esc(s.name)} <span class="muted">(${f(s.perDay, 1)}/day)</span></td><td class="num">${f(queueDays, 0)} d</td><td class="num ${cls}">${f(res.deltaEth)} ETH/yr</td><td class="num">${f(res.costEth)} ETH</td><td class="num"><strong>${years(res.breakevenYears)}</strong></td></tr>`;
  }).join('');
  $('restable').innerHTML = `<table><thead><tr><th>Scenario</th><th class="num">Queue wait</th><th class="num">Yield change</th><th class="num">Cost of moving</th><th class="num">Break-even</th></tr></thead><tbody>${rows}</tbody></table>`;

  const base = sc.find((s) => s.perDay !== null)!;
  const { res } = runFor(base.perDay!);
  const need = res.rplNeededRpl === null ? 'not reachable with the 1.5× bonded cap' : res.rplNeededRpl === 0 ? 'none needed' : `${f(res.rplNeededRpl, 0)} RPL`;
  $('detail').innerHTML = `
    <h2>Detail (${esc(base.name)})</h2>
    <div class="grid">
      <div><div class="muted">Stay: legacy yield</div><div class="big">${f(res.legacyYield)} ETH/yr</div></div>
      <div><div class="muted">Move: ${res.validators} validators</div><div class="big">${f(res.megapoolYield)} ETH/yr</div></div>
      <div><div class="muted">Voter stake needed for yield to match</div><div class="big">${esc(need)}</div></div>
    </div>
    <p class="note">Megapool yield = operator share (5%) of borrowed-ETH rewards plus your slice of the 9% voter share, pro rata to vote-eligible RPL (capped at 1.5× bonded ETH). Unused bond: ${f(res.unusedBond, 1)} ETH. Cost = yield forgone while waiting (exit + queue + entry) plus gas.</p>`;
}

$('load').addEventListener('click', load);
$('addr').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') load(); });
for (const id of ['r', 'exitd', 'entryd', 'gas', 'rplmode', 'rplcustom', 'legrpl', 'joinq', 'launch', 'customrate', 'rpip79', 'rpip83']) {
  $(id).addEventListener('input', recompute);
  $(id).addEventListener('change', recompute);
}
