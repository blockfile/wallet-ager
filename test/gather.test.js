import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "ethers";
import { computeSweepValue } from "../src/gather.js";

test("computeSweepValue holds back marginTimes x fee", () => {
  const balance = parseEther("1.0");
  const fee = parseEther("0.0001");
  // reserve = 2 x 0.0001 = 0.0002 => sweep = 0.9998
  assert.equal(computeSweepValue(balance, fee, 2n), parseEther("0.9998"));
});

test("computeSweepValue returns 0 when balance can't cover the reserve", () => {
  assert.equal(computeSweepValue(parseEther("0.0001"), parseEther("0.0001"), 2n), 0n);
  assert.equal(computeSweepValue(0n, parseEther("0.0001"), 2n), 0n);
});

test("computeSweepValue never returns a negative value", () => {
  assert.equal(computeSweepValue(1n, parseEther("0.01"), 2n), 0n);
});
