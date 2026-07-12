import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { walletFilePath } from "../src/storage.js";

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
