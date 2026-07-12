import { loadConfig } from "./config.js";
import { runAll, runOnce } from "./runner.js";

async function main() {
  const once = process.argv.includes("--once");
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(`\nConfig error: ${e.message}\n`);
    process.exit(1);
  }

  if (once) {
    const results = await runOnce(cfg);
    const exhausted = results.filter((r) => r.status === "exhausted").length;
    console.log(`\nDone (--once). ${results.length} main wallet(s) processed, ${exhausted} exhausted.`);
    process.exit(0);
  }

  await runAll(cfg);
  process.exit(0);
}

// Graceful shutdown so systemd restarts are clean.
process.on("SIGINT", () => {
  console.log("\nReceived SIGINT, shutting down. Progress is saved in state/.");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM, shutting down. Progress is saved in state/.");
  process.exit(0);
});

main().catch((e) => {
  console.error(`Fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
