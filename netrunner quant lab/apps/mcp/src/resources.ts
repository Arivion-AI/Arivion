import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as kb from "./kb/index.js";
import type { Clients } from "./http/client.js";
import { currentContext } from "./context.js";

function json(uri: string, data: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
}

export function registerResources(server: McpServer, clients: Clients, enableLive: boolean): void {
  // ---- Static catalogs ----
  const statics: { uri: string; name: string; data: () => unknown }[] = [
    { uri: "duality://catalog/strategies", name: "Strategy catalog", data: () => kb.STRATEGIES },
    { uri: "duality://catalog/bots", name: "Bot catalog", data: () => kb.BOTS },
    { uri: "duality://catalog/portfolio-schemes", name: "Portfolio weighting", data: () => kb.PORTFOLIO_REFERENCE },
    { uri: "duality://catalog/optimizer-methods", name: "Optimizer methods", data: () => kb.OPTIMIZER_REFERENCE },
    { uri: "duality://catalog/regimes", name: "Recommender regimes", data: () => kb.RECOMMENDER_REFERENCE },
    { uri: "duality://catalog/xstocks", name: "xStocks", data: () => kb.XSTOCKS_REFERENCE },
    { uri: "duality://catalog/chains", name: "Chain registry", data: () => kb.CHAIN_REFERENCE },
    { uri: "duality://catalog/dex-venues", name: "DEX venues", data: () => kb.DEX_VENUE_REFERENCE },
    { uri: "duality://reference/venue", name: "Bybit venue layer", data: () => kb.VENUE_REFERENCE },
    { uri: "duality://reference/fill-model", name: "Fill model & fidelity", data: () => kb.FILL_MODEL_REFERENCE },
    { uri: "duality://reference/amm-fill-model", name: "AMM fill model", data: () => kb.AMM_FILL_MODEL_REFERENCE },
    { uri: "duality://reference/risk-cockpit", name: "Risk cockpit", data: () => kb.RISK_COCKPIT_REFERENCE },
    { uri: "duality://reference/error-codes", name: "Error-code dictionary", data: () => kb.ERROR_CODES },
    { uri: "duality://reference/env", name: "Environment variables", data: () => kb.ENV_REFERENCE },
  ];
  for (const s of statics) {
    server.registerResource(s.name, s.uri, { description: s.name, mimeType: "application/json" }, async (uri) =>
      json(uri.href, s.data())
    );
  }

  // ---- Templated: one bot's spec ----
  server.registerResource(
    "Bot spec",
    new ResourceTemplate("duality://catalog/bots/{botType}", {
      list: async () => ({ resources: kb.BOTS.map((b) => ({ uri: `duality://catalog/bots/${b.id}`, name: b.title })) }),
    }),
    { description: "Parameter spec for one bot type", mimeType: "application/json" },
    async (uri, variables) => {
      const id = String(variables.botType);
      return json(uri.href, kb.getBot(id) ?? { error: `unknown bot '${id}'`, available: kb.botIds() });
    }
  );

  // ---- Templated: one strategy's spec ----
  server.registerResource(
    "Strategy spec",
    new ResourceTemplate("duality://catalog/strategies/{strategyId}", {
      list: async () => ({ resources: kb.STRATEGIES.map((s) => ({ uri: `duality://catalog/strategies/${s.id}`, name: s.title })) }),
    }),
    { description: "Parameter spec for one strategy", mimeType: "application/json" },
    async (uri, variables) => {
      const id = String(variables.strategyId);
      return json(uri.href, kb.getStrategy(id) ?? { error: `unknown strategy '${id}'`, available: kb.strategyIds() });
    }
  );

  // ---- Live snapshots (read = fetch current state) ----
  if (enableLive) {
    server.registerResource("Live prices", "duality://live/prices", { description: "Current live prices + freshness", mimeType: "application/json" }, async (uri) =>
      json(uri.href, await clients.api.get("/api/live/prices", undefined, currentContext()))
    );
    server.registerResource("Live sessions", "duality://live/sessions", { description: "This owner's live-paper sessions", mimeType: "application/json" }, async (uri) =>
      json(uri.href, await clients.api.get("/api/live-paper/sessions", undefined, currentContext()))
    );
    server.registerResource("Realtime status", "duality://live/realtime-status", { description: "WS collector status", mimeType: "application/json" }, async (uri) =>
      json(uri.href, await clients.api.get("/api/realtime/status", undefined, currentContext()))
    );
    server.registerResource("Live DEX pools", "duality://live/dex-pools", { description: "Indexed DEX pools with latest snapshots", mimeType: "application/json" }, async (uri) =>
      json(uri.href, await clients.api.get("/api/dex/pools", { limit: 100 }, currentContext()))
    );
  }
}
