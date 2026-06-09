import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { suggestBand } from "../uniswap/clmm.js";

// L5 — WALLET-AWARE LP positions. Reads a wallet's LIVE Uniswap v3 positions from the subgraph and runs
// the exact v3 math on them: current token amounts along the curve, value vs simply HODLing the net
// deposit (realized impermanent loss), collected fees, in/out-of-range status, net P&L, and a re-center
// suggestion when out of range. Read-only + honest — it analyzes and SUGGESTS, never builds/signs/sends
// a transaction (the Copilot's no-execution contract holds). GM/GLV balances need an RPC and are a
// best-effort extension (noted) when ARBITRUM_RPC_URL is set.

const STABLES = new Set(["USDC", "USDT", "DAI", "USDC.E", "FRAX", "LUSD", "TUSD", "USDB", "USDE"]);
const nz = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export interface LpPositionAnalysis {
  positionId: string;
  pair: string;
  feeTierPct: number;
  inRange: boolean;
  rangePriceLower: number;       // human price (token1 per token0) bounds
  rangePriceUpper: number;
  currentPrice: number;
  currentValueUsd: number;       // mark of the LP position now
  hodlValueUsd: number;          // net deposit, valued at current prices (the IL baseline)
  collectedFeesUsd: number | null; // fees already collected; null when the subgraph field is unreliable
  feesReliable: boolean;
  ilUsd: number;                 // currentValue − hodlValue (≤0 ⇒ IL drag)
  ilPct: number;                 // IL as % of HODL value (the reliable headline)
  netVsHodlUsd: number;          // currentValue (+ fees when reliable) − hodlValue
  netVsHodlPct: number;
  bandHalfWidthPct: number;      // the position's ± band half-width
  suggestion: string;
  valued: boolean;               // false when the pair can't be USD-anchored (math still shown, USD n/a)
}

export interface WalletLpResult {
  wallet: string;
  positions: LpPositionAnalysis[];
  totals: { currentValueUsd: number; collectedFeesUsd: number; netVsHodlUsd: number } | null;
  as_of: string;
  warnings: string[];
}

function endpoint(): string | null {
  if (!config.uniswapSubgraphUrl) return null;
  return config.theGraphApiKey ? config.uniswapSubgraphUrl.replace("{key}", config.theGraphApiKey) : config.uniswapSubgraphUrl;
}

// v3 token amounts (RAW base units) held by liquidity L at sqrt-price s within [sa, sb]. Mirrors the
// canonical closed forms (consistent with clmm.amountsForLiquidity) but in raw sqrt-price space.
function rawAmounts(L: number, s: number, sa: number, sb: number): { amt0: number; amt1: number } {
  if (s <= sa) return { amt0: L * (1 / sa - 1 / sb), amt1: 0 };          // below range → all token0
  if (s >= sb) return { amt0: 0, amt1: L * (sb - sa) };                  // above range → all token1
  return { amt0: L * (1 / s - 1 / sb), amt1: L * (s - sa) };             // in range → mixed
}

