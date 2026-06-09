import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { withBackoff } from "./backoff.js";
import { normalizeToolResult, isRateLimited, type NormalizedToolResult, type McpToolResultLike } from "./normalize.js";

// The agent's MCP client. Owner-scoped: the per-request owner token is passed straight through to
// the Lab MCP server (it accepts Authorization: Bearer <ownerToken>), so every tool call runs as the
// owner — never as a shared service identity. 429s are retried with backoff; the honesty fields in
// every result are preserved by the normalizer.

class RateLimitError extends Error {}

export class McpClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(private ownerToken: string, baseUrl = config.mcpServerUrl) {
    this.transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${this.ownerToken}` } },
    });
    this.client = new Client({ name: "duality-agent", version: "0.1.0" }, { capabilities: {} });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  // List every owner-scoped tool the Lab MCP server exposes, with its JSON-Schema input shape.
  // Used to build the chat agent's tool catalog dynamically (the real surface, not a hard-coded few).
  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
    await this.connect();
    const res = (await this.client.listTools()) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    return res.tools ?? [];
  }

  // Raw tool call with 429 backoff + result normalization (honesty fields preserved).
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<NormalizedToolResult> {
    await this.connect();
    const run = async (): Promise<NormalizedToolResult> => {
      const result = (await this.client.callTool({ name, arguments: args })) as McpToolResultLike;
      const norm = normalizeToolResult(result);
      if (norm.isError && isRateLimited(norm.text)) throw new RateLimitError(norm.text);
      return norm;
    };
    return withBackoff(run, {
      isRetryable: (e) => e instanceof RateLimitError || isRateLimited(e),
    });
  }

  // --- Discovery wrappers (the four required tools) -----------------------------------------
  async listCapabilities(): Promise<unknown> {
    return (await this.callTool("list_capabilities")).raw;
  }
  async describeTool(tool: string): Promise<unknown> {
    return (await this.callTool("describe_tool", { tool })).raw;
  }
  async getParamHelp(kind: string, id?: string): Promise<unknown> {
    return (await this.callTool("get_param_help", id ? { kind, id } : { kind })).raw;
  }
  async explainError(code: string): Promise<unknown> {
    return (await this.callTool("explain_error", { code })).raw;
  }
  async health(): Promise<unknown> {
    return (await this.callTool("health")).raw;
  }
}

// Convenience: create + connect a client for an owner token.
export async function connectMcp(ownerToken: string): Promise<McpClient> {
  const c = new McpClient(ownerToken);
  try {
    await c.connect();
  } catch (e) {
    logger.error("mcp connect failed", { message: (e as Error).message });
    throw e;
  }
  return c;
}
