import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";

// Boots the MCP server in-memory and exercises the discovery/introspection
// surface — no live lab stack required (these tools are pure KB lookups).
describe("duality-mcp discovery surface", () => {
  let client: Client;

  beforeAll(async () => {
    const cfg = { ...loadConfig([]), enableInternal: true };
    const { server } = createServer(cfg);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "smoke", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  it("lists a rich set of tools across domains", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_capabilities");
    expect(names).toContain("get_param_help");
    expect(names).toContain("run_bot_backtest");
    expect(names).toContain("run_paper_runtime");
    expect(names).toContain("verify_passport_direct"); // internal enabled
    expect(names.length).toBeGreaterThan(60);
  });

  it("list_capabilities groups tools by domain", async () => {
    const res = await client.callTool({ name: "list_capabilities", arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0].text;
    const data = JSON.parse(text);
    expect(data.toolsByDomain).toHaveProperty("bots");
    expect(data.catalogs.strategies).toContain("avellaneda_stoikov");
    expect(data.catalogs.bots).toContain("futures_martingale");
  });

  it("get_param_help returns full param spec for a bot", async () => {
    const res = await client.callTool({ name: "get_param_help", arguments: { kind: "bot", id: "futures_martingale" } });
    const data = JSON.parse((res.content as { text: string }[])[0].text);
    expect(data.id).toBe("futures_martingale");
    const names = data.params.map((p: { name: string }) => p.name);
    expect(names).toContain("hard_stop_loss_fraction");
    const hardStop = data.params.find((p: { name: string }) => p.name === "hard_stop_loss_fraction");
    expect(hardStop.required).toBe(true);
  });

  it("explain_error decodes a known code", async () => {
    const res = await client.callTool({ name: "explain_error", arguments: { code: "RUIN_MARGIN_EXCEEDS_CAPITAL" } });
    const data = JSON.parse((res.content as { text: string }[])[0].text);
    expect(data.meaning).toMatch(/ruin/i);
    expect(data.fix).toBeTruthy();
  });

  it("explain_error handles suffixed codes", async () => {
    const res = await client.callTool({ name: "explain_error", arguments: { code: "CANDLE_GAP_5_BARS_AT_123" } });
    const data = JSON.parse((res.content as { text: string }[])[0].text);
    expect(data.meaning).toMatch(/gap/i);
  });

  it("lists catalog resources", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("duality://catalog/bots");
    expect(uris).toContain("duality://reference/error-codes");
  });

  it("reads a templated bot resource", async () => {
    const res = await client.readResource({ uri: "duality://catalog/bots/spot_grid" });
    const data = JSON.parse((res.contents as { text: string }[])[0].text);
    expect(data.id).toBe("spot_grid");
  });

  it("exposes guided prompts", async () => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain("compose_and_run_bot");
    expect(names).toContain("enable_execution_fidelity");
  });
});
