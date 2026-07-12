import { watch } from "node:fs";
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
import { loadConfig, DEFAULT_CONFIG_PATH } from "./config.js";

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

// Run all main wallets in parallel, each on its own loop, forever, and
// hot-reload config.json: any newly-added main wallet is picked up and started
// automatically without a restart. Existing wallets are never touched.
//
// Scope of hot-reload: only ADDING main wallets is live. Changes to global
// settings (network, rpcUrl, intervalHours) or to existing wallet entries need
// a restart — the provider and running loops are captured at startup.
export async function runDaemon(cfg, configPath = DEFAULT_CONFIG_PATH) {
  const provider = makeProvider(cfg.network, cfg.rpcUrl);
  const net = getNetwork(cfg.network);
  const active = new Set();

  const startWallet = (wallet) => {
    if (active.has(wallet.name)) return;
    active.add(wallet.name);
    // Keep the name in `active` even after the loop ends (exhausted) so a
    // config reload never respawns a finished wallet.
    runLoop(cfg, wallet, provider).catch((e) => log(wallet.name, `FATAL: ${e.message}`));
  };

  log(
    "system",
    `Starting ${cfg.mainWallets.length} main wallet(s) on ${net.name} (chainId ${net.chainId})` +
      (cfg.dryRun ? " in DRY RUN mode." : ".")
  );
  cfg.mainWallets.forEach(startWallet);

  // Watch config.json for newly added main wallets (debounced; editors emit
  // multiple events per save). A bad edit is logged and ignored, never fatal.
  let debounce = null;
  const watcher = watch(configPath, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      let fresh;
      try {
        fresh = loadConfig(configPath);
      } catch (e) {
        log("system", `Ignoring config change — invalid: ${e.message}`);
        return;
      }
      const added = fresh.mainWallets.filter((w) => !active.has(w.name));
      if (added.length === 0) return;
      log("system", `Config changed: starting ${added.length} new main wallet(s): ${added.map((w) => w.name).join(", ")}`);
      added.forEach(startWallet);
    }, 500);
  });
  log("system", `Hot-reload enabled: watching ${configPath} for new main wallets.`);

  // Keep the process alive indefinitely (daemon). The watcher already holds the
  // event loop open; this promise never resolves so the daemon runs until it is
  // stopped by systemd/pm2/Ctrl+C.
  await new Promise(() => {});
  watcher.close(); // unreachable, kept for clarity
}

// Backwards-compatible alias.
export const runAll = runDaemon;
