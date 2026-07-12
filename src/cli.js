import { stdin } from "node:process";
import { select, input, password } from "@inquirer/prompts";
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
// Otherwise prompts interactively (arrow-key friendly, key input masked).
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

  requireTTY("Adding a wallet interactively");
  const name = await input({ message: "Name:", default: suggestedName });
  // Masked so the private key never appears on screen (important over SSH).
  const privateKey = await password({
    message: "Private key (0x + 64 hex):",
    mask: "*",
    validate: (v) => /^0x[0-9a-fA-F]{64}$/.test(v.trim()) || "Must be 0x followed by 64 hex chars",
  });
  const walletsPerDay = await input({
    message: "Wallets per day:",
    default: "10",
    validate: (v) => Number(v) > 0 || "Must be a positive number",
  });
  const amountEth = await input({
    message: "ETH per wallet:",
    default: "0.0005",
    validate: (v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 || "Must be a positive decimal",
  });

  persistAdd(raw, {
    name: name.trim(),
    privateKey: privateKey.trim(),
    walletsPerDay: Number(walletsPerDay),
    amountEth: amountEth.trim(),
  });
}

// ---- interactive menu (no subcommand) ----

function requireTTY(what) {
  if (!stdin.isTTY) {
    console.error(
      `${what} needs an interactive terminal.\n` +
        `You appear to be running without a TTY (e.g. under pm2/systemd or a pipe).\n` +
        `Run it in your SSH shell, or use the non-interactive form:\n` +
        `  node src/cli.js add --name main-2 --key 0x<64hex> [--per-day 10] [--amount 0.0005]`
    );
    process.exit(1);
  }
}

async function menu() {
  requireTTY("The interactive menu");
  for (;;) {
    const action = await select({
      message: "wallet-ager — choose an action:",
      choices: [
        { name: "Status   — running wallets, day, live balance", value: "status" },
        { name: "List     — configured main wallets", value: "list" },
        { name: "Add      — add a new main wallet", value: "add" },
        { name: "Exit", value: "exit" },
      ],
      loop: false,
    });

    if (action === "exit") return;
    if (action === "status") await cmdStatus();
    else if (action === "list") cmdList();
    else if (action === "add") await cmdAdd();
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
    // Inquirer throws this when the user hits Ctrl+C — exit quietly.
    if (e?.name === "ExitPromptError") {
      console.log("\nCancelled.");
      process.exit(0);
    }
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
