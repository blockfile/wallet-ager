# Reclaim Child Wallets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `reclaim` command that sweeps ETH out of the daily child wallets into the supermain wallet, reusing one shared money-moving code path with the existing `gather`.

**Architecture:** Extract the sweep core (`computeSweepValue`, `estimateSweepFee`, `sweepAll`) out of `src/gather.js` into a new `src/sweeper.js`. `gather.js` becomes "enumerate main wallets → sweepAll"; a new `src/reclaim.js` becomes "enumerate child wallets → sweepAll". Child keys are read back from `output/<main>/wallets-<main>-dayN.json` via pure parse/filter functions in `storage.js`.

**Tech Stack:** Node 18+ ESM, ethers v6, `@inquirer/prompts`, `node --test` (built-in test runner, no framework).

**Spec:** `docs/superpowers/specs/2026-07-17-reclaim-child-wallets-design.md`

## Global Constraints

- **Native ETH only.** No ERC-20 / NFT sweeping.
- **`output/` is read-only.** Reclaim never deletes, moves, or rewrites wallet files.
- **Drain policy: full, with `2n` margin.** Reuse `computeSweepValue(balance, fee, 2n)` — same as `gather`. About one fee of dust is stranded per child. This is intended.
- **Sequential execution.** One wallet at a time, `await tx.wait(1)` per send. Never parallelise — the RPC is rate-limited.
- **Safety model mirrors `gather` exactly.** `--dry` previews; `cfg.dryRun` forces preview; a real run confirms in a TTY or requires `--yes` headless; missing `superMainWallet` is a hard fail before any network call.
- **All tests pure.** No filesystem, no network, no mocks. This matches the existing suite — every current test is a pure function test.
- **Destination is always `cfg.superMainWallet`.** No `--to` flag.
- **Never commit `config.json` or `output/`.** Both are already git-ignored; keep it that way.

---

### Task 1: Extract the shared sweeper

Moves the money-moving core out of `gather.js` so `reclaim` can share it. `gather.js`'s exported signature and result shape stay **identical** — `cli.js` must not need edits.

**Files:**
- Create: `src/sweeper.js`
- Create: `test/sweeper.test.js`
- Modify: `src/gather.js` (full rewrite — it shrinks to ~20 lines)
- Delete: `test/gather.test.js` (contains only `computeSweepValue` tests, which move)

**Interfaces:**
- Consumes: `makeProvider`, `makeSigner`, `formatEther` from `src/funder.js` (already exist).
- Produces:
  - `computeSweepValue(balanceWei: bigint, feeWei: bigint, marginTimes: bigint = 2n) -> bigint`
  - `estimateSweepFee(provider, signer, to: string) -> Promise<bigint>`
  - `sweepAll(provider, targets: [{label: string, signer}], to: string, { dryRun?: boolean }) -> Promise<[{label, address, balance, sweep, txHash, skipped, error}]>`
  - `gatherFunds(cfg, { dryRun }) -> Promise<[{name, address, balance, sweep, txHash, skipped, error}]>` (unchanged shape — note `name`, not `label`)

- [ ] **Step 1: Write the failing test**

Create `test/sweeper.test.js` — these are the three existing tests from `test/gather.test.js`, with only the import path changed:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "ethers";
import { computeSweepValue } from "../src/sweeper.js";

test("computeSweepValue holds back marginTimes x fee", () => {
  const balance = parseEther("1.0");
  const fee = parseEther("0.0001");
  // reserve = 2 x 0.0001 = 0.0002 => sweep = 0.9998
  assert.equal(computeSweepValue(balance, fee, 2n), parseEther("0.9998"));
});

test("computeSweepValue returns 0 when balance can't cover the reserve", () => {
  assert.equal(computeSweepValue(parseEther("0.0001"), parseEther("0.0001"), 2n), 0n);
  assert.equal(computeSweepValue(0n, parseEther("0.0001"), 2n), 0n);
});

