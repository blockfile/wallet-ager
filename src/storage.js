import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./config.js";

const OUTPUT_ROOT = join(PROJECT_ROOT, "output");
const STATE_ROOT = join(PROJECT_ROOT, "state");

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// --- Per-day wallet files: output/<mainWallet>/wallets-<mainWallet>-dayN.{json,txt} ---
// The main wallet name is in the filename (not just the folder) so files stay
// unique when collected into a single folder.

export function walletFilePath(mainWalletName, day) {
  return join(OUTPUT_ROOT, mainWalletName, `wallets-${mainWalletName}-day${day}.json`);
}

export function walletTxtFilePath(mainWalletName, day) {
  return join(OUTPUT_ROOT, mainWalletName, `wallets-${mainWalletName}-day${day}.txt`);
}

// Human-readable rendering of a day's wallets (for the .txt export).
export function formatWalletsTxt(payload) {
  const lines = [
    `wallet-ager  —  ${payload.mainWallet}  —  day ${payload.day}`,
    `Main wallet: ${payload.address}`,
    `Network:     ${payload.network} (chainId ${payload.chainId})`,
    `Date:        ${payload.date}`,
    `Amount:      ${payload.amountEth} ETH per wallet`,
    `Dry run:     ${payload.dryRun}`,
    `Wallets:     ${payload.wallets.length}`,
    "=".repeat(72),
    "",
  ];
  for (const w of payload.wallets) {
    lines.push(`#${w.index}`);
    lines.push(`  Address:     ${w.address}`);
    lines.push(`  Private key: ${w.privateKey}`);
    lines.push(`  Seed phrase: ${w.seedPhrase}`);
    lines.push(`  Tx hash:     ${w.txHash ?? "-"}`);
    lines.push(`  Funded:      ${w.funded}${w.error ? `  (error: ${w.error})` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

// Save a day's batch as BOTH json and txt (kept in sync).
export function saveDayWallets(mainWalletName, day, payload) {
  const dir = join(OUTPUT_ROOT, mainWalletName);
  ensureDir(dir);
  const path = walletFilePath(mainWalletName, day);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(walletTxtFilePath(mainWalletName, day), formatWalletsTxt(payload) + "\n", { mode: 0o600 });
  return path;
}

// Backfill: write a .txt next to every existing wallets-*.json in output/.
// Used by the CLI `export-txt` command for files created before .txt export.
export function exportAllTxt() {
  if (!existsSync(OUTPUT_ROOT)) return [];
  const written = [];
  for (const entry of readdirSync(OUTPUT_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(OUTPUT_ROOT, entry.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const payload = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const txtPath = join(dir, f.replace(/\.json$/, ".txt"));
        writeFileSync(txtPath, formatWalletsTxt(payload) + "\n", { mode: 0o600 });
        written.push(txtPath);
      } catch {
        // skip anything that isn't a valid wallet json
      }
    }
  }
  return written;
}

// --- Per-main-wallet state: state/<mainWallet>.json ---

export function statePath(mainWalletName) {
  return join(STATE_ROOT, `${mainWalletName}.json`);
}

export function loadState(mainWalletName) {
  const path = statePath(mainWalletName);
  if (!existsSync(path)) {
    return { dayCounter: 0, lastRunTime: null, exhausted: false };
  }
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    return {
      dayCounter: s.dayCounter ?? 0,
      lastRunTime: s.lastRunTime ?? null,
      exhausted: Boolean(s.exhausted),
    };
  } catch {
    return { dayCounter: 0, lastRunTime: null, exhausted: false };
  }
}

export function saveState(mainWalletName, state) {
  ensureDir(STATE_ROOT);
  writeFileSync(statePath(mainWalletName), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}
