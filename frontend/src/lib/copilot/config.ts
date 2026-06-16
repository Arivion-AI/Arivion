// Copilot talks to the Duality agent service (LLM Gateway + Copilot routes), which is separate from
// the Lab API. The browser hits this Next proxy at /api/copilot/*; it sends the internal owner JWT
// (minted by MetaMask SIWE sign-in) as `x-owner-token` and the proxy forwards it as a Bearer to the
// agent.

export const COPILOT_PROXY_PREFIX = "/api/copilot";

export const runtimeCopilotConfig = {
  // The Lab API that mints owner tokens from SIWE sign-in (GET /auth/nonce, POST /auth/session).
  authBaseUrl: process.env.NETRUNNERS_API_URL ?? "http://localhost:4400",
  // The agent service that owns the /api/copilot/* routes.
  agentBaseUrl: process.env.NETRUNNERS_AGENT_URL ?? "http://localhost:4500",
  ownerId: process.env.NETRUNNERS_OWNER_ID ?? "1",
  staticToken: process.env.NETRUNNERS_API_TOKEN,
};
