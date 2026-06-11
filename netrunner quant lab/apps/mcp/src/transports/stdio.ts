import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config } from "../config.js";
import { createServer } from "../server.js";

export async function startStdio(cfg: Config): Promise<void> {
  const { server } = createServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel — log to stderr only.
  process.stderr.write(`[duality-mcp] stdio transport ready (auth=${cfg.authMode}, api=${cfg.apiUrl})\n`);
}
