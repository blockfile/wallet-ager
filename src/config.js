import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isAddress } from "ethers";
import { getNetwork } from "./networks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..");
export const DEFAULT_CONFIG_PATH = join(PROJECT_ROOT, "config.json");

// Global defaults, overridable per main wallet.
const DEFAULTS = {
  walletsPerDay: 10,
  amountEth: "0.0005",
  network: "testnet",
  dryRun: false,
  intervalHours: 24,
  // Extra ETH kept back on the main wallet as a gas cushion when
  // deciding whether a batch is affordable.
  gasBufferEth: "0.0005",
};

function fail(msg) {
  throw new Error(`config.json: ${msg}`);
}

// Validate and normalize the raw parsed config into a predictable shape.
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object") fail("must be a JSON object");

  const network = raw.network ?? DEFAULTS.network;
  getNetwork(network); // throws on unknown network

  const dryRun = raw.dryRun ?? DEFAULTS.dryRun;
  const intervalHours = num(raw.intervalHours ?? DEFAULTS.intervalHours, "intervalHours");
  const gasBufferEth = str(raw.gasBufferEth ?? DEFAULTS.gasBufferEth, "gasBufferEth");

  // Optional private RPC endpoint (e.g. QuickNode/Alchemy). Kept out of source
  // so its secret token lives only in gitignored config.json. Falls back to the
  // network's public RPC when blank.
  let rpcUrl = raw.rpcUrl ?? null;
  if (rpcUrl !== null) {
    if (typeof rpcUrl !== "string") fail("rpcUrl must be a string URL or omitted");
    rpcUrl = rpcUrl.trim() || null; // empty/whitespace => fall back to public RPC
    if (rpcUrl !== null && !/^https?:\/\//.test(rpcUrl)) {
      fail("rpcUrl must be an http(s) URL, or omitted to use the public RPC");
    }
  }

  // Optional destination address for the `gather` command (sweep main wallets
  // up to this wallet). Only an address is needed — receiving requires no key.
  let superMainWallet = raw.superMainWallet ?? null;
  if (superMainWallet !== null) {
    if (typeof superMainWallet === "object" && superMainWallet) superMainWallet = superMainWallet.address;
    if (typeof superMainWallet === "string") superMainWallet = superMainWallet.trim() || null;
    if (superMainWallet !== null && !isAddress(superMainWallet)) {
      fail("superMainWallet must be a valid 0x address (the destination for `gather`)");
    }
  }

  if (!Array.isArray(raw.mainWallets) || raw.mainWallets.length === 0) {
    fail("mainWallets must be a non-empty array");
  }

  const seenNames = new Set();
  const mainWallets = raw.mainWallets.map((w, i) => {
    const where = `mainWallets[${i}]`;
    if (!w || typeof w !== "object") fail(`${where} must be an object`);

    const name = w.name ?? `main-${i + 1}`;
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name)) {
      fail(`${where}.name "${name}" must be alphanumeric (._- allowed) and safe for folder names`);
    }
    if (seenNames.has(name)) fail(`duplicate main wallet name "${name}"`);
    seenNames.add(name);

    if (typeof w.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(w.privateKey)) {
      fail(`${where}.privateKey must be a 0x-prefixed 64-hex-char private key`);
    }

    return {
      name,
      privateKey: w.privateKey,
      walletsPerDay: num(w.walletsPerDay ?? DEFAULTS.walletsPerDay, `${where}.walletsPerDay`),
      amountEth: str(w.amountEth ?? DEFAULTS.amountEth, `${where}.amountEth`),
    };
  });

  return { network, rpcUrl, dryRun, intervalHours, gasBufferEth, superMainWallet, mainWallets };
}

function num(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) fail(`${label} must be a positive number`);
  return n;
}

function str(v, label) {
  if (typeof v !== "string" && typeof v !== "number") fail(`${label} must be a string amount`);
  const s = String(v);
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) fail(`${label} "${s}" must be a positive decimal ETH amount`);
  return s;
}

// Read and parse the raw config JSON (no normalization/defaults applied).
export function loadRawConfig(path = DEFAULT_CONFIG_PATH) {
  if (!existsSync(path)) {
    throw new Error(
      `No config found at ${path}. Copy config.example.json to config.json and fill in your main wallet private key(s).`
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Could not parse ${path}: ${e.message}`);
  }
}

export function loadConfig(path = DEFAULT_CONFIG_PATH) {
  return normalizeConfig(loadRawConfig(path));
}

// Return a copy of `raw` with `entry` appended to mainWallets. Validates the
// whole result (rejects duplicate names, bad keys, etc.) before returning, so
// callers never persist an invalid config. Pure — does not touch disk.
export function withAddedWallet(raw, entry) {
  const base = raw && typeof raw === "object" ? raw : {};
  const existing = Array.isArray(base.mainWallets) ? base.mainWallets : [];
  const next = { ...base, mainWallets: [...existing, entry] };
  normalizeConfig(next); // throws on any validation problem
  return next;
}

export function saveRawConfig(raw, path = DEFAULT_CONFIG_PATH) {
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
}
