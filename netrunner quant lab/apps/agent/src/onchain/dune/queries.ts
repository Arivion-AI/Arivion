// [BUILD STATUS] Implemented G0 slice: Dune adapter (client.ts) + allowlisted query pack (this file) +
// the `dune_query` chat tool (chat/tools.ts) + the `dune_panel` board widget (frontend NexaBoard.tsx).
// To go live: set DUNE_API_KEY and the DUNE_QUERY_* id(s) for the queries you want callable.
//
// Curated Dune "query pack" — the ONLY queries the agent may execute (allowlist). Each entry maps a
// stable name the agent reasons with to a concrete Dune query id. Real query ids are deployment-
// specific (they live in a Dune workspace), so the id is resolved from env at load time:
//   DUNE_QUERY_<UPPER_SNAKE_NAME>=<id>
// A name with no configured id is simply "not available" (the tool says so honestly) rather than a
// crash. This keeps arbitrary-SQL execution OFF by default — the agent can only run vetted, named
// analytics, which is both a cost guard (credits) and a safety guard.

export interface DuneQueryDef {
  name: string;
  description: string;
  /** Parameter names the query accepts (Dune query parameters), for the tool schema + validation. */
  params: string[];
  /** Default Dune query id if the env override is absent (0 ⇒ unresolved/unavailable). */
  defaultId: number;
}

// The pack. Mirrors §6 of DUALITY_ONCHAIN_GMX_UNISWAP_DUNE_IMPLEMENTATION.md. defaultId is 0 because
// query ids are per-workspace; set the real ids via env (DUNE_QUERY_UNI_POOL_OVERVIEW=12345, …).
export const DUNE_QUERY_PACK: DuneQueryDef[] = [
  { name: "uni_pool_overview", description: "Uniswap pool: TVL, fee tier, 24h/7d/30d volume, fees, fee APR for a pool/chain.", params: ["pool", "chain"], defaultId: 0 },
  { name: "uni_pool_history", description: "Uniswap pool daily fees/volume/TVL/tick series (for IL & LP backtests).", params: ["pool", "chain", "days"], defaultId: 0 },
  { name: "uni_token_pools", description: "All Uniswap pools + fee tiers for a token, ranked by TVL/volume.", params: ["token", "chain"], defaultId: 0 },
  // Live in the duality Dune workspace (public query, gmx_v2 spellbook position-flow aggregation):
  // 7d/24h perp volume, trade & trader counts, long/short split for the {market} index on {chain}.
  // Env DUNE_QUERY_GMX_MARKET_STATS overrides; this default keeps the panel Dune-backed out of the box.
  { name: "gmx_market_stats", description: "GMX v2 perp activity for a market: 7d/24h volume, trades, traders, long/short split.", params: ["market", "chain"], defaultId: 7720864 },
  { name: "gmx_glv_breakdown", description: "GMX GLV vault allocation across GM pools, utilization, net APY.", params: ["vault", "chain"], defaultId: 0 },
  { name: "gmx_funding_history", description: "GMX funding/borrow rate history per market.", params: ["market", "chain", "days"], defaultId: 0 },
  { name: "token_holder_flow", description: "Token holder concentration, net exchange flow, smart-money flow.", params: ["token", "chain"], defaultId: 0 },
  { name: "arb_gas_stats", description: "Recent Arbitrum gas stats (for rebalance/gas cost modeling).", params: ["days"], defaultId: 0 },
];

const byName = new Map(DUNE_QUERY_PACK.map((q) => [q.name, q]));

function envIdFor(name: string): number {
  const raw = process.env[`DUNE_QUERY_${name.toUpperCase()}`];
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export interface ResolvedQuery extends DuneQueryDef {
  /** Concrete Dune query id (env override > defaultId). 0 ⇒ unavailable. */
  queryId: number;
}

/** Resolve a named query to its concrete Dune id (env override wins). Returns null if not allowlisted. */
export function resolveQuery(name: string): ResolvedQuery | null {
  const def = byName.get(name);
  if (!def) return null;
  const queryId = envIdFor(name) || def.defaultId;
  return { ...def, queryId };
}

/** The names the agent is allowed to run AND that have a resolvable id right now. */
export function availableQueries(): ResolvedQuery[] {
  return DUNE_QUERY_PACK.map((d) => resolveQuery(d.name)!).filter((q) => q.queryId > 0);
}

/** Every allowlisted name (regardless of whether an id is configured) — for the tool enum + messaging. */
export function allQueryNames(): string[] {
  return DUNE_QUERY_PACK.map((q) => q.name);
}
