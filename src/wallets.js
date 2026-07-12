import { Wallet } from "ethers";

// Generate a single fresh wallet with its address, private key and 12-word
// seed phrase (mnemonic). Each wallet is independent and randomly generated.
export function generateWallet(index) {
  const w = Wallet.createRandom();
  return {
    index,
    address: w.address,
    privateKey: w.privateKey,
    seedPhrase: w.mnemonic?.phrase ?? null,
  };
}

// Generate `count` fresh wallets, indexed 1..count.
export function generateWallets(count) {
  const wallets = [];
  for (let i = 1; i <= count; i++) {
    wallets.push(generateWallet(i));
  }
  return wallets;
}
