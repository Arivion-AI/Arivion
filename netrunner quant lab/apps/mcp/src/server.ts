import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { buildAuthProvider, type AuthProvider } from "./auth/provider.js";
import { buildClients, type Clients } from "./http/client.js";
import { Registrar } from "./tools/registry.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerDataTools } from "./tools/data.js";
import { registerDexTools } from "./tools/dex.js";
import { registerBuildTools } from "./tools/build.js";
import { registerLiveTools } from "./tools/live.js";
import { registerInternalTools } from "./tools/internal.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

export interface BuiltServer {
  server: McpServer;
  clients: Clients;
  auth: AuthProvider;
}

export function createServer(cfg: Config): BuiltServer {
  const server = new McpServer(
    { name: "duality-quant-lab", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        "Duality Netrunner Quant Lab. Call list_capabilities first. Use get_param_help to learn which values go where, and explain_error to decode any failure code. All backtests are honest: read the fill_model flags (maker_fills_optimistic / liquidity_free_upper_bound) on every run.",
    }
  );

  const auth = buildAuthProvider(cfg);
  const clients = buildClients(cfg, auth);
  const r = new Registrar(server, clients, cfg, auth);

  // Order matters only for the capability index grouping.
  registerMetaTools(r);
  registerDataTools(r);
  registerDexTools(r);
  registerBuildTools(r);
  registerLiveTools(r);
  if (cfg.enableInternal) registerInternalTools(r);

  registerResources(server, clients, true);
  registerPrompts(server);

  return { server, clients, auth };
}
