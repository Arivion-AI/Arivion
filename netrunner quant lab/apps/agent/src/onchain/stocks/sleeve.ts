import { maxDrawdown, sharpeLike } from "../../analysis/indicators.js";
import { config } from "../../config.js";

// Robinhood-chain tokenized-stock sleeve (HOLD-only, oracle-priced) for the portfolio reasoner.
// The old flow sourced the equity sleeve from Bybit xStocks (`xstocks_catalog`), which is EMPTY in
// this deployment — so stocks never appeared. The real, live equities are the Robinhood Chain testnet
// (46630) stock tokens we deployed (dTSLA/dAMZN/dPLTR/dNFLX/dAMD via the oracle mint/redeem vault).
// Equities are spot/1x/long-only (no perps, no LP), so this sleeve is HOLD-only. We price them from
// the same public source the on-chain oracle keeper uses (Yahoo Finance, no key) so the agent can
// reason about them honestly even though there is no Bybit history for the tokenized versions.

export interface StockLeg {
  symbol: string;       // underlying ticker, e.g. TSLA
  token: string;        // Robinhood-chain token, e.g. dTSLA
  priceUsd: number | null;
  priceSource: "chainlink_aggv3_standin" | "yahoo_fallback";
  priceStale: boolean;
  changePct: number | null;
  metrics: {
    total_return: number;
    sharpe: number;
    max_drawdown: number;
    bars: number;
  } | null;
  equity_curve: number[];
  venue: "robinhood_testnet";
  chainId: 46630;
}

// The deployed Robinhood testnet stock set (DualityStockVault). Stable, testnet-only.
export const ROBINHOOD_STOCKS = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"] as const;

// Live price from the on-chain stock oracle, read through the unified Chainlink Data Feed endpoint
// (Chainlink AggregatorV3-compatible stand-in on Robinhood Chain). This is the price the internal stock
// market actually trades at on-chain. Returns null on any failure so the caller can fall back to Yahoo.
async function chainlinkStockQuote(symbol: string): Promise<{ price: number; stale: boolean } | null> {
  try {
    const r = await fetch(`${config.apiBaseUrl}/api/chainlink/${encodeURIComponent(symbol)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { priceUsd?: number; stale?: boolean; source?: string };
    if (typeof j.priceUsd !== "number" || !(j.priceUsd > 0)) return null;
    return { price: j.priceUsd, stale: Boolean(j.stale) };
  } catch {
    return null;
  }
}

async function yahooQuote(symbol: string): Promise<{ price: number | null; changePct: number | null }> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`, {
      headers: { "User-Agent": "Mozilla/5.0 duality-copilot" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { price: null, changePct: null };
    const j = (await r.json()) as any;
    const meta = j?.chart?.result?.[0]?.meta;
    const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
    const prev = typeof meta?.chartPreviousClose === "number" ? meta.chartPreviousClose : (typeof meta?.previousClose === "number" ? meta.previousClose : null);
    const changePct = price != null && prev ? ((price - prev) / prev) * 100 : null;
    return { price, changePct };
  } catch {
    return { price: null, changePct: null };
  }
}

async function yahooHistory(symbol: string): Promise<number[]> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`, {
      headers: { "User-Agent": "Mozilla/5.0 duality-copilot" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const j = (await r.json()) as any;
    const quote = j?.chart?.result?.[0]?.indicators?.quote?.[0];
    return (Array.isArray(quote?.close) ? quote.close : [])
      .map((x: unknown) => Number(x))
      .filter((x: number) => Number.isFinite(x) && x > 0);
  } catch {
    return [];
  }
}

function sampleCurve(raw: number[], n = 48): number[] {
  if (raw.length <= n) return raw;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(raw[Math.round((i / (n - 1)) * (raw.length - 1))]);
  return out;
}

function stockHoldBacktest(closes: number[]): StockLeg["metrics"] & { equity_curve: number[] } | null {
  if (closes.length < 3 || closes[0] <= 0) return null;
  const equity = closes.map((c) => c / closes[0]);
  const totalReturn = equity[equity.length - 1] - 1;
  const sh = sharpeLike(equity);
  const dd = maxDrawdown(equity);
  return {
    total_return: Number(totalReturn.toFixed(6)),
    sharpe: sh == null ? 0 : Number((sh * Math.sqrt(252)).toFixed(4)),
    max_drawdown: dd == null ? 0 : Number(Math.abs(dd).toFixed(6)),
    bars: closes.length,
    equity_curve: sampleCurve(equity),
  };
}

/** Live Robinhood-chain stock sleeve. `limit` caps how many tickers (objective-weighted upstream). */
export async function robinhoodStockSleeve(limit = 3): Promise<StockLeg[]> {
  const picks = ROBINHOOD_STOCKS.slice(0, Math.max(1, Math.min(limit, ROBINHOOD_STOCKS.length)));
  const legs = await Promise.all(picks.map(async (symbol): Promise<StockLeg> => {
    // Live price: on-chain Chainlink stand-in first (the real internal-market price), Yahoo as fallback.
    // History stays Yahoo — the on-chain oracle keeps no candle history for the hold backtest.
    const [cl, q, closes] = await Promise.all([chainlinkStockQuote(symbol), yahooQuote(symbol), yahooHistory(symbol)]);
    const bt = stockHoldBacktest(closes);
    const usedChainlink = cl != null;
    return {
      symbol,
      token: `d${symbol}`,
      priceUsd: usedChainlink ? cl.price : q.price,
      priceSource: usedChainlink ? "chainlink_aggv3_standin" : "yahoo_fallback",
      priceStale: usedChainlink ? cl.stale : false,
      changePct: q.changePct,
      metrics: bt ? {
        total_return: bt.total_return,
        sharpe: bt.sharpe,
        max_drawdown: bt.max_drawdown,
        bars: bt.bars,
      } : null,
      equity_curve: bt?.equity_curve ?? [],
      venue: "robinhood_testnet",
      chainId: 46630,
    };
  }));
  return legs;
}
