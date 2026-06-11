import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import { createServer } from "../server.js";
import { runWithContext } from "../context.js";
import type { RequestContext } from "../auth/provider.js";

// Extract the per-request owner context from headers. In passthrough mode the
// caller supplies an owner token; we accept the standard Authorization bearer or
// an explicit x-duality-owner-token / x-duality-owner-id.
function contextFromHeaders(req: Request): RequestContext {
  const auth = req.header("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
  const ownerToken = req.header("x-duality-owner-token") || bearer;
  const ownerIdHdr = req.header("x-duality-owner-id");
  return { ownerToken, ownerId: ownerIdHdr ? Number(ownerIdHdr) : undefined };
}

export async function startHttp(cfg: Config): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "16mb" }));

  // CORS (allowlist-only; the MCP session header must be exposed for browser clients).
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && (cfg.httpCorsOrigins.length === 0 || cfg.httpCorsOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, x-duality-owner-token, x-duality-owner-id");
      res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, service: "duality-mcp", transport: "http", auth: cfg.authMode }));

  // One transport per MCP session.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport!;
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) delete transports[transport!.sessionId];
      };
      const { server } = createServer(cfg);
      await server.connect(transport);
    }

    if (!transport) {
      return res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send an initialize request first." }, id: null });
    }

    await runWithContext(contextFromHeaders(req), () => transport!.handleRequest(req, res, req.body));
  });

  // GET (server->client SSE) and DELETE (session teardown) reuse the session transport.
  const sessionRoute = async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) return res.status(400).send("Unknown or missing mcp-session-id");
    await runWithContext(contextFromHeaders(req), () => transport.handleRequest(req, res));
  };
  app.get("/mcp", sessionRoute);
  app.delete("/mcp", sessionRoute);

  await new Promise<void>((resolve) => {
    app.listen(cfg.httpPort, () => {
      process.stderr.write(`[duality-mcp] HTTP transport on :${cfg.httpPort}/mcp (auth=${cfg.authMode}, api=${cfg.apiUrl})\n`);
      resolve();
    });
  });
}
