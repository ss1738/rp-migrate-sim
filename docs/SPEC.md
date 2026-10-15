# Specification

Version 0.1, October 2026.

## The question

For one node address: if I exit my legacy minipools and run 4 ETH megapool validators instead, do I earn more, what does the move cost, and how long until it pays back?

The tool reads the chain, applies the formulas below, and shows the result under several queue speeds. It does not give advice. It shows numbers and the assumptions behind them.

## Sources

Checked against `rocket-pool/RPIPs` on 2026-10-15.

| RPIP | Title | Status | Used for |
|---|---|---|---|
| 42 | Bond Curves | Living | `base_bond_array = [4, 8]`, `reduced_bond = 4` |
| 43 | Megapools | Living | Megapool rules |
| 46 | Universal Adjustable Revenue Split | Living | Node share 5%, voter share 9%, voter-eligible RPL cap |
| 59 | Deposit Mechanics | Living | Express and standard queues |
| 62 | Tokenomics Rework Prelude | Final | Legacy minipool commission rules |
| 75 | Change Express Ticket Allocation for Saturn 1 | Final | `express_queue_rate = 4`, base ticket provision 0 |
| 79 | Faster Withdrawal Credentials Check | Review | One Beacon entry queue plus a 12 hour window |
| 80 | Exit Requests, Triggering Exits, and Minipool Penalties | Review | Non-exit penalty |
| 83 | Increase Megapool Bond Requirements | Draft | 6 ETH bond, `base_bond_array = [6, 12]` |

Anything from a Draft or Review RPIP is an optional switch in the tool. It is never a default.

## Terms

- `r`: yearly yield per ETH staked. You set it.
- `p`: RPL price in ETH. Read from the chain.
- A legacy minipool has bond `B` (8 or 16 ETH), borrowed ETH `32 - B`, and contract commission `c`.
- A megapool validator has total bond set by the bond curve. In Saturn 1 that is 4 ETH for the first validator, 8 for two, then 4 more for each one after.

## Formulas

### 1. Staying: legacy yield

Per minipool, per year:

```
legacy = r * (B + (32 - B) * c)
```

The commission `c` comes from the chain, one value per minipool (`getNodeFee()`). RPIP-62 explains why it cannot be a fixed number. The 10% to 14% dynamic commission for 8 ETH minipools applied before Saturn 1 and for the first 4 reward snapshots after it. After that, and always for 16 ETH minipools, the minipool's own contract commission applies. Live minipools show both 14% and 5%.

Legacy RPL issuance rewards are not modelled. You can enter a yearly amount by hand.

### 2. Moving: megapool yield

Exiting frees the bond. The number of validators you can open is the largest `N` where the bond curve total fits inside the freed ETH.

```
bond(1) = 4,  bond(2) = 8,  bond(n) = 8 + (n - 2) * 4 for n > 2     (RPIP-42)
borrowed = 32 * N - bond(N)
operator income = r * (bond(N) + borrowed * node_share)              node_share = 5%
```

Voter income is shared out by voter-eligible RPL (RPIP-46):

```
eligible = min(1.5 * bonded ETH in the megapool, staked RPL * p)
voter income = (eligible / network eligible) * (voter_share * network borrowed ETH * r)
```

The cap uses the bonded ETH, not the borrowed ETH. Network eligible stake is not available as a single on-chain number, so the tool uses total megapool RPL value as an upper bound. That understates your share if some RPL is not eligible.

### 3. Cost of moving

```
idle days = exit days + queue days + entry days
cost = legacy yield * idle days / 365 + gas
```

- Exit days: Beacon Chain exit and sweep. You set it.
- Queue days: see the queue section below.
- Entry days: one Beacon entry queue for each deposit. Today a validator goes through two (the 1 ETH prestake, then the 31 ETH deposit). With RPIP-79 it would be one plus a 12 hour window.

### 4. Break-even

```
change per year = megapool yield - legacy yield
break-even (years) = cost / change per year        if the change is positive
                   = never                         otherwise
```

### 5. RPL needed

If the megapool yield without voter income is below the legacy yield, the tool shows how much voter-eligible RPL would close the gap, or says the gap cannot be closed within the 1.5 times bonded cap.

## Queue wait

