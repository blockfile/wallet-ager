import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./config.js";

const OUTPUT_ROOT = join(PROJECT_ROOT, "output");
const STATE_ROOT = join(PROJECT_ROOT, "state");

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// --- Per-day wallet files: output/<mainWallet>/wallets-dayN.json ---

export function walletFilePath(mainWalletName, day) {
  return join(OUTPUT_ROOT, mainWalletName, `wallets-day${day}.json`);
}

export function saveDayWallets(mainWalletName, day, payload) {
  const dir = join(OUTPUT_ROOT, mainWalletName);
  ensureDir(dir);
  const path = walletFilePath(mainWalletName, day);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  return path;
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