function analyzeRow(p: Record<string, unknown>): LpPositionAnalysis | null {
  const pool = (p.pool ?? {}) as Record<string, unknown>;
  const t0 = (p.token0 ?? {}) as Record<string, unknown>;
  const t1 = (p.token1 ?? {}) as Record<string, unknown>;
  const sym0 = String(t0.symbol ?? "?"), sym1 = String(t1.symbol ?? "?");
  const dec0 = nz(t0.decimals), dec1 = nz(t1.decimals);
  const L = nz(p.liquidity);
  if (L <= 0) return null;
  const tickLower = nz((p.tickLower as Record<string, unknown>)?.tickIdx);
  const tickUpper = nz((p.tickUpper as Record<string, unknown>)?.tickIdx);
  const curTick = nz(pool.tick);
  const sqrtPriceX96 = nz(pool.sqrtPrice);
  if (sqrtPriceX96 <= 0) return null;

  // Raw sqrt-prices. Tick→price is 1.0001^tick (token1/token0 in BASE units); sqrt = 1.0001^(tick/2).
  const s = sqrtPriceX96 / 2 ** 96;
  const sa = Math.pow(1.0001, tickLower / 2);
  const sb = Math.pow(1.0001, tickUpper / 2);
  const { amt0, amt1 } = rawAmounts(L, s, sa, sb);
  const amt0h = amt0 / 10 ** dec0, amt1h = amt1 / 10 ** dec1;

  // Human price (token1 per token0) for display, and tick→human-price bounds.
  const decAdj = 10 ** (dec0 - dec1);
  const curPriceHuman = s * s * decAdj;
  const pLowerHuman = sa * sa * decAdj;
  const pUpperHuman = sb * sb * decAdj;

  // USD anchor via the stable leg (same convention as poolDepth.ts on this subgraph: token0Price is the
  // non-stable token's USD price when token0 is the stable; token1Price when token1 is the stable).
  const token0Price = nz(pool.token0Price), token1Price = nz(pool.token1Price);
  let usd0: number | null = null, usd1: number | null = null;
  if (STABLES.has(sym0.toUpperCase())) { usd0 = 1; usd1 = token0Price; }
  else if (STABLES.has(sym1.toUpperCase())) { usd1 = 1; usd0 = token1Price; }
  const valued = usd0 != null && usd1 != null && usd0 > 0 && usd1 > 0;

  // Net deposit (gross deposited − withdrawn) is the HODL baseline.
  const netDep0 = nz(p.depositedToken0) - nz(p.withdrawnToken0);
  const netDep1 = nz(p.depositedToken1) - nz(p.withdrawnToken1);
  const fees0 = nz(p.collectedFeesToken0), fees1 = nz(p.collectedFeesToken1);

  const u0 = usd0 ?? 0, u1 = usd1 ?? 0;
  const currentValueUsd = amt0h * u0 + amt1h * u1;
  const hodlValueUsd = netDep0 * u0 + netDep1 * u1;
  // The subgraph's collectedFeesToken0/1 is a KNOWN-UNRELIABLE field (historically inflated). Only trust
  // it when it's plausible vs the position size; otherwise report fees as unavailable rather than fake
  // a number, and base net-vs-HODL on the EXACT impermanent-loss math (value vs HODL) alone.
  const rawFeesUsd = fees0 * u0 + fees1 * u1;
  const feesReliable = valued && rawFeesUsd >= 0 && rawFeesUsd <= Math.max(1, currentValueUsd) * 1.0;
  const collectedFeesUsd = feesReliable ? rawFeesUsd : null;
  const ilUsd = currentValueUsd - hodlValueUsd;
  const ilPct = hodlValueUsd > 0 ? (ilUsd / hodlValueUsd) * 100 : 0;
  const netVsHodlUsd = currentValueUsd + (collectedFeesUsd ?? 0) - hodlValueUsd;
  const netVsHodlPct = hodlValueUsd > 0 ? (netVsHodlUsd / hodlValueUsd) * 100 : 0;
  const inRange = curTick >= tickLower && curTick < tickUpper;

  // Band half-width (±%) from the tick bounds. Re-center suggestion is expressed as a band width around
  // spot (orientation-agnostic — avoids the token0/token1 price-inversion confusion).
  const bandHalfWidthPct = pUpperHuman > 0 && pLowerHuman > 0 ? (Math.sqrt(pUpperHuman / pLowerHuman) - 1) * 100 : 10;
  const feeNote = collectedFeesUsd != null ? `fees collected ~$${Math.round(collectedFeesUsd).toLocaleString()}; ` : "fees: subgraph field unreliable, omitted; ";
  const suggestion = inRange
    ? `In range — fees accruing. ${feeNote}position is ${ilUsd >= 0 ? "above" : "below"} HODL by ${Math.abs(ilPct).toFixed(1)}% on price (IL).`
    : `OUT OF RANGE — earning NO fees. Re-center to a ±${bandHalfWidthPct.toFixed(0)}% band around the current price to resume. IL vs HODL ${ilPct.toFixed(1)}%.`;

  return {
    positionId: String(p.id ?? ""), pair: `${sym0}/${sym1}`, feeTierPct: nz(pool.feeTier) / 10000,
    inRange, rangePriceLower: pLowerHuman, rangePriceUpper: pUpperHuman, currentPrice: curPriceHuman,
    currentValueUsd, hodlValueUsd, collectedFeesUsd, feesReliable, ilUsd, ilPct, netVsHodlUsd, netVsHodlPct,
    bandHalfWidthPct, suggestion, valued,
  };
}

