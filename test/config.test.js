import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config.js";

const KEY_A = "0x" + "a".repeat(64);
const KEY_B = "0x" + "b".repeat(64);

test("applies defaults and normalizes a minimal config", () => {
  const cfg = normalizeConfig({ mainWallets: [{ privateKey: KEY_A }] });
  assert.equal(cfg.network, "testnet");
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.intervalHours, 24);
  assert.equal(cfg.mainWallets[0].name, "main-1");
  assert.equal(cfg.mainWallets[0].walletsPerDay, 10);
  assert.equal(cfg.mainWallets[0].amountEth, "0.0005");
});

test("per-wallet overrides win over defaults", () => {
  const cfg = normalizeConfig({
    network: "mainnet",
    mainWallets: [
      { name: "whale", privateKey: KEY_A, walletsPerDay: 3, amountEth: "0.01" },
      { privateKey: KEY_B },
    ],
  });
  assert.equal(cfg.network, "mainnet");
  assert.equal(cfg.mainWallets[0].name, "whale");
  assert.equal(cfg.mainWallets[0].walletsPerDay, 3);
  assert.equal(cfg.mainWallets[0].amountEth, "0.01");
  assert.equal(cfg.mainWallets[1].name, "main-2");
});

test("rejects an empty or missing mainWallets array", () => {
  assert.throws(() => normalizeConfig({ mainWallets: [] }), /non-empty array/);
  assert.throws(() => normalizeConfig({}), /non-empty array/);
});

test("rejects a malformed private key", () => {
  assert.throws(() => normalizeConfig({ mainWallets: [{ privateKey: "nope" }] }), /privateKey/);
});

test("rpcUrl defaults to null and an empty string stays null", () => {
  assert.equal(normalizeConfig({ mainWallets: [{ privateKey: KEY_A }] }).rpcUrl, null);
  assert.equal(
    normalizeConfig({ rpcUrl: "", mainWallets: [{ privateKey: KEY_A }] }).rpcUrl,
    null
  );
});

test("accepts a valid rpcUrl override", () => {
  const cfg = normalizeConfig({
    rpcUrl: "https://example.quiknode.pro/token/",
    mainWallets: [{ privateKey: KEY_A }],
  });
  assert.equal(cfg.rpcUrl, "https://example.quiknode.pro/token/");
});

test("rejects a non-URL rpcUrl", () => {
  assert.throws(
    () => normalizeConfig({ rpcUrl: "not-a-url", mainWallets: [{ privateKey: KEY_A }] }),
    /rpcUrl/
  );
});

test("rejects an unknown network", () => {
  assert.throws(
    () => normalizeConfig({ network: "polygon", mainWallets: [{ privateKey: KEY_A }] }),
    /Unknown network/
  );
});

test("rejects duplicate main wallet names", () => {
  assert.throws(
    () =>
      normalizeConfig({
        mainWallets: [
          { name: "dup", privateKey: KEY_A },
          { name: "dup", privateKey: KEY_B },
        ],
      }),
    /duplicate/
  );
});

test("rejects a name that is unsafe as a folder", () => {
  assert.throws(
    () => normalizeConfig({ mainWallets: [{ name: "../evil", privateKey: KEY_A }] }),
    /alphanumeric/
  );
});
