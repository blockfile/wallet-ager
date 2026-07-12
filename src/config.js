import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getNetwork } from "./networks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..");

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

  return { network, rpcUrl, dryRun, intervalHours, gasBufferEth, mainWallets };
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

export function loadConfig(path = join(PROJECT_ROOT, "config.json")) {
  if (!existsSync(path)) {
    throw new Error(
      `No config found at ${path}. Copy config.example.json to config.json and fill in your main wallet private key(s).`
    );
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Could not parse ${path}: ${e.message}`);
  }
  return normalizeConfig(raw);
}
