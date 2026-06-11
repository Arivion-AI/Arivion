// Central configuration for the Duality Quant Lab MCP server.
// Every value is read from the environment with a sane default so the server
// boots against a local `docker compose` stack with zero config.

export type AuthMode = "configured" | "dev-token" | "passthrough";
export type TransportMode = "stdio" | "http";

export interface Config {
  apiUrl: string;
  verifierUrl: string;
  ingestorUrl: string;
  sandboxUrl: string;

  authMode: AuthMode;
  apiToken?: string; // configured mode: a pre-minted internal owner JWT
  defaultOwnerId: number; // dev-token mode: ownerId to mint for
  internalSecret?: string; // x-internal-secret added to every call when set

  enableInternal: boolean; // expose verifier/ingestor/sandbox tools

  transport: TransportMode;
  httpPort: number;
  httpCorsOrigins: string[];

  requestTimeoutMs: number;
}

function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined) return dflt;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const transport: TransportMode = argv.includes("--http")
    ? "http"
    : argv.includes("--stdio")
      ? "stdio"
      : (process.env.DUALITY_TRANSPORT as TransportMode) || "stdio";

  const authMode = (process.env.DUALITY_AUTH_MODE as AuthMode) || "configured";

  return {
    apiUrl: process.env.DUALITY_API_URL || "http://localhost:4400",
    verifierUrl: process.env.DUALITY_VERIFIER_URL || "http://localhost:7200",
    ingestorUrl: process.env.DUALITY_INGESTOR_URL || "http://localhost:7100",
    sandboxUrl: process.env.DUALITY_SANDBOX_URL || "http://localhost:7300",

    authMode,
    apiToken: process.env.DUALITY_API_TOKEN,
    defaultOwnerId: Number(process.env.DUALITY_DEFAULT_OWNER_ID || "1"),
    internalSecret: process.env.INTERNAL_SECRET,

    enableInternal: bool(process.env.DUALITY_ENABLE_INTERNAL, false),

    transport,
    httpPort: Number(process.env.DUALITY_HTTP_PORT || "8080"),
    httpCorsOrigins: (process.env.DUALITY_HTTP_CORS_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),

    requestTimeoutMs: Number(process.env.DUALITY_REQUEST_TIMEOUT_MS || "60000"),
  };
}
