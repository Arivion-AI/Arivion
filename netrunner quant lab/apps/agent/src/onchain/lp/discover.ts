import type { LpCandidate, LpCompareResult, LpVenue } from "./types.js";
import { getTokenPools } from "../uniswap/client.js";
import { getGmxApySnapshot, getGmxMarketBySymbol, getGlvVaults, getGmxMarkets } from "../gmx/client.js";

// Cross-venue LP DISCOVERY + RANKING — the analyzer behind the lp_compare widget ("the Copilot chooses
// which pool"). It enumerates every place you can LP an asset: each Uniswap fee tier AND the relevant
// GMX GM pool / GLV vault, normalizes them, scores each on a composite LP score (yield · depth ·
// turnover · IL-safety), and returns them ranked with the pick flagged + a per-candidate rationale.
// Read-only. No fabricated pools — a venue that returns nothing simply contributes nothing.

// realizedVol (per-day, std of log returns) lets us classify IL risk consistently across venues.
function ilRiskFromVol(volPerDay: number | null): "low" | "med" | "high" {
  if (volPerDay == null) return "med";
  const annual = volPerDay * Math.sqrt(365);
  if (annual < 0.5) return "low";
  if (annual < 1.0) return "med";
  return "high";
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Score the candidates relative to each other (so the ranking is about THIS asset's options, not an
// absolute scale). Yield is rewarded, depth/turnover rewarded, IL risk penalized — weighted toward a
// balanced LP that actually earns more than it bleeds to IL.
function scoreCandidates(cands: LpCandidate[]): void {
  const maxApr = Math.max(1e-6, ...cands.map((c) => c.feeAprPct));
  const maxTvl = Math.max(1e-6, ...cands.map((c) => c.tvlUsd));
  const maxTurn = Math.max(1e-6, ...cands.map((c) => c.volTvl ?? 0));
  for (const c of cands) {
    const yieldF = clamp01(c.feeAprPct / maxApr);
    const depthF = clamp01(Math.log10(1 + c.tvlUsd) / Math.log10(1 + maxTvl));
    const turnF = c.volTvl != null ? clamp01((c.volTvl) / maxTurn) : 0.5; // GMX has no turnover ⇒ neutral
    const ilSafety = c.ilRisk === "low" ? 1 : c.ilRisk === "med" ? 0.6 : 0.25;
    c.factors = { yield: yieldF, depth: depthF, turnover: turnF, ilSafety };
    c.score = clamp01(0.42 * yieldF + 0.2 * depthF + 0.18 * turnF + 0.2 * ilSafety);
  }
  cands.sort((a, b) => b.score - a.score);
}

export interface DiscoverInput { symbol: string; pair?: string; volPerDay?: number | null }

export async function discoverPools(input: DiscoverInput): Promise<LpCompareResult> {
  const symbol = input.symbol.replace(/USDT?$/i, "").toUpperCase();
  const warnings: string[] = [];
  const cands: LpCandidate[] = [];
  const ilRisk = ilRiskFromVol(input.volPerDay ?? null);

  // --- Uniswap: every fee tier for this token, ranked by TVL (the client pulls the latest day for a
  // realistic fee APR). Unconfigured subgraph ⇒ a warning, not a crash.
  const uni = await getTokenPools(symbol, 8).catch((e) => ({ status: "error" as const, reason: (e as Error).message, data: [] }));
  if (uni.status !== "ok") warnings.push(`Uniswap: ${uni.reason ?? "unavailable"}`);
  for (const p of uni.data ?? []) {
    cands.push({
      id: p.id, venue: "uniswap", label: `Uniswap v3 ${p.token0}/${p.token1} ${p.feeTier / 100}%`,
      pair: `${p.token0}/${p.token1}`, feeTierPct: p.feeTier / 100, tvlUsd: p.tvlUsd,
      volume24hUsd: p.volume24hUsd, feeAprPct: p.feeAprPct, yieldSource: "uniswap_fees", volTvl: p.volTvl, ilRisk,
      score: 0, factors: { yield: 0, depth: 0, turnover: 0, ilSafety: 0 },
      rationale: `${p.feeTier / 100}% tier · TVL $${fmtUsd(p.tvlUsd)} · vol/TVL ${p.volTvl.toFixed(2)}x · ~${p.feeAprPct.toFixed(1)}% fee APR`,
    });
  }

  // --- GMX GM pool for this index (LP = back the market, earn trader-loss + fee share). We don't have
  // a clean GM-LP APR from REST, so we surface the pool's depth and mark APR as unknown-but-modeled (0
  // contribution to the yield factor rather than a fake number) — the backtester (G2) fills real yield.
  const [gm, gmxApy] = await Promise.all([
    getGmxMarketBySymbol(symbol).catch(() => null),
    getGmxApySnapshot().catch(() => null),
  ]);
  if (gm) {
    const apy = gmxApy?.markets[gm.marketToken.toLowerCase()];
    const feeAprPct = apy?.apyPct ?? 0;
    cands.push({
      id: gm.marketToken, venue: "gmx_gm", label: `GMX GM ${gm.name}`, pair: `${gm.longSymbol}/${gm.shortSymbol}`,
      feeTierPct: null, tvlUsd: gm.availableLiquidityUsd, volume24hUsd: null, feeAprPct, yieldSource: apy ? "gmx_apy" : "unknown", volTvl: null,
      ilRisk: "low", score: 0, factors: { yield: 0, depth: 0, turnover: 0, ilSafety: 0 },
      rationale: `GM pool backing ${gm.indexSymbol} · liquidity $${fmtUsd(gm.availableLiquidityUsd)} · OI skew $${fmtUsd(gm.oiNetUsd)}${apy ? ` · GMX APY ${feeAprPct.toFixed(1)}%` : " · APY unavailable"}`,
    });
  }

  // --- GLV vaults exposed to this asset (utilization-optimized GM allocation). Matched by long token.
  const glvs = await getGlvVaults().catch(() => []);
  for (const g of glvs.filter((v) => v.longSymbol.toUpperCase().includes(symbol) || symbol.includes(v.longSymbol.toUpperCase()))) {
    const apy = gmxApy?.glvs[g.glvToken.toLowerCase()];
    const feeAprPct = apy?.apyPct ?? 0;
    cands.push({
      id: g.glvToken, venue: "gmx_glv", label: g.name, pair: `${g.longSymbol}/${g.shortSymbol}`,
      feeTierPct: null, tvlUsd: g.totalUsd, volume24hUsd: null, feeAprPct, yieldSource: apy ? "gmx_apy" : "unknown", volTvl: null,
      ilRisk: "low", score: 0, factors: { yield: 0, depth: 0, turnover: 0, ilSafety: 0 },
      rationale: `GLV vault · $${fmtUsd(g.totalUsd)} across ${g.markets.length} GM pools · auto-allocates to utilization${apy ? ` · GMX APY ${feeAprPct.toFixed(1)}%` : " · APY unavailable"}`,
    });
  }

  if (!cands.length) warnings.push(`No LP venues found for ${symbol} (check subgraph + GMX availability).`);
  scoreCandidates(cands);
  return { symbol, candidates: cands, pick: cands[0] ?? null, as_of: new Date().toISOString(), warnings };
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

export { getGmxMarkets };
