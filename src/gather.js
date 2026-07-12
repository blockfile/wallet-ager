import { makeProvider, makeSigner, formatEther } from "./funder.js";

// How much of a wallet's balance can be swept, after holding back a gas
// reserve. Pure and testable. `feeWei` is the estimated cost of the sweep tx;
// we hold back `marginTimes x fee` so the send never fails on gas. Returns 0n
// when the balance can't cover the reserve.
export function computeSweepValue(balanceWei, feeWei, marginTimes = 2n) {
  const value = balanceWei - feeWei * marginTimes;
  return value > 0n ? value : 0n;
}

async function estimateSweepFee(provider, signer, to) {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  let gasLimit = 21000n; // plain ETH transfer fallback
  try {
    gasLimit = await signer.estimateGas({ to, value: 1n });
  } catch {
    // keep fallback
  }
  return gasLimit * gasPrice;
}

// Sweep each main wallet's balance up to cfg.superMainWallet.
// In dryRun mode nothing is sent; each entry reports what WOULD be swept.
// Returns [{ name, address, balance, sweep, txHash, skipped, error }] (ETH strings).
export async function gatherFunds(cfg, { dryRun = false } = {}) {
  if (!cfg.superMainWallet) {
    throw new Error(
      'No "superMainWallet" address in config.json. Add it, e.g. "superMainWallet": "0xYourColdWallet".'
    );
  }
  const to = cfg.superMainWallet;
  const provider = makeProvider(cfg.network, cfg.rpcUrl);
  const results = [];

  for (const w of cfg.mainWallets) {
    const signer = makeSigner(w.privateKey, provider);
    const entry = { name: w.name, address: signer.address, balance: "0", sweep: "0", txHash: null, skipped: null, error: null };
    try {
      const balance = await provider.getBalance(signer.address);
      entry.balance = formatEther(balance);

      const fee = await estimateSweepFee(provider, signer, to);
      const value = computeSweepValue(balance, fee, 2n);
      if (value <= 0n) {
        entry.skipped = "balance too low to cover gas";
        results.push(entry);
        continue;
      }
      entry.sweep = formatEther(value);

      if (dryRun) {
        entry.skipped = "dry run — not sent";
        results.push(entry);
        continue;
      }

      const tx = await signer.sendTransaction({ to, value });
      await tx.wait(1);
      entry.txHash = tx.hash;
    } catch (e) {
      entry.error = e.shortMessage ?? e.message;
    }
    results.push(entry);
  }
  return results;
}
