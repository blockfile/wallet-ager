import { test } from "node:test";
import assert from "node:assert/strict";
import { isAddress, Wallet } from "ethers";
import { generateWallet, generateWallets } from "../src/wallets.js";

test("generateWallet returns a valid address, private key and seed phrase", () => {
  const w = generateWallet(1);
  assert.equal(w.index, 1);
  assert.ok(isAddress(w.address), "address should be valid");
  assert.match(w.privateKey, /^0x[0-9a-fA-F]{64}$/, "private key should be 32 bytes hex");
  assert.equal(w.seedPhrase.trim().split(/\s+/).length, 12, "seed phrase should have 12 words");
});

test("private key and seed phrase actually derive the reported address", () => {
  const w = generateWallet(1);
  assert.equal(new Wallet(w.privateKey).address, w.address);
  assert.equal(Wallet.fromPhrase(w.seedPhrase).address, w.address);
});

test("generateWallets produces the requested count, all unique, indexed 1..n", () => {
  const wallets = generateWallets(10);
  assert.equal(wallets.length, 10);
  assert.deepEqual(
    wallets.map((w) => w.index),
    Array.from({ length: 10 }, (_, i) => i + 1)
  );
  assert.equal(new Set(wallets.map((w) => w.address)).size, 10, "all addresses unique");
  assert.equal(new Set(wallets.map((w) => w.privateKey)).size, 10, "all keys unique");
});
