import { JsonRpcProvider, Wallet, parseEther, formatEther } from "ethers";
import { getNetwork } from "./networks.js";

// Pure affordability check, kept separate so it is easy to test.
// Returns true if `balanceWei` covers count*amount plus a gas buffer.
export function canAffordBatch(balanceWei, amountEth, count, gasBufferEth) {
  const needed = parseEther(amountEth) * BigInt(count) + parseEther(gasBufferEth);
  return balanceWei >= needed;
}

export function makeProvider(networkKey, rpcUrlOverride = null) {
  const net = getNetwork(networkKey);
  const url = rpcUrlOverride || net.rpcUrl;
  // staticNetwork avoids an extra chainId round-trip on every call.
  return new JsonRpcProvider(url, net.chainId, { staticNetwork: true });
}

export function makeSigner(privateKey, provider) {
  return new Wallet(privateKey, provider);
}

// Send `amountEth` to each address in sequence, awaiting each so nonces stay
// ordered. In dryRun mode nothing is sent; each entry is marked funded=false.
// Returns [{ address, txHash, funded, error }].
export async function fundWallets(signer, addresses, amountEth, { dryRun = false } = {}) {
  const value = parseEther(amountEth);
  const results = [];

  for (const address of addresses) {
    if (dryRun) {
      results.push({ address, txHash: null, funded: false, error: null });
      continue;
    }
    try {
      const tx = await signer.sendTransaction({ to: address, value });
      await tx.wait(1); // wait for 1 confirmation before the next send
      results.push({ address, txHash: tx.hash, funded: true, error: null });
    } catch (e) {
      results.push({ address, txHash: null, funded: false, error: e.shortMessage ?? e.message });
    }
  }
  return results;
}

export { formatEther };
