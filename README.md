# rp-migrate-sim

A read-only calculator for Rocket Pool node operators who run legacy minipools. It answers one question: if I exit and run 4 ETH megapool validators instead, do I earn more, and how long until the move pays back?

You paste a node address. The page reads your active minipools and the live deposit queue straight from the contracts, then shows the result under three queue speeds. It never asks for a wallet and never sends a transaction.

## Why the queue matters

Moving means exiting, waiting in the Rocket Pool deposit queue, then waiting through the Beacon Chain entry queue. During that time the ETH earns nothing. How long the queue takes depends on how fast ETH arrives, which changes a lot. So the tool shows the break-even under a measured speed, a long-run average, and a speed you type in, side by side.

## What it reads

- Your active legacy minipools: bond and contract commission, per minipool
- Your staked RPL
- The bond curve, the revenue shares (5% operator, 9% voter), and the RPL price
- The express and standard queue lengths, the queue index, and the number of `FundsAssigned` events over the last 30 days

Contract names are resolved through RocketStorage. The function names and RPIP numbers behind each calculation are listed in [docs/SPEC.md](docs/SPEC.md).

## What you set yourself

Yield per ETH, days to exit on the Beacon Chain, days in the Beacon entry queue, gas, how much RPL you would stake as voter stake, and any legacy RPL rewards you would lose. Each one is labelled on the page.

RPIP-79 and RPIP-83 are switches, because they are not final.

## Run it

You need Node 22 or newer.

```
npm install
npm run dev        # local page
npm run build      # static files in dist/
npm test           # model tests
npm run typecheck
```

`npm run build` produces plain static files, so any static host works.

The page needs two RPC endpoints. The default read endpoint is a free public node. The 30-day queue rate needs a node that serves old logs, and free nodes often refuse that. If the measurement fails, the page says so and the other two scenarios still work. Both endpoints can be changed under "RPC settings".

## Command line scripts

These run against Ethereum mainnet and are mainly for checking the data layer.

```
node scripts/probe.ts                 # network values and a few sample nodes
node scripts/find-active.ts 400       # find nodes with active minipools, starting at index 400
node scripts/e2e.ts 0xNODE...         # full model run for one or more addresses
node scripts/queue.ts 30              # queue wait from a 30 day measured rate
```

## Limits

- Legacy RPL rewards are not modelled. You can enter them by hand.
- The voter-eligible stake across the network is an upper bound, because there is no single on-chain figure for it. Voter income can be understated.
- The number of megapool validators counts every validator added, whatever its status.
- Assignments per day depends on ETH arriving, so any single measurement can be off.
- The tool does not check how many express tickets a node still holds.
- Draft and Review RPIPs can change.

The full list of open questions is in [docs/SPEC.md](docs/SPEC.md).

## Sources

Rocket Pool Improvement Proposals 42, 43, 46, 49, 59, 62, 75, 79, 80 and 83, and the contract interfaces in `rocket-pool/rocketpool`. The spec lists which RPIP each number comes from and its status.

## Feedback

If a number looks wrong for your node, open an issue with the address and what you expected. Corrections to the formulas are welcome, with a link to the RPIP or contract line that supports them.

## License

MIT. See [LICENSE](LICENSE).