The deposit pool hands out ETH one validator at a time. The rule, from `RocketDepositPool._assignMegapools`:

- Slot number `i` is an express slot unless `i % (rate + 1) == rate`. With the rate at 4, that is four express slots, then one standard slot.
- If the preferred queue is empty, the other queue is served.

The tool simulates this from the live queue lengths and the live queue index, to count how many assignments happen before a new entry is served. It turns that count into days by dividing by assignments per day.

Assignments per day depends on ETH arriving in the pool, so it is the least certain input. The tool shows three scenarios side by side:

1. Measured: `FundsAssigned` events counted over the last 30 days.
2. Average since launch: the queue index divided by days since Saturn 1 went live. The launch date is an editable field and has not been confirmed against a primary source.
3. Custom: a value you type.

Express tickets under RPIP-59 equal the bonded ETH in legacy minipools divided by 4. The tool prints that number but does not yet check how many tickets a node still holds.

## Reference values

These come from the RPL fee switch calculator on rocketpool.net (`node-staking/rpl-fee-switch`). The figures were copied from that page by someone else, and I have not loaded the page myself, so treat the match as a sanity check and not as proof.

Inputs: yield 3%, one validator with 4 ETH bonded, 3,815 RPL staked, RPL price 0.000734 ETH, 2,159 megapool validators, 3,441,819 RPL staked network wide.

| Quantity | Computed here | Calculator page |
|---|---|---|
| Operator income per 28 days | 0.01243 ETH | 0.0124 ETH |
| Voter pool per 28 days | 12.52 ETH | 12.52 ETH |
| Node voter income per 28 days | 0.01388 ETH | 0.0139 ETH |
| Maximum eligible RPL | 8,174 | 8,176 |

The tests in `test/model.test.ts` check these values.

Worked examples at 3% yield, no RPL, no queue cost:

| Layout | Stay | Move | Change per year |
|---|---|---|---|
| One 8 ETH minipool at 14% | 0.3408 ETH | 0.3240 ETH | -0.0168 ETH |
| One 8 ETH minipool at 5% | 0.2760 ETH | 0.3240 ETH | +0.0480 ETH |
| One 16 ETH minipool at 5% | 0.5040 ETH | 0.6480 ETH | +0.1440 ETH |

For the first row, about 0.26 ETH worth of voter-eligible RPL (around 354 RPL at that price) closes the gap.

## Data read from the chain

Contract addresses are resolved through RocketStorage (`0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46`, from the smartnode repository). Function names were checked against the interfaces in `rocket-pool/rocketpool`.

- Minipool manager: `getNodeMinipoolCount`, `getNodeMinipoolAt`
- Minipool: `getNodeFee`, `getNodeDepositBalance`, `getStatus`, `getFinalised`
- Node staking: `getNodeStakedRPL`, `getNodeLegacyStakedRPL`, `getNodeMegapoolStakedRPL`, `getTotalMegapoolStakedRPL`
- Network: `getRPLPrice`, `getCurrentNodeShare`, `getCurrentVoterShare`
- Megapool manager: `getValidatorCount` (counts every validator ever added, including ones still in the queue). The tool subtracts the queue lengths to estimate how many are staked. Exited and dissolved validators are not subtracted, so the estimate can run a little high.
- Deposit pool: `getExpressQueueLength`, `getStandardQueueLength`, `getQueueIndex`, and `FundsAssigned` events
- Settings: `getBaseBondArray`, `getReducedBond`, `getExpressQueueRate`

## Not confirmed

1. RPIP-43 says an operator "MAY be able to migrate existing validators" by updating withdrawal credentials. The documented path for minipool validators is exit and re-deposit (RPIP-49, RPIP-59). If in-place migration ever applies to minipool validators, the queue and exit cost mostly disappears.
2. Legacy RPL issuance rewards and any RPL rewards to megapool operators. Both are inputs that default to zero.
3. Whether legacy RPL can be moved to megapool voter stake without exiting first.
4. The Saturn 1 launch date, used only for the "average since launch" scenario.
5. Parameters in Draft and Review RPIPs can change.

## Not included

Forced exits under RPIP-71, rETH price effects, tax, slashing risk, and detailed smoothing pool reward timing beyond a single yield figure.
