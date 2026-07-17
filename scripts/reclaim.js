// One-off: sweep the ETH out of the daily CHILD wallets into the supermain
// wallet. The child keys are saved in output/<main>/wallets-<main>-dayN.json
// when they're created, so the funds are always recoverable.
//
// The built-in `gather` command sweeps MAIN wallets only — this covers the
// children it leaves behind.
//
// Previews by default. Nothing is sent unless you pass --send.
//
//   node scripts/reclaim.js                    preview every child wallet
//   node scripts/reclaim.js --name main-1      preview just main-1's children
//   node scripts/reclaim.js --day 3            preview just day 3
//   node scripts/reclaim.js --send             ACTUALLY sweep (moves real ETH)
//
// Notes:
//   - Sends one wallet at a time and waits for each to confirm. Hundreds of
//     children will take a while. Let it finish.
//   - Not a full refund: each sweep leaves ~1 gas fee of dust behind, because
//     we hold back 2x the fee so the send can't fail on gas.
//   - Re-running is safe. Already-drained wallets just get skipped.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet, formatEther, isAddress } from "ethers";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = join(ROOT, "output");

const NETWORKS = {
  mainnet: { name: "Robinhood Chain", chainId: 4663, rpcUrl: "https://rpc.mainnet.chain.robinhood.com" },
  testnet: { name: "Robinhood Chain Testnet", chainId: 46630, rpcUrl: "https://rpc.testnet.chain.robinhood.com" },
};

// ---- args ----

const argv = process.argv.slice(2);
const SEND = argv.includes("--send");

function flagValue(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

const onlyName = flagValue("name");
const onlyDayRaw = flagValue("day");
const onlyDay = onlyDayRaw === null ? null : Number(onlyDayRaw);
if (onlyDay !== null && !Number.isFinite(onlyDay)) {
  console.error(`\n--day must be a number, got "${onlyDayRaw}".\n`);
  process.exit(1);
}

// ---- config ----

const cfgPath = join(ROOT, "config.json");
if (!existsSync(cfgPath)) {
  console.error(`\nNo config.json at ${cfgPath}.\n`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

const to = cfg.superMainWallet;
if (!to || !isAddress(to)) {
  console.error(`\nconfig.json "superMainWallet" isn't a usable address: ${to ?? "(missing)"}`);
  console.error("Set it to the address you want the ETH sent to, then re-run:");
  console.error('    "superMainWallet": "0xYourRealAddress"\n');
  process.exit(1);
}

const net = NETWORKS[cfg.network];
if (!net) {
  console.error(`\nUnknown network "${cfg.network}" in config.json. Use "mainnet" or "testnet".\n`);
  process.exit(1);
}

// ---- collect the child wallets off disk ----

function loadChildren() {
  if (!existsSync(OUTPUT_ROOT)) return [];
  const out = [];
  for (const dirent of readdirSync(OUTPUT_ROOT, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dir = join(OUTPUT_ROOT, dirent.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      let payload;
      try {
        payload = JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        continue; // not a wallet file — skip it
      }
      if (!payload || !Array.isArray(payload.wallets)) continue;
      for (const w of payload.wallets) {
        if (!w?.privateKey) continue;
        out.push({ main: payload.mainWallet, day: payload.day, index: w.index, address: w.address, privateKey: w.privateKey });
      }
    }
  }
  return out;
}

function dedupeByAddress(children) {
  const seen = new Set();
  return children.filter((c) => {
    const key = String(c.address).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- sweep ----

async function estimateFee(provider, signer) {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  let gasLimit = 21000n; // plain ETH transfer fallback
  try {
    gasLimit = await signer.estimateGas({ to, value: 1n });
  } catch {
    // keep the fallback
  }
  return gasLimit * gasPrice;
}

async function main() {
  let children = dedupeByAddress(loadChildren());
  if (onlyName !== null) children = children.filter((c) => c.main === onlyName);
  if (onlyDay !== null) children = children.filter((c) => Number(c.day) === onlyDay);

  const scope = `${onlyName ?? "all main wallets"}, ${onlyDay !== null ? `day ${onlyDay}` : "all days"}`;

  console.log(`\nReclaim child wallets -> ${to}`);
  console.log(`Network:  ${net.name} (chainId ${net.chainId})`);
  console.log(`Scope:    ${scope}`);
  console.log(`Mode:     ${SEND ? "*** LIVE — REAL ETH WILL MOVE ***" : "PREVIEW (nothing sent; pass --send to sweep)"}`);
  console.log(`Found:    ${children.length} child wallet(s) on disk\n`);

  if (children.length === 0) {
    if (!existsSync(OUTPUT_ROOT)) {
      console.log(`No output/ directory at ${OUTPUT_ROOT}.`);
      console.log("The child wallets live wherever the worker actually ran — run this there.\n");
    } else {
      console.log("Nothing matched. Check --name / --day.\n");
    }
    return;
  }

  const provider = new JsonRpcProvider(cfg.rpcUrl || net.rpcUrl, net.chainId, { staticNetwork: true });

  console.log("wallet                  balance(ETH)     sweep(ETH)      result");
  console.log("----------------------  ---------------  --------------  ------------------------------------");

  let swept = 0, skipped = 0, errored = 0, totalWei = 0n;

  for (const c of children) {
    const label = `${c.main}/day${c.day}#${c.index}`;
    let balanceStr = "0", sweepStr = "0", result = "-";
    try {
      const signer = new Wallet(c.privateKey, provider);
      const balance = await provider.getBalance(signer.address);
      balanceStr = formatEther(balance);

      const fee = await estimateFee(provider, signer);
      const value = balance - fee * 2n; // hold back 2x so the send can't fail on gas

      if (value <= 0n) {
        result = "balance too low to cover gas";
        skipped++;
      } else {
        sweepStr = formatEther(value);
        if (!SEND) {
          result = "preview — not sent";
          skipped++;
          totalWei += value;
        } else {
          const tx = await signer.sendTransaction({ to, value });
          await tx.wait(1);
          result = tx.hash;
          swept++;
          totalWei += value;
        }
      }
    } catch (e) {
      result = `ERR: ${e.shortMessage ?? e.message}`;
      errored++;
    }
    console.log(`${label.padEnd(22)}  ${balanceStr.padStart(15)}  ${sweepStr.padStart(14)}  ${result}`);
  }

  console.log(
    `\n${swept} swept, ${skipped} skipped, ${errored} errored. ` +
      `${SEND ? "Recovered" : "Would recover"} ${formatEther(totalWei)} ETH.`
  );
  if (!SEND) console.log("Preview only — nothing was sent. Re-run with --send to sweep for real.");
  console.log("");
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message}\n`);
  process.exit(1);
});
