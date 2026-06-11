import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "./auth/provider.js";

// Per-request auth context. In HTTP mode the transport sets it per inbound
// request (from headers); in stdio mode it falls back to env vars so a
// passthrough/dev-token setup still works for a single owner.
const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function currentContext(): RequestContext {
  const fromAls = als.getStore();
  if (fromAls) return fromAls;
  const ownerToken = process.env.DUALITY_SESSION_TOKEN;
  const ownerId = process.env.DUALITY_OWNER_ID ? Number(process.env.DUALITY_OWNER_ID) : undefined;
  return { ownerToken, ownerId };
}
