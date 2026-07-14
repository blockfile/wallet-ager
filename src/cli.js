import { stdin } from "node:process";
import { select, input, password, confirm } from "@inquirer/prompts";
import {
  loadConfig,
  loadRawConfig,
  withAddedWallet,
  saveRawConfig,
  DEFAULT_CONFIG_PATH,
} from "./config.js";
import { getNetwork } from "./networks.js";
import { makeProvider, makeSigner, formatEther } from "./funder.js";
import { loadState, saveState, exportAllTxt, lastRunForNextRun } from "./storage.js";
import { gatherFunds } from "./gather.js";

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

// Sweep all main wallets up to cfg.superMainWallet. Moves real funds, so it
// requires confirmation (interactive) or --yes (headless). Honors dry runs.
//   node src/cli.js gather [--dry] [--yes]
async function cmdGather(argv = []) {
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
  const net = getNetwork(cfg.network);
  console.log(`\nGather → ${cfg.superMainWallet}`);
  console.log(`Network: ${net.name}${dry ? "   [DRY RUN — nothing will be sent]" : ""}`);
  console.log(`Sweeping ${cfg.mainWallets.length} main wallet(s) to the supermain wallet.\n`);

  if (!dry) {
    if (stdin.isTTY) {
      const ok = await confirm({
        message: `Send ALL main-wallet balances to ${cfg.superMainWallet}?`,
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

  const results = await gatherFunds(cfg, { dryRun: dry });
  console.log("name        balance(ETH)     sweep(ETH)      result");
  console.log("----------  ---------------  --------------  ------------------------------------");
  for (const r of results) {
    const result = r.error ? `ERR: ${r.error}` : r.txHash ? r.txHash : r.skipped ?? "-";
    console.log(`${r.name.padEnd(10)}  ${String(r.balance).padStart(15)}  ${String(r.sweep).padStart(14)}  ${result}`);
  }
  console.log("");
}

// Write a .txt next to every existing wallets-*.json (backfill for files made
// before .txt export existed). New batches already write both automatically.
function cmdExportTxt() {
  const written = exportAllTxt();
  if (written.length === 0) {
    console.log("\nNo wallet files found in output/ to export.\n");
    return;
  }
  console.log(`\n✓ Wrote ${written.length} .txt file(s):`);
  for (const p of written) console.log(`  ${p}`);
  console.log("");
}

// Change WHEN an already-running main wallet does its next daily batch.
//   node src/cli.js reschedule --name main-5 --in 3      (run 3h from now)
//   node src/cli.js reschedule --name main-5 --at 2026-07-15T07:30:00Z
//   node src/cli.js reschedule --name main-5 --now       (run at next restart)
// Takes effect after: pm2 restart wallet-ager
function cmdReschedule(argv = []) {
  const flags = parseFlags(argv);
  const cfg = loadConfig();
  const name = flags.name;
  if (!name) {
    console.error("\nProvide --name <mainWallet>.\n");
    process.exit(1);
  }
  const wallet = cfg.mainWallets.find((w) => w.name === name);
  if (!wallet) {
    console.error(`\nNo main wallet named "${name}" in config.\n`);
    process.exit(1);
  }

  const intervalMs = cfg.intervalHours * 60 * 60 * 1000;
  const now = Date.now();
  let nextRun;
  if (argv.includes("--now")) {
    nextRun = now;
  } else if (flags.in !== undefined) {
    const h = Number(flags.in);
    if (!Number.isFinite(h)) {
      console.error("\n--in must be a number of hours (e.g. --in 3).\n");
      process.exit(1);
    }
    nextRun = now + h * 60 * 60 * 1000;
  } else if (flags.at) {
    nextRun = Date.parse(flags.at);
    if (Number.isNaN(nextRun)) {
      console.error(`\nCould not parse --at "${flags.at}". Use ISO UTC, e.g. 2026-07-15T07:30:00Z.\n`);
      process.exit(1);
    }
  } else {
    console.error("\nProvide one of: --in <hours>, --at <ISO>, or --now.\n");
    process.exit(1);
  }

  const state = loadState(name);
  saveState(name, { ...state, lastRunTime: lastRunForNextRun(nextRun, intervalMs) });

  const utc = new Date(nextRun).toISOString();
  const pht = new Date(nextRun + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  console.log(`\n✓ ${name} next batch scheduled for:`);
  console.log(`    ${utc}  (UTC)`);
  console.log(`    ${pht}  (Philippine time, UTC+8)`);
  console.log(`  Apply it now with:  pm2 restart wallet-ager\n`);
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
        { name: "Gather   — sweep main wallets to supermain", value: "gather" },
        { name: "Export   — write .txt for all wallet files", value: "export-txt" },
        { name: "Exit", value: "exit" },
      ],
      loop: false,
    });

    if (action === "exit") return;
    if (action === "status") await cmdStatus();
    else if (action === "list") cmdList();
    else if (action === "add") await cmdAdd();
    else if (action === "gather") await cmdGather();
    else if (action === "export-txt") cmdExportTxt();
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
    else if (cmd === "gather") await cmdGather(process.argv.slice(3));
    else if (cmd === "export-txt") cmdExportTxt();
    else if (cmd === "reschedule") cmdReschedule(process.argv.slice(3));
    else {
      console.log(`Usage: node src/cli.js [status|list|add|gather|export-txt|reschedule]  (no arg = menu)`);
      console.log(`  add flags:        --name <n> --key 0x<64hex> [--per-day 10] [--amount 0.0005]`);
      console.log(`  gather flags:     [--dry] [--yes]`);
      console.log(`  reschedule flags: --name <n> (--in <hours> | --at <ISO> | --now)`);
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
