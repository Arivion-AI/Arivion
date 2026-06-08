// Copilot talks to the Duality agent service (LLM Gateway + Copilot routes), which is separate from
// the Lab API. The browser hits this Next proxy at /api/copilot/*; the proxy exchanges the Privy
// access token for an internal owner token (via the Lab API /auth/session) and forwards it as a
// Bearer to the agent — the browser never holds the owner token.

export const COPILOT_PROXY_PREFIX = "/api/copilot";

export const runtimeCopilotConfig = {
  // The Lab API that performs the Privy→owner-token exchange (POST /auth/session).
  authBaseUrl: process.env.NETRUNNERS_API_URL ?? "http://localhost:4400",
  // The agent service that owns the /api/copilot/* routes.
  agentBaseUrl: process.env.NETRUNNERS_AGENT_URL ?? "http://localhost:4500",
  ownerId: process.env.NETRUNNERS_OWNER_ID ?? "1",
  staticToken: process.env.NETRUNNERS_API_TOKEN,
};
