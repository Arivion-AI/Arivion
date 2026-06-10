import { describe, expect, test } from "vitest";
import { buildChatTools, type McpToolSource } from "../src/chat/tools.js";
import type { NormalizedToolResult } from "../src/mcp/normalize.js";

// No DB, no network — exercises the dynamic catalog construction against a fake MCP source.
function fakeMcp(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): McpToolSource {
  return {
    async listTools() { return tools; },
    async callTool(): Promise<NormalizedToolResult> { return { isError: false, text: "", raw: undefined, honesty: {} }; },
  };
}

describe("buildChatTools", () => {
  test("includes read-only tools from the live catalog", async () => {
    const specs = await buildChatTools(fakeMcp([
      { name: "list_symbols", description: "list", inputSchema: { type: "object", properties: {} } },
      { name: "get_candles", description: "candles", inputSchema: { type: "object", properties: { symbol: { type: "string" } } } },
    ]));
    const names = specs.map((s) => s.name);
    expect(names).toContain("list_symbols");
    expect(names).toContain("get_candles");
    // schema is passed through verbatim so the model knows the params.
    expect(specs.find((s) => s.name === "get_candles")?.parameters).toEqual({ type: "object", properties: { symbol: { type: "string" } } });
  });

  test("excludes mutating tools (guardrails must wrap them)", async () => {
    const specs = await buildChatTools(fakeMcp([
      { name: "list_symbols" },
      { name: "run_bot_backtest" },
      { name: "marketplace_publish" },
      { name: "create_bot_spec" },
    ]));
    const names = specs.map((s) => s.name);
    expect(names).toContain("list_symbols");
    expect(names).not.toContain("run_bot_backtest");
    expect(names).not.toContain("marketplace_publish");
    expect(names).not.toContain("create_bot_spec");
  });

  test("always includes the orchestrated build_and_backtest action", async () => {
    const specs = await buildChatTools(fakeMcp([{ name: "list_symbols" }]));
    expect(specs.map((s) => s.name)).toContain("build_and_backtest");
  });

  test("degrades to the agent-native actions only when listTools fails", async () => {
    const broken: McpToolSource = {
      async listTools() { throw new Error("mcp down"); },
      async callTool(): Promise<NormalizedToolResult> { return { isError: false, text: "", raw: undefined, honesty: {} }; },
    };
    const specs = await buildChatTools(broken);
    // No read catalog, but the full agent-native action surface remains.
    expect(specs.map((s) => s.name)).toEqual(expect.arrayContaining([
      "build_and_backtest", "research_web", "analyze_symbol", "open_managed_position", "list_positions",
      "setup_multiasset", "start_multiasset_paper", "screen_tokens", "scan_market", "market_overview", "token_news",
      "dune_query", "compare_pools", "screen_lps", "analyze_lp", "gmx_market", "backtest_lp", "gmx_strategy",
      "gmx_wizard", "glv_vaults", "market_sentiment", "positions_review", "add_knowledge", "list_knowledge",
      "forget_knowledge", "search_knowledge", "discovery_intake", "reason_portfolio", "ask_user",
    ]));
  });

  test("always includes the living-trader + market-awareness actions", async () => {
    const specs = await buildChatTools(fakeMcp([{ name: "list_symbols" }]));
    const names = specs.map((s) => s.name);
    for (const t of [
      "research_web", "analyze_symbol", "open_managed_position", "list_positions",
      "screen_tokens", "scan_market", "market_overview", "token_news", "market_sentiment",
      "screen_lps", "analyze_lp", "gmx_wizard", "positions_review",
      "search_knowledge", "discovery_intake", "reason_portfolio", "ask_user",
    ]) {
      expect(names).toContain(t);
    }
  });
});