test("computeSweepValue never returns a negative value", () => {
  assert.equal(computeSweepValue(1n, parseEther("0.01"), 2n), 0n);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sweeper.test.js`
Expected: FAIL — `Cannot find module` / `ERR_MODULE_NOT_FOUND` for `../src/sweeper.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/sweeper.js`. `computeSweepValue` and `estimateSweepFee` are moved verbatim from `gather.js`; `sweepAll` is the loop from `gatherFunds`, generalised over `targets` instead of `cfg.mainWallets`:

```js
import { formatEther } from "./funder.js";

// How much of a wallet's balance can be swept, after holding back a gas
// reserve. Pure and testable. `feeWei` is the estimated cost of the sweep tx;
// we hold back `marginTimes x fee` so the send never fails on gas. Returns 0n
// when the balance can't cover the reserve.
export function computeSweepValue(balanceWei, feeWei, marginTimes = 2n) {
  const value = balanceWei - feeWei * marginTimes;
  return value > 0n ? value : 0n;
}

export async function estimateSweepFee(provider, signer, to) {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  let gasLimit = 21000n; // plain ETH transfer fallback
  try {
    gasLimit = await signer.estimateGas({ to, value: 1n });
  } catch {
    // keep fallback
  }
  return gasLimit * gasPrice;
}

// Sweep each target's balance up to `to`. Sequential and awaiting each
// confirmation, so nonces stay ordered and a rate-limited RPC isn't hammered.
// `targets` is [{ label, signer }] — the label identifies the wallet in the
// results (a main wallet name, or "main-1/day3#4" for a child).
// In dryRun nothing is sent; each entry reports what WOULD be swept.
// One target failing never aborts the run.
// Returns [{ label, address, balance, sweep, txHash, skipped, error }] (ETH strings).
export async function sweepAll(provider, targets, to, { dryRun = false } = {}) {
  const results = [];

  for (const { label, signer } of targets) {
    const entry = {
      label,
      address: signer.address,
      balance: "0",
      sweep: "0",
      txHash: null,
      skipped: null,
      error: null,
    };
    try {
      const balance = await provider.getBalance(signer.address);
      entry.balance = formatEther(balance);

      const fee = await estimateSweepFee(provider, signer, to);
      const value = computeSweepValue(balance, fee, 2n);
      if (value <= 0n) {
        entry.skipped = "balance too low to cover gas";
        results.push(entry);
        continue;
      }
      entry.sweep = formatEther(value);

      if (dryRun) {
        entry.skipped = "dry run — not sent";
        results.push(entry);
        continue;
      }

      const tx = await signer.sendTransaction({ to, value });
      await tx.wait(1);
      entry.txHash = tx.hash;
    } catch (e) {
      entry.error = e.shortMessage ?? e.message;
    }
    results.push(entry);
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sweeper.test.js`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Rewrite gather.js to use the shared sweeper**

Replace the **entire** contents of `src/gather.js` with:

```js
import { makeProvider, makeSigner } from "./funder.js";
import { sweepAll } from "./sweeper.js";

// Sweep each main wallet's balance up to cfg.superMainWallet.
// In dryRun mode nothing is sent; each entry reports what WOULD be swept.
// Returns [{ name, address, balance, sweep, txHash, skipped, error }] (ETH strings).
export async function gatherFunds(cfg, { dryRun = false } = {}) {
  if (!cfg.superMainWallet) {
    throw new Error(
      'No "superMainWallet" address in config.json. Add it, e.g. "superMainWallet": "0xYourColdWallet".'
    );
  }
  const provider = makeProvider(cfg.network, cfg.rpcUrl);
  const targets = cfg.mainWallets.map((w) => ({
    label: w.name,
    signer: makeSigner(w.privateKey, provider),
  }));

  const results = await sweepAll(provider, targets, cfg.superMainWallet, { dryRun });
  // sweepAll speaks `label`; gather's public shape has always used `name`
  // (cli.js prints r.name). Keep that contract.
  return results.map(({ label, ...rest }) => ({ name: label, ...rest }));
}
```

**Do not** re-export `computeSweepValue` from `gather.js` — nothing imports it from here any more, so a re-export would be dead code.

- [ ] **Step 6: Delete the old test file**

`test/gather.test.js` tested only `computeSweepValue`, which now lives in `sweeper.js`. Its three tests were copied into `test/sweeper.test.js` in Step 1, so the file is now empty of value:

```bash
git rm test/gather.test.js
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — all tests green, including the moved sweeper tests. No test should reference `../src/gather.js`.

- [ ] **Step 8: Verify gather still imports cleanly**

Run: `node -e "import('./src/gather.js').then(m => console.log(typeof m.gatherFunds))"`
Expected: prints `function`. This catches a broken import path without touching the network.

- [ ] **Step 9: Commit**

```bash
git add src/sweeper.js src/gather.js test/sweeper.test.js
git commit -m "refactor: extract shared sweeper from gather

Pulls computeSweepValue, estimateSweepFee and a generalised sweepAll loop
into src/sweeper.js so the upcoming reclaim command shares one audited
money-moving path with gather instead of duplicating it.

gatherFunds keeps its exported signature and result shape, so cli.js is
untouched."
```

---

### Task 2: Read child wallets back off disk

Adds the loaders that turn `output/<main>/wallets-<main>-dayN.json` into sweepable child records. Pure parse/filter, thin IO shell — matching how `computeSweepValue` and `canAffordBatch` are already split from their IO.

**Files:**
- Modify: `src/storage.js` (append a new section after `exportAllTxt`, before the `--- Per-main-wallet state ---` block)
- Modify: `test/storage.test.js` (append tests)

**Interfaces:**
- Consumes: `OUTPUT_ROOT`, `existsSync`, `readdirSync`, `readFileSync`, `join` — all already imported at the top of `storage.js`.
- Produces:
  - `parseChildWallets(payload) -> [{ main: string, day: number, index: number, address: string, privateKey: string }]`
  - `filterChildren(children, { name?: string|null, day?: number|null }) -> children[]`
  - `loadChildWallets({ name?: string|null, day?: number|null }) -> children[]`

The payload shape comes from `runner.js`: `{ mainWallet, address, network, chainId, day, date, amountEth, dryRun, wallets: [{ index, address, privateKey, seedPhrase, txHash, funded, error }] }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/storage.test.js`. Also extend the existing import on line 4 to include the three new functions:

```js
import {
  walletFilePath,
  walletTxtFilePath,
  formatWalletsTxt,
  lastRunForNextRun,
  parseChildWallets,
  filterChildren,
} from "../src/storage.js";
```

Then append these tests:

```js
// A realistic day-file payload, shaped exactly as runner.js writes it.
const dayPayload = {
  mainWallet: "main-1",
  address: "0xMAIN",
  network: "Robinhood Chain",
  chainId: 4663,
  day: 3,
  date: "2026-07-12T00:00:00.000Z",
  amountEth: "0.0005",
  dryRun: false,
  wallets: [
    { index: 1, address: "0xAAA", privateKey: "0xKEY1", seedPhrase: "a b c", txHash: "0xT1", funded: true, error: null },
    { index: 2, address: "0xBBB", privateKey: "0xKEY2", seedPhrase: "d e f", txHash: "0xT2", funded: true, error: null },
  ],
};

test("parseChildWallets pulls main, day, index, address and key out of a payload", () => {
  const children = parseChildWallets(dayPayload);
  assert.equal(children.length, 2);
  assert.deepEqual(children[0], {
    main: "main-1",
    day: 3,
    index: 1,
    address: "0xAAA",
    privateKey: "0xKEY1",
  });
  assert.equal(children[1].address, "0xBBB");
  assert.equal(children[1].privateKey, "0xKEY2");
});

test("parseChildWallets returns [] for anything that isn't a wallet payload", () => {
  assert.deepEqual(parseChildWallets(null), []);
  assert.deepEqual(parseChildWallets({}), []);
  assert.deepEqual(parseChildWallets({ wallets: "not an array" }), []);
  assert.deepEqual(parseChildWallets({ mainWallet: "main-1", day: 1 }), []);
});

test("filterChildren narrows by main wallet name", () => {
  const children = [
    { main: "main-1", day: 1, index: 1, address: "0xA", privateKey: "0xK" },
    { main: "main-2", day: 1, index: 1, address: "0xB", privateKey: "0xK" },
  ];
  const only = filterChildren(children, { name: "main-2" });
  assert.equal(only.length, 1);
  assert.equal(only[0].address, "0xB");
});

test("filterChildren narrows by day, comparing numerically", () => {
  const children = [
    { main: "main-1", day: 1, index: 1, address: "0xA", privateKey: "0xK" },
    { main: "main-1", day: 2, index: 1, address: "0xB", privateKey: "0xK" },
  ];
  assert.equal(filterChildren(children, { day: 2 })[0].address, "0xB");
  // a CLI flag arrives as a string — must still match
  assert.equal(filterChildren(children, { day: "2" })[0].address, "0xB");
});

test("filterChildren applies name and day together", () => {
  const children = [
    { main: "main-1", day: 1, index: 1, address: "0xA", privateKey: "0xK" },
    { main: "main-1", day: 2, index: 1, address: "0xB", privateKey: "0xK" },
    { main: "main-2", day: 2, index: 1, address: "0xC", privateKey: "0xK" },
  ];
  const only = filterChildren(children, { name: "main-1", day: 2 });
  assert.equal(only.length, 1);
  assert.equal(only[0].address, "0xB");
});

test("filterChildren with no filters returns everything", () => {
  const children = [
    { main: "main-1", day: 1, index: 1, address: "0xA", privateKey: "0xK" },
    { main: "main-2", day: 9, index: 2, address: "0xB", privateKey: "0xK" },
  ];
  assert.equal(filterChildren(children, {}).length, 2);
  assert.equal(filterChildren(children).length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/storage.test.js`
Expected: FAIL — `parseChildWallets is not a function` (the import resolves but the export doesn't exist).

- [ ] **Step 3: Write minimal implementation**

In `src/storage.js`, insert this section after `exportAllTxt` ends and before the `// --- Per-main-wallet state: state/<mainWallet>.json ---` comment:

```js
// --- Child wallets: reading the daily batches back for `reclaim` ---
// The daily wallet files are the only record of the child keys, so this is how
// their ETH is recovered. Pure parse/filter below, thin disk walk after.

// Pure: one parsed day-file payload -> child wallet entries.
// Returns [] for anything that isn't a wallet payload.
export function parseChildWallets(payload) {
  if (!payload || !Array.isArray(payload.wallets)) return [];
  return payload.wallets.map((w) => ({
    main: payload.mainWallet,
    day: payload.day,
    index: w.index,
    address: w.address,
    privateKey: w.privateKey,
  }));
}

// Pure: narrow children to one main wallet and/or one day. An absent (null or
// undefined) filter means "no restriction". `day` is compared numerically so a
// CLI string flag matches.
export function filterChildren(children, { name = null, day = null } = {}) {
  return children.filter(
    (c) =>
      (name === null || name === undefined || c.main === name) &&
      (day === null || day === undefined || Number(c.day) === Number(day))
  );
}

// Read every child wallet recorded under output/, optionally narrowed. Mirrors
// exportAllTxt's walk: anything that isn't valid wallet json is skipped, never
// fatal. Returns [] when output/ doesn't exist.
export function loadChildWallets({ name = null, day = null } = {}) {
  if (!existsSync(OUTPUT_ROOT)) return [];
  const children = [];
  for (const entry of readdirSync(OUTPUT_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(OUTPUT_ROOT, entry.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const payload = JSON.parse(readFileSync(join(dir, f), "utf8"));
        children.push(...parseChildWallets(payload));
      } catch {
        // skip anything that isn't valid wallet json
      }
    }
  }
  return filterChildren(children, { name, day });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/storage.test.js`
Expected: PASS — the 5 existing storage tests plus the 6 new ones.

- [ ] **Step 5: Verify the disk walk is safe on a machine with no output/ dir**

Run: `node -e "import('./src/storage.js').then(m => console.log(JSON.stringify(m.loadChildWallets())))"`
Expected: prints `[]` (this repo has no `output/` directory). Must not throw.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — everything green.

- [ ] **Step 7: Commit**

```bash
git add src/storage.js test/storage.test.js
git commit -m "feat: read child wallets back from the daily output files

Adds parseChildWallets/filterChildren (pure) and loadChildWallets (thin
disk walk) so the daily child keys can be loaded for sweeping. Skips
malformed json the same way exportAllTxt does; returns [] with no output/."
```

---

### Task 3: The reclaim module

Turns child records into sweep targets and delegates to `sweepAll`.

**Files:**
- Create: `src/reclaim.js`
- Create: `test/reclaim.test.js`

**Interfaces:**
- Consumes: `loadChildWallets` (Task 2), `sweepAll` (Task 1), `makeProvider`/`makeSigner` from `src/funder.js`.
- Produces:
  - `childLabel(child) -> string` — e.g. `"main-1/day3#4"`
  - `dedupeByAddress(children) -> children[]`
  - `countChildWallets({ name?, day? }) -> number` — disk-only, no RPC
  - `reclaimFunds(cfg, { dryRun?, name?, day? }) -> Promise<[{label, address, balance, sweep, txHash, skipped, error}]>`

- [ ] **Step 1: Write the failing tests**

Create `test/reclaim.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { childLabel, dedupeByAddress } from "../src/reclaim.js";

test("childLabel identifies the main wallet, day and index", () => {
  assert.equal(childLabel({ main: "main-1", day: 3, index: 4 }), "main-1/day3#4");
  assert.equal(childLabel({ main: "main-10", day: 12, index: 1 }), "main-10/day12#1");
});

test("dedupeByAddress keeps the first occurrence and drops repeats", () => {
  const children = [
    { main: "main-1", day: 1, index: 1, address: "0xAAA", privateKey: "0xK1" },
    { main: "main-1", day: 2, index: 1, address: "0xAAA", privateKey: "0xK1" },
    { main: "main-1", day: 2, index: 2, address: "0xBBB", privateKey: "0xK2" },
  ];
  const unique = dedupeByAddress(children);
  assert.equal(unique.length, 2);
  assert.equal(unique[0].day, 1); // the FIRST occurrence survives
  assert.equal(unique[1].address, "0xBBB");
});

test("dedupeByAddress treats addresses case-insensitively", () => {
  const children = [
    { main: "main-1", day: 1, index: 1, address: "0xAbC", privateKey: "0xK" },
    { main: "main-1", day: 1, index: 2, address: "0xabc", privateKey: "0xK" },
  ];
  assert.equal(dedupeByAddress(children).length, 1);
});

test("dedupeByAddress returns [] for empty input", () => {
  assert.deepEqual(dedupeByAddress([]), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/reclaim.test.js`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/reclaim.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/reclaim.js`:

```js
import { makeProvider, makeSigner } from "./funder.js";
import { loadChildWallets } from "./storage.js";
import { sweepAll } from "./sweeper.js";

// A child's label in the results table, e.g. "main-1/day3#4".
export function childLabel(child) {
  return `${child.main}/day${child.day}#${child.index}`;
}

// Pure: drop duplicate addresses, keeping the first occurrence. Defensive — a
// reset day counter could in principle have overwritten a day file, and
// sweeping the same address twice is pointless.
export function dedupeByAddress(children) {
  const seen = new Set();
  return children.filter((c) => {
    const key = String(c.address).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// How many distinct child wallets a reclaim run would touch. Reads only disk —
// no RPC — so the confirm prompt can show a count before any network call.
export function countChildWallets({ name = null, day = null } = {}) {
  return dedupeByAddress(loadChildWallets({ name, day })).length;
}

// Sweep the daily child wallets' balances up to cfg.superMainWallet, optionally
// narrowed to one main wallet (`name`) and/or one day (`day`).
// In dryRun nothing is sent. Returns sweepAll's rows, plus a row per child
// whose stored key is unusable.
export async function reclaimFunds(cfg, { dryRun = false, name = null, day = null } = {}) {
  if (!cfg.superMainWallet) {
    throw new Error(
      'No "superMainWallet" address in config.json. Add it, e.g. "superMainWallet": "0xYourColdWallet".'
    );
  }
  const children = dedupeByAddress(loadChildWallets({ name, day }));
  const provider = makeProvider(cfg.network, cfg.rpcUrl);

  const targets = [];
  const unusable = [];
  for (const c of children) {
    try {
      targets.push({ label: childLabel(c), signer: makeSigner(c.privateKey, provider) });
    } catch (e) {
      // A missing or malformed key is reported, never fatal — the rest of the
      // run still recovers what it can.
      unusable.push({
        label: childLabel(c),
        address: c.address ?? "?",
        balance: "0",
        sweep: "0",
        txHash: null,
        skipped: null,
        error: `unusable private key: ${e.shortMessage ?? e.message}`,
      });
    }
  }

  const results = await sweepAll(provider, targets, cfg.superMainWallet, { dryRun });
  return [...results, ...unusable];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/reclaim.test.js`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — everything green.

- [ ] **Step 6: Commit**

```bash
git add src/reclaim.js test/reclaim.test.js
git commit -m "feat: add reclaimFunds to sweep child wallets to supermain

Loads the daily child keys, dedupes by address, and delegates to the
shared sweepAll. A child with an unusable stored key becomes an error row
rather than aborting the run."
```

---

### Task 4: Wire reclaim into the CLI

**Files:**
- Modify: `src/cli.js` (add import, `cmdReclaim`, menu entry, `main()` dispatch, usage lines)
- Modify: `package.json` (add the `reclaim` script)

**Interfaces:**
- Consumes: `reclaimFunds`, `countChildWallets` (Task 3); existing `loadConfig`, `getNetwork`, `parseFlags`, `confirm`, `stdin` in `cli.js`.
- Produces: `node src/cli.js reclaim [--dry] [--yes] [--name <main>] [--day <N>]` and `npm run reclaim`.

- [ ] **Step 1: Add the import**

In `src/cli.js`, after the existing `import { gatherFunds } from "./gather.js";` (line 13), add:

```js
import { reclaimFunds, countChildWallets } from "./reclaim.js";
```

- [ ] **Step 2: Add cmdReclaim**

In `src/cli.js`, insert this function immediately after `cmdGather` ends (after line 177, before the `// Write a .txt next to every existing wallets-*.json` comment):

```js
// Sweep the daily CHILD wallets up to cfg.superMainWallet. Same safety model as
// gather: honors dry runs, confirms in a TTY, needs --yes headless.
//   node src/cli.js reclaim [--dry] [--yes] [--name <main>] [--day <N>]
async function cmdReclaim(argv = []) {
  const cfg = loadConfig();
  const flags = parseFlags(argv);
  if (!cfg.superMainWallet) {
    console.error(
      '\nNo "superMainWallet" in config.json. Add the destination address, e.g.:\n' +
        '  "superMainWallet": "0xYourColdWalletAddress"\n'
    );
    process.exit(1);
  }

  const dry = Boolean(flags.dry) || cfg.dryRun;
  const name = flags.name ?? null;
  const day = flags.day !== undefined ? Number(flags.day) : null;
  if (day !== null && !Number.isFinite(day)) {
    console.error("\n--day must be a number (e.g. --day 3).\n");
    process.exit(1);
  }

  const scope =
    `${name ? `main "${name}"` : "all main wallets"}, ` +
    `${day !== null ? `day ${day}` : "all days"}`;
  const count = countChildWallets({ name, day });
  const net = getNetwork(cfg.network);

  console.log(`\nReclaim → ${cfg.superMainWallet}`);
  console.log(`Network: ${net.name}${dry ? "   [DRY RUN — nothing will be sent]" : ""}`);
  console.log(`Scope:   ${scope}`);
  console.log(`Found ${count} child wallet(s) on disk.\n`);

  if (count === 0) {
    console.log("Nothing to reclaim.\n");
    return;
  }

  if (!dry) {
    if (stdin.isTTY) {
      const ok = await confirm({
        message: `Sweep ${count} child wallet(s) to ${cfg.superMainWallet}?`,
        default: false,
      });
      if (!ok) {
        console.log("Cancelled.\n");
        return;
      }
    } else if (!flags.yes) {
      console.error(
        "Refusing to move funds without confirmation. Run in a terminal, or pass --yes for headless.\n"
      );
      process.exit(1);
    }
  }

  const results = await reclaimFunds(cfg, { dryRun: dry, name, day });
  console.log("wallet                  balance(ETH)     sweep(ETH)      result");
  console.log("----------------------  ---------------  --------------  ------------------------------------");
  for (const r of results) {
    const result = r.error ? `ERR: ${r.error}` : r.txHash ? r.txHash : r.skipped ?? "-";
    console.log(
      `${r.label.padEnd(22)}  ${String(r.balance).padStart(15)}  ${String(r.sweep).padStart(14)}  ${result}`
    );
  }

  const swept = results.filter((r) => r.txHash).length;
  const skipped = results.filter((r) => r.skipped).length;
  const errored = results.filter((r) => r.error).length;
  // Only count rows that actually moved (or, in a preview, would have).
  const total = results
    .filter((r) => !r.error && (r.txHash || dry))
    .reduce((sum, r) => sum + Number(r.sweep), 0);
  console.log(
    `\n${swept} swept, ${skipped} skipped, ${errored} errored. ` +
      `${dry ? "Would recover" : "Recovered"} ${total.toFixed(6)} ETH.\n`
  );
}
```

- [ ] **Step 3: Add the menu entry**

In `menu()`, add a `Reclaim` choice after the `Gather` line:

```js
        { name: "Gather   — sweep main wallets to supermain", value: "gather" },
        { name: "Reclaim  — sweep CHILD wallets to supermain", value: "reclaim" },
```

and add the handler after the `gather` one:

```js
    else if (action === "gather") await cmdGather();
    else if (action === "reclaim") await cmdReclaim();
```

- [ ] **Step 4: Add the dispatch and usage lines**

In `main()`, add the dispatch after the `gather` line:

```js
    else if (cmd === "gather") await cmdGather(process.argv.slice(3));
    else if (cmd === "reclaim") await cmdReclaim(process.argv.slice(3));
```

and update the usage block — replace these two lines:

```js
      console.log(`Usage: node src/cli.js [status|list|add|gather|export-txt|reschedule]  (no arg = menu)`);
```
```js
      console.log(`  gather flags:     [--dry] [--yes]`);
```

with:

```js
      console.log(`Usage: node src/cli.js [status|list|add|gather|reclaim|export-txt|reschedule]  (no arg = menu)`);
```
```js
      console.log(`  gather flags:     [--dry] [--yes]`);
      console.log(`  reclaim flags:    [--dry] [--yes] [--name <n>] [--day <N>]`);
```

- [ ] **Step 5: Add the npm script**

In `package.json`, add after the `"gather"` line:

```json
    "reclaim": "node src/cli.js reclaim",
```

- [ ] **Step 6: Verify the usage output lists reclaim**

Run: `node src/cli.js bogus-command`
Expected: exit 1, and the usage text includes `reclaim` in the command list plus the `reclaim flags:` line.

- [ ] **Step 7: Verify reclaim runs and finds nothing (no output/ dir here)**

Run: `node src/cli.js reclaim --dry`
Expected: **If `config.json` has a `superMainWallet`:** prints the Reclaim header, `Found 0 child wallet(s) on disk.`, then `Nothing to reclaim.` — no network call, no crash. **If it doesn't:** prints the "No superMainWallet in config.json" guidance and exits 1. Either is a pass; both prove the wiring works.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS — everything green.

- [ ] **Step 9: Commit**

```bash
git add src/cli.js package.json
git commit -m "feat: add the reclaim CLI command

node src/cli.js reclaim [--dry] [--yes] [--name <main>] [--day <N>]

Mirrors gather's safety model: --dry previews, cfg.dryRun forces preview,
a real run confirms in a TTY or needs --yes headless. The confirm prompt
shows the child count, which is free to read off disk; --dry shows the ETH
total. Also adds the menu entry and npm run reclaim."
```

---

### Task 5: Documentation

Documents `reclaim` and corrects the two places that currently tell the user child wallets keep their ETH — those statements become wrong the moment this ships.

**Files:**
- Modify: `README.md`
- Modify: `COMMANDS.txt`

- [ ] **Step 1: Correct the stale README line**

In `README.md`, in the Gather section's bullet list, replace:

```markdown
- Sweeps the **main wallets only** — the daily child wallets keep their ETH.
```

with:

```markdown
- Sweeps the **main wallets only** — to sweep the daily child wallets, use
  [`reclaim`](#reclaim-sweep-child-wallets--supermain) below.
```

- [ ] **Step 2: Add the README reclaim section**

In `README.md`, insert this section immediately after the Gather section's bullet list ends (right before the `### Hot-reload (no restart needed)` heading).

Note the outer fence below is **four** backticks so the inner ```` ```bash ```` block survives — paste the inner content, not the four-backtick wrapper:

````markdown
## Reclaim (sweep child wallets → supermain)

Recover the ETH sitting in the daily child wallets. Their keys were saved to
`output/<main>/wallets-<main>-dayN.json` when they were created, so the funds
are always recoverable. Uses the same `superMainWallet` destination as `gather`.

```bash
node src/cli.js reclaim --dry              # preview: what WOULD be swept, sends nothing
node src/cli.js reclaim                    # sweep all children (asks for confirmation)
node src/cli.js reclaim --yes              # sweep headless (no prompt) — use with care
node src/cli.js reclaim --name main-1      # only main-1's children
node src/cli.js reclaim --day 3            # only day 3, across all main wallets
node src/cli.js reclaim --name main-1 --day 3   # both filters together
# or pick "Reclaim" in `npm run cli`
```

- Sweeps each child's **entire balance minus a gas reserve**. Children too low to
  cover gas are skipped.
- **Not a full refund.** Each sweep permanently strands about one transaction
  fee's worth of dust in the child. On an L2 that's fractions of a cent per
  wallet, but it scales with how many children you have.
- **Doesn't undo the aging.** A wallet's history is permanent — sweeping adds one
  more transaction rather than erasing anything.
- Run `--dry` first: it's the only way to see the total ETH at stake before
  committing. The confirmation prompt shows the wallet *count* only.
- Sequential, one wallet at a time. Hundreds of children take a while.
````

- [ ] **Step 3: Update the COMMANDS.txt menu listing**

In `COMMANDS.txt` section 2, add a Reclaim line to the menu description:

```
        Gather  — sweep main wallets up to the supermain wallet
        Reclaim — sweep the daily CHILD wallets up to the supermain
        Exit
```

- [ ] **Step 4: Correct the stale COMMANDS.txt line**

In section 4, replace:

```
 (Only the ADDRESS is needed. Main wallets keep enough for gas; the daily
  child wallets are NOT swept.)
```

with:

```
 (Only the ADDRESS is needed. Main wallets keep enough for gas. This sweeps
  the MAIN wallets only — for the daily child wallets, see section 5.)
```

- [ ] **Step 5: Insert the new COMMANDS.txt section 5**

Insert immediately after section 4 ends (after the `Note: if config.json has "dryRun": true, gather is always a preview.` line and its blank lines, before the `5) CHANGING SETTINGS` banner):

```
========================================================================
 5) RECLAIM — SWEEP THE CHILD WALLETS TO THE SUPERMAIN WALLET
========================================================================
 Recovers the ETH sitting in the daily wallets the worker created. Their
 keys are saved in output/<main>/wallets-<main>-dayN.json, so the money is
 always recoverable. Same destination as gather ("superMainWallet").

node src/cli.js reclaim --dry
    PREVIEW only. Lists every child wallet and what WOULD be swept, and
    shows the TOTAL ETH you'd get back. Sends nothing. Always safe.
    RUN THIS FIRST — the confirm prompt below only shows a wallet count.

node src/cli.js reclaim
    REAL sweep of ALL child wallets. Asks you to confirm (y/n) first.

node src/cli.js reclaim --yes
    REAL sweep with NO confirmation prompt (for scripts). Use with care.

node src/cli.js reclaim --name main-1
    Only main-1's children.

node src/cli.js reclaim --day 3
    Only day 3's children, across every main wallet.
    (Combine them: --name main-1 --day 3)

    (Or use the "Reclaim" option in:  npm run cli )

 Note: if config.json has "dryRun": true, reclaim is always a preview.

 HEADS UP:
   - Not a full refund. Each sweep leaves about one gas fee of dust behind
     in the child wallet. Tiny per wallet, but it adds up over hundreds.
   - It does NOT undo the aging. Wallet history is permanent; sweeping just
     adds one more transaction.
   - It goes one wallet at a time, so hundreds of children take a while.
     Let it finish.

```

- [ ] **Step 6: Renumber the following COMMANDS.txt sections**

The new section takes number 5, so the six sections after it shift by one. Edit each banner line **and** its number:

| Old | New |
|---|---|
| ` 5) CHANGING SETTINGS` | ` 6) CHANGING SETTINGS` |
| ` 6) CHECK A WALLET'S BALANCE ON ROBINHOOD CHAIN` | ` 7) CHECK A WALLET'S BALANCE ON ROBINHOOD CHAIN` |
| ` 7) CREATE A BRAND-NEW WALLET (address + key + seed phrase)` | ` 8) CREATE A BRAND-NEW WALLET (address + key + seed phrase)` |
| ` 8) WHERE THE DATA LIVES` | ` 9) WHERE THE DATA LIVES` |
| ` 9) UPDATING THE CODE FROM GITHUB` | `10) UPDATING THE CODE FROM GITHUB` |
| `10) EVERYDAY QUICK REFERENCE` | `11) EVERYDAY QUICK REFERENCE` |

- [ ] **Step 7: Add reclaim to the quick reference**

In the (now) section 11 quick reference, add after the two `gather` lines:

```
    node src/cli.js gather --dry       preview a sweep to supermain
    node src/cli.js gather             sweep to supermain (asks to confirm)
    node src/cli.js reclaim --dry      preview sweeping the CHILD wallets
    node src/cli.js reclaim            sweep the child wallets (asks to confirm)
