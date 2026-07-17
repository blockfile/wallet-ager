# Reclaim: sweep ETH from child wallets

**Date:** 2026-07-17
**Status:** Approved, ready for implementation plan

## Problem

`wallet-ager` funds fresh child wallets daily from each main wallet. That ETH is
currently one-directional: it flows out and never comes back. The existing
`gather` command sweeps **main wallets only** to the supermain — `gather.js`
loops over `cfg.mainWallets` and nothing else, as documented in `README.md` and
`COMMANDS.txt` ("the daily child wallets keep their ETH").

Nothing is unrecoverable: every child's private key and seed phrase is written to
`output/<main>/wallets-<main>-day<N>.json` before any funding happens
(`runner.js` saves keys first, deliberately). The tooling to sweep them back
simply does not exist.

This spec adds a `reclaim` command that sweeps child-wallet ETH to the supermain.

## Goals

- Recover ETH from child wallets across all main wallets and all days.
- Reuse one audited money-moving code path, shared with `gather`.
- Match `gather`'s existing safety model exactly — no new safety concepts.

## Non-goals

- Sweeping ERC-20 tokens or NFTs. Native ETH only.
- Deleting, archiving, or otherwise mutating `output/` files. Reclaim reads only.
- Touching the supermain's funds. One-directional, as with `gather`.
- Changing the daily aging behaviour or the worker loop.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Destination | `cfg.superMainWallet` | Same destination `gather` uses; reuses existing config; one pile. |
| Scope | All children, filterable via `--name` / `--day` | Covers "reclaim everything" while allowing surgical runs. |
| Execution | Sequential, awaiting each confirmation | Mirrors `gather` and `fundWallets`; gentle on a rate-limited RPC; debuggable. |
| Architecture | Extract a shared sweeper | Avoids two divergent copies of the code that sends real ETH. |
| Drain policy | Drain fully, same `2 x fee` margin as `gather` | Maximum recovery; consistent with existing behaviour. |
| Confirm prompt | Show child **count** only | Count is free (on disk). ETH total needs a full balance pass; `--dry` covers that. |

### Caveat: reclaim is not a full refund

Each child received `amountEth` (default `0.0005`) and spent nothing, so it holds
roughly that amount. `computeSweepValue` holds back `2 x fee` but the sweep
spends only `1 x fee`, so **about one fee's worth of dust is permanently
stranded in each child**. On Robinhood Chain (an Arbitrum L2) that is fractions
of a cent per wallet, but it scales with child count. This is accepted, not a
bug: the margin is what keeps the send from failing on gas.

### Note: sweeping does not undo aging

A wallet's transaction history is permanent. Draining a child adds one more
transaction rather than erasing anything, so reclaiming does not forfeit the
aging the wallet has accrued.

## Architecture

Pure logic separated from IO, matching the existing codebase style
(`computeSweepValue` and `canAffordBatch` are already pure and tested that way).

### `src/sweeper.js` (new)

Extracted from `gather.js`, verbatim where possible:

- `computeSweepValue(balanceWei, feeWei, marginTimes = 2n)` — moved unchanged.
- `estimateSweepFee(provider, signer, to)` — moved, now exported.
- `sweepAll(provider, targets, to, { dryRun }) -> results[]` — new shared loop.

`targets` is `[{ label, signer }]`. Each result is
`{ label, address, balance, sweep, txHash, skipped, error }` — the record
`gather` already returns, plus `label`. Sequential; `await tx.wait(1)` per send;
per-target `try/catch` so one failure never aborts the run.

### `src/gather.js` (changed)

Shrinks to: validate `superMainWallet` -> build signers from `cfg.mainWallets` ->
delegate to `sweepAll`. Its exported signature and result shape are **unchanged**,
so `cli.js`'s `cmdGather` needs no edits.

`computeSweepValue` moves out to `sweeper.js`. `test/gather.test.js` imports it
from `../src/gather.js` today and tests nothing else, so that whole file moves to
`test/sweeper.test.js` (see Testing).

`gather.js` does **not** re-export `computeSweepValue` for backwards
compatibility: nothing outside the moved test imports it, so a re-export would be
dead code.

### `src/storage.js` (changed)

Three additions — two pure, one thin shell:

- `parseChildWallets(payload)` — **pure**. One parsed day-file payload ->
  `[{ main, day, index, address, privateKey }]`. Reads `payload.mainWallet`,
  `payload.day`, and each `payload.wallets[]` entry.
- `filterChildren(children, { name, day })` — **pure**. Filters by main-wallet
  name and/or day. Absent filters mean "no restriction".
- `loadChildWallets({ name, day })` — thin `readdirSync` walk over `output/`,
  mirroring `exportAllTxt`'s structure and its skip-malformed-JSON behaviour.
  Returns `[]` when `output/` does not exist.

