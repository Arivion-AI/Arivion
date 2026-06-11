#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startStdio } from "./transports/stdio.js";
import { startHttp } from "./transports/http.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.transport === "http") {
    await startHttp(cfg);
  } else {
    await startStdio(cfg);
  }
}

main().catch((err) => {
  process.stderr.write(`[duality-mcp] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