```

- [ ] **Step 8: Check no stale cross-references survive**

Run: `grep -n "child wallets are NOT swept\|child wallets keep their ETH" README.md COMMANDS.txt`
Expected: no matches. Both stale claims are gone.

Run: `grep -c "^ *[0-9]*)" COMMANDS.txt`
Expected: the section banners are numbered 1–11 with no duplicates. Skim the output of `grep -n "^ *[0-9]\+)" COMMANDS.txt` to confirm the sequence.

- [ ] **Step 9: Commit**

```bash
git add README.md COMMANDS.txt
git commit -m "docs: document the reclaim command

Adds a reclaim section to both README and COMMANDS.txt, and corrects the
two places that said the daily child wallets keep their ETH — that stopped
being true. Documents the dust caveat, that sweeping doesn't undo aging,
and the --dry-first recommendation."
```

---

## Final Verification

Run after all five tasks. Steps 3–5 need a funded testnet setup — do them before ever pointing this at mainnet.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS. Counts: 3 sweeper + 11 storage + 4 reclaim + existing config/funder/wallets tests.

- [ ] **Step 2: Confirm the gather refactor didn't change gather's output**

This is the main regression risk in the whole plan — `gather.js` was rewritten.

Run: `node src/cli.js gather --dry`
Expected: the same table format and the same per-wallet rows as before the refactor (`name`, `balance(ETH)`, `sweep(ETH)`, `result`, with `dry run — not sent`). If the `name` column is blank or `undefined`, the `label`→`name` mapping in `gatherFunds` is broken.

- [ ] **Step 3: Testnet preview**

With `network: "testnet"` and at least one real day-batch in `output/`:

Run: `node src/cli.js reclaim --dry`
Expected: every child from `output/` listed with a real on-chain balance, a sweep value slightly below it, `dry run — not sent`, and a `Would recover N ETH` summary. Nothing sent.

- [ ] **Step 4: Testnet real sweep**

Run: `node src/cli.js reclaim`
Expected: the confirm prompt shows the child count; on `y`, each child sweeps sequentially with a tx hash per row. Verify on the explorer (`https://robinhoodchain-testnet.blockscout.com`) that the supermain balance rose.

- [ ] **Step 5: Confirm the children are drained to dust**

Run: `node src/cli.js reclaim --dry`
Expected: every child now reports `balance too low to cover gas` and is skipped. This proves both that the sweep worked and that re-running reclaim is safe and idempotent.

- [ ] **Step 6: Confirm no secrets were committed**

Run: `git status --porcelain && git log --stat -6`
Expected: `config.json` and `output/` appear nowhere. Only `src/`, `test/`, `docs/`, `package.json`, `README.md`, `COMMANDS.txt`.