### `src/reclaim.js` (new)

`reclaimFunds(cfg, { dryRun, name, day }) -> results[]`:

1. Fail loudly if `cfg.superMainWallet` is unset (same message style as `gather`).
2. `loadChildWallets({ name, day })`.
3. Dedupe by address — defensive; a reset day-counter could in principle have
   overwritten a file, and sweeping one address twice is pointless.
4. Build a signer per child; label each `main-1/day3#4`.
5. Delegate to `sweepAll(provider, targets, cfg.superMainWallet, { dryRun })`.

### `src/cli.js` (changed)

`cmdReclaim(argv)` mirroring `cmdGather`'s safety model exactly:

- `--dry` -> preview, sends nothing. `cfg.dryRun` also forces preview.
- Real run in a TTY -> `confirm` prompt showing the destination and child count.
- Real run headless -> requires `--yes`, else refuse and exit 1.
- Missing `superMainWallet` -> error with guidance, exit 1.
- `--name <main>` / `--day <N>` filters.

Plus a `Reclaim` menu entry, and a usage line:
`reclaim flags: [--dry] [--yes] [--name <n>] [--day <N>]`.

Output is a table like `gather`'s, keyed by label, closing with a summary:
count swept / skipped / errored and total ETH recovered.

### `package.json` (changed)

Add `"reclaim": "node src/cli.js reclaim"`.

### Docs (changed)

`README.md` and `COMMANDS.txt`: document `reclaim`, and correct the existing
"child wallets keep their ETH" lines to point at the new command. Include the
dust caveat and the `--dry`-first recommendation.

## Data flow

```
output/<main>/wallets-<main>-dayN.json
  -> storage.loadChildWallets({ name?, day? })      [thin IO; skips bad JSON]
       -> storage.parseChildWallets(payload)        [pure]
       -> storage.filterChildren(children, filters) [pure]
  -> [{ main, day, index, address, privateKey }]
  -> reclaim.reclaimFunds(cfg, { dryRun, name, day })
       -> dedupe by address
       -> makeSigner per child
       -> sweeper.sweepAll(provider, targets, cfg.superMainWallet, { dryRun })
            -> estimateSweepFee -> computeSweepValue -> sendTransaction
  -> [{ label, address, balance, sweep, txHash, skipped, error }]
  -> cli prints table + summary
```

## Error handling

| Condition | Behaviour |
|---|---|
| `output/` missing or empty | Friendly "no child wallets found" message; exit 0. |
| Malformed JSON in `output/` | File skipped silently, as `exportAllTxt` does. |
| Child key missing/malformed | Error row in the results table; run continues. |
| Zero / dust balance | `computeSweepValue` returns `0n` -> skipped "balance too low to cover gas". Covers dry-run batches and failed fundings naturally. |
| Send fails (RPC, nonce, gas) | Error row; run continues to the next child. |
| `superMainWallet` unset | Hard fail with guidance before any network call; exit 1. |
| Headless real run without `--yes` | Refuse; exit 1. |

## Testing

All tests pure — the existing suite has no filesystem or network tests and this
spec does not introduce any.

- `test/sweeper.test.js` — the three existing `computeSweepValue` tests, moved
  from `test/gather.test.js` with assertions unchanged (margin held back, zero
  when balance can't cover the reserve, never negative). Only the import path
  changes: `../src/gather.js` -> `../src/sweeper.js`.
- `test/gather.test.js` — **deleted**. It contains nothing but those three
  tests, so it is empty once they move.
- `test/storage.test.js` — add: `parseChildWallets` on a realistic `runner.js`
  payload; `filterChildren` by name; by day; by both; with no filters.
- `test/reclaim.test.js` — dedupe-by-address; label formatting
  (`main-1/day3#4`); empty input.

`sweepAll` is not unit-tested against a mock provider: its decision logic lives
in `computeSweepValue`, which is tested directly, and the remainder is ethers
plumbing. Verified manually instead (below).

## Verification

Before any mainnet use, in order:

1. `npm test` — full suite green.
2. `node src/cli.js reclaim --dry` on **testnet** with real generated children —
   confirm the table lists them and sends nothing.
3. `node src/cli.js reclaim` on **testnet** — confirm ETH lands on the supermain
   and balances drop to dust.
4. `node src/cli.js gather --dry` — confirm the refactor left gather's output
   identical to before.

## Risks

- **Refactoring live money code.** The `gather.js` extraction is mechanical and
  its result shape is unchanged, but it is the path that moves real ETH. Step 4
  of Verification exists specifically to catch a regression here.
- **Command reaches many wallets.** `reclaim` with no filters can fire hundreds
  of transactions. Mitigated by the confirm prompt (with count), `--dry`, and the
  `--name` / `--day` filters.
