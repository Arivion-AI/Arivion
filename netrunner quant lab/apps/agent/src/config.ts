// Centralized env parsing for the Copilot agent service. Read once at import; throw loud on
// production misconfiguration (e.g. BYOK enabled without KMS — correction #2).

function num(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got '${raw}'`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return raw === "true" || raw === "1";
}

const isProd = process.env.NODE_ENV === "production";

export const config = {
  isProd,
  port: num("AGENT_PORT", 4500),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/duality",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  mcpServerUrl: process.env.MCP_SERVER_URL ?? "http://localhost:4600",
  // Internal API (the Lab) — for any server-to-server reads the agent needs outside MCP.
  apiBaseUrl: process.env.NETRUNNERS_API_URL ?? "http://localhost:4400",

  // Welcome grant (Phase 1).
  welcomeCreditUsd: num("COPILOT_WELCOME_CREDIT_USD", 2.0),
  welcomeCreditExpiresDays: num("COPILOT_WELCOME_CREDIT_EXPIRES_DAYS", 30),

  // Budget caps (Phase 1/8). micro-USD where noted.
  maxCostPerRunUsd: num("COPILOT_MAX_COST_PER_RUN_USD", 1.0),
  maxCostPerStepUsd: num("COPILOT_MAX_COST_PER_STEP_USD", 0.5),
  maxCostPerDayUsd: num("COPILOT_MAX_COST_PER_DAY_USD", 5.0),
  maxOutputTokensPerStep: num("COPILOT_MAX_OUTPUT_TOKENS_PER_STEP", 4096),
  maxModelContextTokens: num("COPILOT_MAX_MODEL_CONTEXT_TOKENS", 200000),

  // Chat agent tool-calling loop budget. A real discover→build→validate→backtest chain needs more
  // than a handful of round-trips; when exhausted the engine does one final tools-off summary pass.
  chatMaxToolRounds: num("COPILOT_CHAT_MAX_TOOL_ROUNDS", 12),

  // Reservation TTL — a hold older than this is safe to release by a sweeper.
  reservationTtlSeconds: num("COPILOT_RESERVATION_TTL_SECONDS", 300),

  // Phase 3 — memory. Embeddings are computed with this model; recall filters by embedding_model so
  // vectors from different models are never compared.
  embeddingProvider: process.env.COPILOT_EMBEDDING_PROVIDER ?? "openai",
  embeddingModel: process.env.COPILOT_EMBEDDING_MODEL ?? "text-embedding-3-small",
  embeddingDim: num("COPILOT_EMBEDDING_DIM", 1536),
  memoryRecallTopN: num("COPILOT_MEMORY_RECALL_TOP_N", 6),

  // Phase 4 — triggers. Per-owner safety rails for event-driven autonomy.
  triggerCooldownSeconds: num("COPILOT_TRIGGER_COOLDOWN_SECONDS", 1800),
  triggerMaxPerDay: num("COPILOT_TRIGGER_MAX_PER_DAY", 20),

  // Phase 4/5 — global kill switch (emergency stop for all autonomous activity).
  globalKillSwitch: bool("COPILOT_GLOBAL_KILL_SWITCH", false),

  // Phase 5 — autonomous run/day caps (separate from the USD budget).
  maxRunsPerDay: num("COPILOT_MAX_RUNS_PER_DAY", 20),
  maxLiveSessionsPerDay: num("COPILOT_MAX_LIVE_SESSIONS_PER_DAY", 1),

  // Phase 6 — learning. Promotion gates + exploration.
  banditExploreProb: num("COPILOT_BANDIT_EXPLORE_PROB", 0.1),
  promoteMinN: num("COPILOT_PROMOTE_MIN_N", 8),
  promoteMinWindows: num("COPILOT_PROMOTE_MIN_WINDOWS", 2),
  rewardCapUnverified: num("COPILOT_REWARD_CAP_UNVERIFIED", 0.5),

  // Phase 7/17 — web research. The agent searches the web on demand as part of its decision loop;
  // the only retained bound is a per-day fetch cap, and 0 means UNLIMITED (default). The dual-LLM
  // quarantine (web/index.ts) is NOT a tunable — it is the injection defense and always on.
  webMaxFetchPerDay: num("COPILOT_WEB_MAX_FETCH_PER_DAY", 0), // 0 = unlimited
  webDecayScore: num("COPILOT_WEB_DECAY_SCORE", 0.4),
  disableWeb: bool("COPILOT_DISABLE_WEB", false),

  // Phase 19 — market awareness: Bybit public market data (full-universe screener) + news feeds.
  // Bybit-native (the platform's venue); public endpoints, no auth.
  bybitBaseUrl: process.env.BYBIT_BASE_URL ?? "https://api.bybit.com",
  // Comma-separated trusted crypto-news RSS feeds (free/open, no key). Defaults to primary outlets.
  newsFeeds: (process.env.COPILOT_NEWS_FEEDS ?? [
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://cointelegraph.com/rss",
    "https://cryptoslate.com/feed/",
    "https://bitcoinmagazine.com/feed",
    "https://decrypt.co/feed",
  ].join(",")).split(",").map((s) => s.trim()).filter(Boolean),
  newsMaxItems: num("COPILOT_NEWS_MAX_ITEMS", 8),

  // Phase 29 — multi-factor token analysis engine. The shortlist bounds how many candidates get a
  // (per-symbol) kline fetch; finalists bounds how many get an LLM news-sentiment score (caps credit
  // cost + latency). klineLookback = daily bars pulled for the indicator math.
  analysisCandidatePool: num("COPILOT_ANALYSIS_CANDIDATE_POOL", 24),
  analysisFinalists: num("COPILOT_ANALYSIS_FINALISTS", 8),
  analysisKlineLookback: num("COPILOT_ANALYSIS_KLINE_LOOKBACK", 90),
  // Phase 32 — regime cross-validation. Detect bull/bear seasons from BTC's full history; backtest the
  // basket over the most-recent N substantial seasons (each ≥ minDays). Bounds the # of backtests run.
  analysisMaxSeasons: num("COPILOT_ANALYSIS_MAX_SEASONS", 14),
  analysisSeasonMinDays: num("COPILOT_ANALYSIS_SEASON_MIN_DAYS", 30),

  // Phase 17 — "living trader": position monitor + risk-state circuit breakers.
  // The monitor evaluates open positions on every rt:session:* tick and on a periodic safety sweep.
  positionSweepIntervalMs: num("COPILOT_POSITION_SWEEP_INTERVAL_MS", 60000),
  reflectionIntervalMs: num("COPILOT_REFLECTION_INTERVAL_MS", 6 * 3600 * 1000), // 0 disables the timer
  // Circuit-breaker thresholds (fractions). Halt is the hard stop; risk_averse blocks only new entries.
  riskHaltDrawdownPct: num("COPILOT_RISK_HALT_DRAWDOWN_PCT", 0.25),
  riskHaltConsecutiveLosses: num("COPILOT_RISK_HALT_CONSECUTIVE_LOSSES", 5),
  riskAverseCvarPct: num("COPILOT_RISK_AVERSE_CVAR_PCT", 0.1),
  riskAverseConsecutiveLosses: num("COPILOT_RISK_AVERSE_CONSECUTIVE_LOSSES", 3),
  riskCooldownSeconds: num("COPILOT_RISK_COOLDOWN_SECONDS", 3600),

  // On-chain data brain — Dune Analytics (read-only, allowlisted query pack). Absence ⇒ the dune_query
  // tool returns an honest "not configured" panel rather than failing. Execution is credit-metered, so
  // results are cached in-process for duneCacheTtlSeconds and the cheaper "latest results" endpoint is
  // tried before paying for a fresh execution.
  duneApiKey: process.env.DUNE_API_KEY,
  duneCacheTtlSeconds: num("DUNE_CACHE_TTL_SECONDS", 900),
  duneExecTimeoutSeconds: num("DUNE_EXEC_TIMEOUT_SECONDS", 55),
  dunePollIntervalMs: num("DUNE_POLL_INTERVAL_MS", 1500),
  duneMaxRows: num("DUNE_MAX_ROWS", 200),

  // L5 — optional Arbitrum RPC for reading GM/GLV (GMX) wallet balances. Absent ⇒ wallet review covers
  // Uniswap v3 (subgraph) only and says so. Read-only (eth_call balanceOf); never an execution path.
  arbitrumRpcUrl: process.env.ARBITRUM_RPC_URL ?? null,

  // GMX v2 (Arbitrum) read-only market data. Public REST, no key, never an execution path.
  gmxApiBase: process.env.GMX_API_BASE ?? "https://arbitrum-api.gmxinfra.io",
  gmxApiV1Base: process.env.GMX_API_V1_BASE ?? "https://arbitrum.gmxapi.io/v1",
  gmxChainId: num("GMX_CHAIN_ID", 42161),
  gmxTimeoutMs: num("GMX_TIMEOUT_MS", 12000),
  gmxCacheTtlMs: num("GMX_CACHE_TTL_MS", 60000),

  // Arbitrum coin universe — the allowlist that scopes crypto coin-listing surfaces (movers/laggards,
  // breadth, screener) to coins actually tradeable on Arbitrum. Built live from GMX's listed tokens
  // (100% coverage, nothing hardcoded). Other-DEX breadth is deferred until those lanes are integrated.
  arbUniverseTtlMs: num("ARB_UNIVERSE_TTL_MS", 600_000),

  // A0 — Market Briefing provider. Injects a cross-sleeve live snapshot into the system prompt at turn
  // start so the agent is market-aware from the first token. Cached in-process; staleness-safe.
  marketBriefingEnabled: bool("MARKET_BRIEFING_ENABLED", true),
  marketBriefingTtlMs: num("MARKET_BRIEFING_TTL_MS", 90_000),

  // A1 — sentiment fabric. Fear-greed (alternative.me) + funding/OI (Bybit) are free/keyless; social
  // (LunarCrush) + on-chain flow (Santiment) light up when these keys are present, else honest "unavailable".
  lunarcrushApiKey: process.env.LUNARCRUSH_API_KEY,
  santimentApiKey: process.env.SANTIMENT_API_KEY,

  // Uniswap v3/v4 pool data via The Graph subgraph. Endpoint + optional gateway key (THEGRAPH_API_KEY).
  uniswapSubgraphUrl: process.env.UNISWAP_SUBGRAPH_URL ?? "",
  theGraphApiKey: process.env.THEGRAPH_API_KEY,
  uniswapTimeoutMs: num("UNISWAP_TIMEOUT_MS", 12000),
  uniswapCacheTtlMs: num("UNISWAP_CACHE_TTL_MS", 120000),

  // Provider keys (managed mode). Optional — absence makes that provider unavailable, not fatal.
  openaiApiKey: process.env.OPENAI_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  litellmProxyUrl: process.env.LITELLM_PROXY_URL,

  // Venice AI (OpenAI-compatible) — the primary agent brain. Base URL already includes /api/v1, so
  // the adapter must NOT append another /v1. veniceModel is the tool-capable actor; it MUST have a
  // price-book row (see migration 0032) and report capabilities.supportsFunctionCalling=true at
  // GET {veniceBaseUrl}/models. Override VENICE_MODEL only to another function-calling model that is
  // also seeded in the price book.
  // Actor LLM provider for the agent. EASY SWAP: set COPILOT_DEFAULT_PROVIDER=openai (default, reliable
  // tool-calling via gpt-5-mini) or =venice (mistral-small etc; weaker tool-calling). Whichever is
  // chosen must be configured (key present) + priced, else the catalog falls back to OpenAI.
  defaultProvider: (process.env.COPILOT_DEFAULT_PROVIDER ?? "openai").toLowerCase(),
  veniceApiKey: process.env.VENICE_API_KEY,
  veniceBaseUrl: process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1",
  // Lightweight gpt-5-mini-equivalent: Venice-native 24B, reliable function calling, cheap/fast.
  // (Confirmed available + supportsFunctionCalling via GET /models on 2026-06-15.)
  veniceModel: process.env.VENICE_MODEL ?? "mistral-small-3-2-24b-instruct",

  // BYOK (Phase 12) — OFF until KMS exists (correction #2).
  byokEnabled: bool("COPILOT_BYOK_ENABLED", false),
  keyFingerprintSecret: process.env.COPILOT_KEY_FINGERPRINT_SECRET,
  kmsKeyId: process.env.COPILOT_KMS_KEY_ID, // presence ⇒ KMS configured

  // Admin allowlist for the grant endpoint (comma-separated owner ids).
  adminOwnerIds: (process.env.COPILOT_ADMIN_OWNER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
} as const;

// Correction #2: production must never run BYOK on dev-only encryption. Fail at startup.
export function assertStartupSafety(): void {
  if (config.byokEnabled && config.isProd && !config.kmsKeyId) {
    throw new Error(
      "COPILOT_BYOK_ENABLED=true in production without COPILOT_KMS_KEY_ID — refusing to start. " +
        "BYOK requires production-grade key encryption (KMS/Vault).",
    );
  }
  if (config.byokEnabled && !config.keyFingerprintSecret) {
    throw new Error("COPILOT_BYOK_ENABLED=true requires COPILOT_KEY_FINGERPRINT_SECRET.");
  }
}

export const WELCOME_CREDIT_MICRO_USD = Math.round(config.welcomeCreditUsd * 1_000_000);
export const USD_TO_MICRO = 1_000_000;
