import { generateWallets } from "./wallets.js";
import { saveDayWallets, loadState, saveState } from "./storage.js";
import {
  makeProvider,
  makeSigner,
  fundWallets,
  canAffordBatch,
  formatEther,
} from "./funder.js";
import { getNetwork } from "./networks.js";

const HOUR_MS = 60 * 60 * 1000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(name, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${name}] ${msg}`);
}

// Run exactly one daily batch for one main wallet.
// Returns { status: "funded" | "exhausted" | "error", day?, error? }.
export async function runBatch(cfg, wallet, provider) {
  const state = loadState(wallet.name);
  if (state.exhausted) return { status: "exhausted" };

  const signer = makeSigner(wallet.privateKey, provider);
  const balance = await provider.getBalance(signer.address);
  const net = getNetwork(cfg.network);

  if (!canAffordBatch(balance, wallet.amountEth, wallet.walletsPerDay, cfg.gasBufferEth)) {
    log(
      wallet.name,
      `Funds exhausted: balance ${formatEther(balance)} ETH cannot cover ` +
        `${wallet.walletsPerDay} x ${wallet.amountEth} ETH + gas buffer. Stopping.`
    );
    saveState(wallet.name, { ...state, exhausted: true });
    return { status: "exhausted" };
  }

  const day = state.dayCounter + 1;
  log(
    wallet.name,
    `Day ${day}: balance ${formatEther(balance)} ETH. Generating ${wallet.walletsPerDay} wallets` +
      (cfg.dryRun ? " (DRY RUN — no ETH will be sent)." : ".")
  );

  const generated = generateWallets(wallet.walletsPerDay);

  // Save keys BEFORE funding so no wallet ever receives ETH we didn't record.
  const payload = {
    mainWallet: wallet.name,
    address: signer.address,
    network: net.name,
    chainId: net.chainId,
    day,
    date: new Date().toISOString(),
    amountEth: wallet.amountEth,
    dryRun: cfg.dryRun,
    wallets: generated.map((w) => ({ ...w, txHash: null, funded: false })),
  };
  const filePath = saveDayWallets(wallet.name, day, payload);
  log(wallet.name, `Saved keys -> ${filePath}`);

  const results = await fundWallets(
    signer,
    generated.map((w) => w.address),
    wallet.amountEth,
    { dryRun: cfg.dryRun }
  );

  // Merge tx results back into the saved file.
  const byAddress = new Map(results.map((r) => [r.address, r]));
  payload.wallets = generated.map((w) => {
    const r = byAddress.get(w.address);
    return { ...w, txHash: r?.txHash ?? null, funded: Boolean(r?.funded), error: r?.error ?? null };
  });
  saveDayWallets(wallet.name, day, payload);

  const funded = payload.wallets.filter((w) => w.funded).length;
  const failed = payload.wallets.filter((w) => w.error).length;
  log(
    wallet.name,
    cfg.dryRun
      ? `Day ${day} dry run complete: ${generated.length} wallets generated, 0 funded.`
      : `Day ${day} complete: ${funded} funded, ${failed} failed.`
  );

  saveState(wallet.name, { dayCounter: day, lastRunTime: Date.now(), exhausted: false });
  return { status: "funded", day, funded, failed };
}

// Loop forever for one main wallet: run a batch, then sleep until the next
// interval. Restart-safe — on startup it only waits out the remainder of the
// interval since the last recorded run.
export async function runLoop(cfg, wallet, provider) {
  const intervalMs = cfg.intervalHours * HOUR_MS;

  for (;;) {
    const state = loadState(wallet.name);
    if (state.exhausted) {
      log(wallet.name, "Already exhausted. Nothing to do.");
      return;
    }

    if (state.lastRunTime) {
      const elapsed = Date.now() - state.lastRunTime;
      if (elapsed < intervalMs) {
        const waitMs = intervalMs - elapsed;
        log(wallet.name, `Waiting ${(waitMs / HOUR_MS).toFixed(2)}h until next batch.`);
        await sleep(waitMs);
      }
    }

    const result = await runBatch(cfg, wallet, provider);
    if (result.status === "exhausted") return;

    log(wallet.name, `Sleeping ${cfg.intervalHours}h until next batch.`);
    await sleep(intervalMs);
  }
}

// Run one batch per main wallet and exit (used by --once).
export async function runOnce(cfg) {
  const provider = makeProvider(cfg.network, cfg.rpcUrl);
  const results = [];
  for (const wallet of cfg.mainWallets) {
    try {
      results.push({ name: wallet.name, ...(await runBatch(cfg, wallet, provider)) });
    } catch (e) {
      log(wallet.name, `ERROR: ${e.message}`);
      results.push({ name: wallet.name, status: "error", error: e.message });
    }
  }
  return results;
}

// Run all main wallets in parallel, each on its own loop, forever.
export async function runAll(cfg) {
  const provider = makeProvider(cfg.network, cfg.rpcUrl);
  const net = getNetwork(cfg.network);
  log(
    "system",
    `Starting ${cfg.mainWallets.length} main wallet(s) on ${net.name} (chainId ${net.chainId})` +
      (cfg.dryRun ? " in DRY RUN mode." : ".")
  );
  await Promise.all(
    cfg.mainWallets.map((wallet) =>
      runLoop(cfg, wallet, provider).catch((e) =>
        log(wallet.name, `FATAL: ${e.message}`)
      )
    )
  );
  log("system", "All main wallets have stopped (exhausted).");
}