export async function getWalletLpPositions(wallet: string): Promise<WalletLpResult> {
  const as_of = new Date().toISOString();
  const warnings: string[] = [];
  const w = wallet.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(w)) return { wallet, positions: [], totals: null, as_of, warnings: ["Not a valid 0x wallet address."] };
  const url = endpoint();
  if (!url) return { wallet: w, positions: [], totals: null, as_of, warnings: ["Uniswap subgraph not configured."] };

  const q = `query($owner:String!){
    positions(first:50, where:{owner:$owner, liquidity_gt:"0"}) {
      id liquidity depositedToken0 depositedToken1 withdrawnToken0 withdrawnToken1
      collectedFeesToken0 collectedFeesToken1
      tickLower{tickIdx} tickUpper{tickIdx}
      token0{symbol decimals} token1{symbol decimals}
      pool{ id feeTier sqrtPrice tick token0Price token1Price }
    }
  }`;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q, variables: { owner: w } }), signal: AbortSignal.timeout(config.uniswapTimeoutMs) });
    if (!res.ok) return { wallet: w, positions: [], totals: null, as_of, warnings: [`subgraph HTTP ${res.status}`] };
    const j = (await res.json()) as { data?: { positions?: Array<Record<string, unknown>> }; errors?: Array<{ message: string }> };
    if (j.errors?.length) return { wallet: w, positions: [], totals: null, as_of, warnings: j.errors.map((e) => e.message) };
    const rows = j.data?.positions ?? [];
    const positions = rows.map(analyzeRow).filter((x): x is LpPositionAnalysis => x != null);
    if (!positions.length) warnings.push(rows.length ? "Positions found but none with live liquidity." : "No open Uniswap v3 positions for this wallet.");
    if (positions.some((p) => !p.valued)) warnings.push("Some pairs aren't USD-anchored (no stable leg) — USD totals exclude them.");
    if (positions.some((p) => p.valued && !p.feesReliable)) warnings.push("Collected-fees from the subgraph were implausible for some positions (a known v3-subgraph bug) and omitted; net-vs-HODL shown is the exact impermanent-loss figure (ex-fees).");
    const valued = positions.filter((p) => p.valued);
    const totals = valued.length ? {
      currentValueUsd: valued.reduce((s, p) => s + p.currentValueUsd, 0),
      collectedFeesUsd: valued.reduce((s, p) => s + (p.collectedFeesUsd ?? 0), 0),
      netVsHodlUsd: valued.reduce((s, p) => s + p.netVsHodlUsd, 0),
    } : null;
    if (config.arbitrumRpcUrl == null) warnings.push("GM/GLV (GMX) balances need ARBITRUM_RPC_URL — Uniswap v3 positions shown.");
    return { wallet: w, positions, totals, as_of, warnings };
  } catch (e) {
    logger.warn("getWalletLpPositions failed", { message: (e as Error).message });
    return { wallet: w, positions: [], totals: null, as_of, warnings: [(e as Error).message] };
  }
}

// (kept for parity with the optimizer's band sizing; used if we later re-center on realized vol)
export { suggestBand };
