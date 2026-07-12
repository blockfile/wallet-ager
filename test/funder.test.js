import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "ethers";
import { canAffordBatch } from "../src/funder.js";

test("canAffordBatch is true when balance covers count*amount + gas buffer", () => {
  // 10 * 0.0005 + 0.0005 buffer = 0.0055 ETH needed
  assert.equal(canAffordBatch(parseEther("0.0055"), "0.0005", 10, "0.0005"), true);
  assert.equal(canAffordBatch(parseEther("1.0"), "0.0005", 10, "0.0005"), true);
});

test("canAffordBatch is false when balance is one wei short", () => {
  const needed = parseEther("0.0055");
  assert.equal(canAffordBatch(needed - 1n, "0.0005", 10, "0.0005"), false);
});

test("canAffordBatch is false on an empty wallet", () => {
  assert.equal(canAffordBatch(0n, "0.0005", 10, "0.0005"), false);
});
