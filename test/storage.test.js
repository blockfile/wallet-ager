import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { walletFilePath, walletTxtFilePath, formatWalletsTxt, lastRunForNextRun } from "../src/storage.js";

test("wallet file name includes the main wallet name and day", () => {
  assert.equal(basename(walletFilePath("main-2", 1)), "wallets-main-2-day1.json");
  assert.equal(basename(walletFilePath("main-10", 3)), "wallets-main-10-day3.json");
});

test("different main wallets never share a file name (safe when flattened)", () => {
  assert.notEqual(
    basename(walletFilePath("main-1", 1)),
    basename(walletFilePath("main-2", 1))
  );
});

test("lastRunForNextRun places the next run exactly one interval ahead", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const nextRun = 2_000_000_000_000;
  const lastRun = lastRunForNextRun(nextRun, DAY);
  assert.equal(lastRun, nextRun - DAY);
  assert.equal(lastRun + DAY, nextRun); // lastRun + interval === desired next run
});

test("txt file path mirrors the json name with a .txt extension", () => {
  assert.equal(basename(walletTxtFilePath("main-2", 1)), "wallets-main-2-day1.txt");
});

test("formatWalletsTxt includes address, private key and seed phrase", () => {
  const payload = {
    mainWallet: "main-2",
    address: "0xMAIN",
    network: "Robinhood Chain",
    chainId: 4663,
    day: 1,
    date: "2026-07-12T00:00:00.000Z",
    amountEth: "0.0005",
    dryRun: false,
    wallets: [
      { index: 1, address: "0xAAA", privateKey: "0xKEY", seedPhrase: "one two three", txHash: "0xTX", funded: true, error: null },
    ],
  };
  const txt = formatWalletsTxt(payload);
  assert.match(txt, /main-2/);
  assert.match(txt, /0xAAA/);
  assert.match(txt, /0xKEY/);
  assert.match(txt, /one two three/);
  assert.match(txt, /0xTX/);
});
