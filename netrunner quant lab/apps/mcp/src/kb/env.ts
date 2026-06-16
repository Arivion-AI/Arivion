// Every environment variable across the lab services (LAB_REFERENCE §3),
// so an agent can answer "which env controls X?" without the docs.

export interface EnvVar {
  name: string;
  default: string;
  meaning: string;
}

export const ENV_REFERENCE: Record<string, EnvVar[]> = {
  api: [
    { name: "DATABASE_URL", default: "postgres://postgres:5432/duality", meaning: "Postgres DSN." },
    { name: "REDIS_URL", default: "redis://redis:6379", meaning: "ioredis URL (also SSE pub/sub)." },
    { name: "QUANT_WORKER_URL", default: "http://worker:7000", meaning: "Worker base URL." },
    { name: "DUALITY_VERIFIER_URL", default: "http://verifier:7200", meaning: "Verifier base URL." },
    { name: "DATA_INGESTOR_URL / INGESTOR_URL", default: "http://data-ingestor:7100", meaning: "Ingestor base URL." },
    { name: "JWT_SECRET", default: "(required)", meaning: "HS256 signing/verify key." },
    { name: "JWT_AUDIENCE / JWT_ISSUER", default: "unset", meaning: "Optional JWT claims enforced if set." },
    { name: "ALLOW_DEV_TOKEN", default: "OFF", meaning: "Must be 'true' to enable /auth/dev-token (and non-default JWT_SECRET)." },
    { name: "INTERNAL_SECRET", default: "unset", meaning: "Shared secret sent to worker as x-internal-secret." },
    { name: "API_PORT", default: "4000", meaning: "Listen port (compose maps 4400)." },
  ],
  worker: [
    { name: "OMP_NUM_THREADS / OPENBLAS_NUM_THREADS / MKL_NUM_THREADS", default: "1", meaning: "Determinism — pin BLAS to one thread." },
    { name: "INTERNAL_SECRET", default: "unset", meaning: "If set, every request must carry matching x-internal-secret." },
    { name: "HEAVY_CONCURRENCY", default: "cpu_count (compose 4)", meaning: "Global cap on concurrent heavy jobs." },
    { name: "OWNER_CONCURRENCY", default: "3", meaning: "Per-owner token-bucket cap." },
    { name: "HEAVY_ACQUIRE_TIMEOUT", default: "30", meaning: "Seconds a heavy job waits for a slot before 429 SERVER_BUSY." },
    { name: "LIVE_PAPER_TICK_SECONDS", default: "30", meaning: "Live-paper advance loop cadence." },
    { name: "LIVE_PAPER_BARS", default: "400", meaning: "Bars fetched per live-paper tick (first build + tail)." },
    { name: "MARKET_IMPACT_COEF", default: "0 (OFF)", meaning: "Square-root market-impact coefficient." },
    { name: "MAKER_PARTICIPATION_RATE", default: "0 (OFF)", meaning: "Per-bar limit-fill cap = rate*bar_volume." },
    { name: "EXECUTION_FIDELITY", default: "bar_based", meaning: "Default fidelity; per-request param overrides." },
    { name: "ENABLE_PUBLIC_TRADES", default: "false", meaning: "Gate for l2_queue through-volume consumption." },
    { name: "L2_DEPTH", default: "50", meaning: "Recorded book depth tier (1|50|200|500|1000)." },
    { name: "EXECUTION_ALLOW_FALLBACK", default: "true", meaning: "Fall back a tier if L2/trade coverage missing." },
    { name: "L2_SNAPSHOT_COVERAGE_THRESHOLD / TRADE_COVERAGE_THRESHOLD", default: "0.98", meaning: "Min coverage for the verified badge." },
    { name: "ENABLE_LATENCY_MODEL", default: "false (OFF)", meaning: "Phase-5 deterministic latency model." },
    { name: "DEFAULT_*_LATENCY_MS / DEFAULT_JITTER_MS", default: "0", meaning: "Latency components; LATENCY_SEED=42 for jitter." },
    { name: "RECOVERY_MAX_GAP_BARS", default: "2", meaning: "Max consecutive missing forward bars before recovery blocks." },
    { name: "RECOVERY_MAX_BARS", default: "200000", meaning: "Hard cap on bars paged during recovery replay." },
  ],
  "data-ingestor": [
    { name: "BYBIT_BASE_URL", default: "https://api.bybit.com", meaning: "REST base." },
    { name: "BYBIT_WS_PUBLIC_LINEAR", default: "wss://stream.bybit.com/v5/public/linear", meaning: "Linear WS." },
    { name: "BYBIT_WS_PUBLIC_SPOT", default: "wss://stream.bybit.com/v5/public/spot", meaning: "Spot WS (xStocks)." },
    { name: "LIVE_POLL_SECONDS", default: "60", meaning: "REST live-poll cadence (gap-fill backstop)." },
    { name: "RT_WRITE_THROTTLE_S", default: "1.5", meaning: "Min seconds between forming-bar DB writes." },
    { name: "WS_PUBLIC_SYMBOLS", default: "''", meaning: "Legacy L2 collector seed — empty = idle." },
  ],
  verifier: [
    { name: "DATABASE_URL", default: "as api", meaning: "Reads canonical candles." },
    { name: "VERIFIER_SIGNING_KEY", default: "(required)", meaning: "Passport HMAC signing key." },
  ],
  "mcp (this server)": [
    { name: "DUALITY_API_URL", default: "http://localhost:4400", meaning: "API base." },
    { name: "DUALITY_AUTH_MODE", default: "configured", meaning: "configured | dev-token | passthrough." },
    { name: "DUALITY_API_TOKEN", default: "unset", meaning: "Internal owner JWT (configured mode)." },
    { name: "DUALITY_DEFAULT_OWNER_ID", default: "1", meaning: "Owner to mint for in dev-token mode." },
    { name: "INTERNAL_SECRET", default: "unset", meaning: "x-internal-secret mirrored on every call." },
    { name: "DUALITY_ENABLE_INTERNAL", default: "false", meaning: "Expose verifier/ingestor/sandbox tools." },
    { name: "DUALITY_TRANSPORT", default: "stdio", meaning: "stdio | http (or --stdio/--http flag)." },
    { name: "DUALITY_HTTP_PORT", default: "8080", meaning: "HTTP transport port." },
    { name: "DUALITY_HTTP_CORS_ORIGINS", default: "unset", meaning: "Comma-separated allowlist for HTTP mode." },
  ],
};
