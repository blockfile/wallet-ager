import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  loadConfig,
  loadRawConfig,
  withAddedWallet,
  saveRawConfig,
  DEFAULT_CONFIG_PATH,
} from "./config.js";
import { getNetwork } from "./networks.js";
import { makeProvider, makeSigner, formatEther } from "./funder.js";
import { loadState } from "./storage.js";

// ---- helpers ----

function fmtTime(ms) {
  if (!ms) return "never";
  return new Date(ms).toISOString();
}

async function withRl(fn) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

// ---- commands ----

// List the configured main wallets (no network calls).
function cmdList() {
  const cfg = loadConfig();
  const net = getNetwork(cfg.network);
  console.log(`\nNetwork: ${net.name} (chainId ${net.chainId})${cfg.dryRun ? "  [DRY RUN]" : ""}`);
  console.log(`Main wallets (${cfg.mainWallets.length}):`);
  for (const w of cfg.mainWallets) {
    console.log(`  - ${w.name}: ${w.walletsPerDay} wallets/day x ${w.amountEth} ETH`);
  }
  console.log("");
}

// Show live status: day counter, last run, on-chain balance, exhausted flag.
async function cmdStatus() {
  const cfg = loadConfig();
  const net = getNetwork(cfg.network);
  const provider = makeProvider(cfg.network, cfg.rpcUrl);
  console.log(`\nNetwork: ${net.name} (chainId ${net.chainId})${cfg.dryRun ? "  [DRY RUN]" : ""}\n`);
  console.log("name        day  lastRun                   balance(ETH)   status");
  console.log("----------  ---  ------------------------  -------------  --------");
  for (const w of cfg.mainWallets) {
    const st = loadState(w.name);
    let balance = "?";
    try {
      const signer = makeSigner(w.privateKey, provider);
      balance = formatEther(await provider.getBalance(signer.address));
    } catch (e) {
      balance = `err: ${e.shortMessage ?? e.message}`;
    }
    const status = st.exhausted ? "EXHAUSTED" : "active";
    console.log(
      `${w.name.padEnd(10)}  ${String(st.dayCounter).padStart(3)}  ${fmtTime(st.lastRunTime).padEnd(24)}  ${String(balance).padStart(13)}  ${status}`
    );
  }
  console.log("");
}

function persistAdd(raw, entry) {
  let next;
  try {
    next = withAddedWallet(raw, entry); // validates everything
  } catch (e) {
    console.error(`\n✗ Not added: ${e.message}\n`);
    return false;
  }
  saveRawConfig(next);
  console.log(`\n✓ Added "${entry.name}" to ${DEFAULT_CONFIG_PATH}.`);
  console.log("  If the daemon is running, hot-reload will start it within a few seconds.");
  console.log("  If not, start it with: npm start\n");
  return true;
}

// Parse "--key value" style flags into an object.
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

// Add a new main wallet. Non-interactive when --key is supplied:
//   node src/cli.js add --name main-2 --key 0x... [--per-day 10] [--amount 0.0005]
// Otherwise prompts interactively.
async function cmdAdd(argv = []) {
  const raw = loadRawConfig();
  const existing = Array.isArray(raw.mainWallets) ? raw.mainWallets : [];
  const suggestedName = `main-${existing.length + 1}`;
  const flags = parseFlags(argv);

  if (flags.key) {
    persistAdd(raw, {
      name: flags.name || suggestedName,
      privateKey: flags.key,
      walletsPerDay: Number(flags["per-day"] ?? 10),
      amountEth: String(flags.amount ?? "0.0005"),
    });
    return;
  }

  await withRl(async (rl) => {
    const name = (await rl.question(`Name [${suggestedName}]: `)).trim() || suggestedName;
    const privateKey = (await rl.question("Private key (0x + 64 hex): ")).trim();
    const walletsPerDay = (await rl.question("Wallets per day [10]: ")).trim() || "10";
    const amountEth = (await rl.question("ETH per wallet [0.0005]: ")).trim() || "0.0005";
    persistAdd(raw, { name, privateKey, walletsPerDay: Number(walletsPerDay), amountEth });
  });
}

// ---- interactive menu (no subcommand) ----

async function menu() {
  for (;;) {
    console.log("wallet-ager");
    console.log("  1) status        show running main wallets + balances");
    console.log("  2) list          list configured main wallets");
    console.log("  3) add wallet    add a new main wallet");
    console.log("  4) exit");
    const choice = await withRl((rl) => rl.question("> "));
    const c = choice.trim();
    console.log("");
    if (c === "1" || c === "status") await cmdStatus();
    else if (c === "2" || c === "list") cmdList();
    else if (c === "3" || c === "add") await cmdAdd();
    else if (c === "4" || c === "exit" || c === "quit") return;
    else console.log(`Unknown option: ${c}\n`);
  }
}

// ---- entry ----

async function main() {
  const cmd = process.argv[2];
  try {
    if (!cmd) await menu();
    else if (cmd === "status") await cmdStatus();
    else if (cmd === "list") cmdList();
    else if (cmd === "add") await cmdAdd(process.argv.slice(3));
    else {
      console.log(`Usage: node src/cli.js [status|list|add]  (no arg = interactive menu)`);
      console.log(`  add flags: --name <n> --key 0x<64hex> [--per-day 10] [--amount 0.0005]`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
