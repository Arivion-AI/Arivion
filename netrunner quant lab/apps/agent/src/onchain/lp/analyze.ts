import { discoverPools } from "./discover.js";
import { analyzeIl } from "./il.js";
import { netYield, carryFromGmx } from "./yield.js";
import { concentratedIl } from "../uniswap/clmm.js";
import { getGmxMarketBySymbol } from "../gmx/client.js";
import { resolveLpPricePath } from "./pricePath.js";
import { realizedVol } from "../../analysis/indicators.js";
import type { LpCompareResult } from "./types.js";

// The LP analysis ORCHESTRATOR the chat tools call. Pulls a real recent price path (Bybit klines) for
// the asset, then runs discover → IL/range → yield/carry, returning a bundle of widget-ready payloads.
// Emits nothing itself (the tool layer owns SSE); this stays pure-ish + testable.

export type WidgetEmit = (w: { id: string; kind: string; title: string; state: "running" | "done" | "error"; rationale?: string; data?: unknown }) => void;

export interface LpAnalysis {
  symbol: string;
  compare: LpCompareResult;
  il: ReturnType<typeof analyzeIl> | null;
  netYield: ReturnType<typeof netYield> | null;
  carry: ReturnType<typeof carryFromGmx> | null;
  priceBars: number;
  priceSource: "uniswap_pool" | "bybit";   // honest provenance of the IL/time-in-range price path
}

export async function analyzeLp(opts: { symbol: string; horizonDays?: number; positionUsd?: number; emit?: WidgetEmit }): Promise<LpAnalysis> {
  const symbol = opts.symbol.replace(/USDT?$/i, "").toUpperCase();
  const emit = opts.emit;
  emit?.({ id: `lp-${symbol}`, kind: "lp_compare", title: `LP options · ${symbol}`, state: "running", rationale: "Comparing pools across Uniswap + GMX…" });

  // Daily price path for IL/time-in-range — prefer the POOL's own price (correct), fall back to CEX.
  const path = await resolveLpPricePath(symbol, 120).catch(() => null);
  const closes = path?.closes ?? [];
  const priceSource = path?.source ?? "bybit";
  const volDaily = closes.length > 5 ? realizedVol(closes) : null;

  const compare = await discoverPools({ symbol, volPerDay: volDaily });
  emit?.({ id: `lp-${symbol}`, kind: "lp_compare", title: `LP options · ${symbol}`, state: compare.candidates.length ? "done" : "error",
    rationale: compare.pick ? `Pick: ${compare.pick.label} (${(compare.pick.score * 100).toFixed(0)}/100)` : compare.warnings.join(" "),
    data: compare });

  // IL/range + net-yield + carry only when we have a price path and a leading candidate.
  let il: LpAnalysis["il"] = null, ny: LpAnalysis["netYield"] = null, carry: LpAnalysis["carry"] = null;
  if (closes.length > 10) {
    il = analyzeIl(closes, { horizonDays: opts.horizonDays ?? 30, targetTimeInRange: 0.8 });
    emit?.({ id: `il-${symbol}`, kind: "il_curve", title: `IL & range · ${symbol}`, state: "done", rationale: il.rationale, data: il });

    const gm = await getGmxMarketBySymbol(symbol).catch(() => null);
    carry = carryFromGmx(gm);
    const grossApr = compare.pick?.feeAprPct ?? 0;
    const edgeIl = concentratedIl(1, il.band.upperPct > 0 ? 1 + il.band.upperPct / 100 : 1.07, 1 + il.band.lowerPct / 100, 1 + il.band.upperPct / 100);
    const tir = il.timeInRangePct / 100;
    ny = netYield({ grossFeeAprPct: grossApr, typicalIl: edgeIl, timeInRange: tir, rebalancesPerYear: Math.max(1, (1 - tir) * 52), gasPerRebalanceUsd: 0.5, positionUsd: opts.positionUsd ?? 5000 });
    emit?.({ id: `carry-${symbol}`, kind: "funding_carry", title: `Yield & carry · ${symbol}`, state: "done", rationale: carry.hedgeNote,
      data: { netYield: ny, carry, gross_fee_apr_pct: grossApr } });
  }

  return { symbol, compare, il, netYield: ny, carry, priceBars: closes.length, priceSource };
}
