import { config } from "../../config.js";
import { logger } from "../../logger.js";

// L1 — REAL Uniswap v3 depth from on-chain pool state (replaces the √-impact heuristic in lp/depth.ts).
// Uses the pool's current active liquidity L + sqrtPrice + token decimals to compute the v3 VIRTUAL
// RESERVES at spot, then prices a trade against them. First-order price impact for a swap that stays in
// the current tick range is Δy/y_virtual — exact for the active range, conservative across ticks. Also
// exposes the active-range reserve value in USD, which the backtest uses to cap fee-share dilution for
// large positions. Pure math once the state is fetched; honest "unavailable" when the subgraph is dark.

export interface PoolDepth {
  poolId: string;
  token0: string; token1: string;
  priceToken1PerToken0: number;   // human price (token1 per token0)
  reserve0Usd: number;            // virtual reserve of token0 at spot, in USD (base-side depth)
  reserve1Usd: number;            // virtual reserve of token1 at spot, in USD (quote-side depth)
  activeLiquidityUsd: number;     // reserve0Usd + reserve1Usd — value of liquidity active at the tick
  // Raw v3 state — exposed for the L1b true fee-share model (concentratedFeeMultiplier).
  liquidityRaw: number;           // pool's active liquidity L (raw v3 units)
  sqrtPriceRaw: number;           // sqrtPriceX96 / 2^96 (raw base-unit sqrt price)
  dec0: number; dec1: number;
  usd0: number; usd1: number;     // USD price per whole token (stable-anchored)
  source: "uniswap";
  as_of: string;
}

const STABLES = new Set(["USDC", "USDT", "DAI", "USDC.E", "FRAX", "LUSD", "TUSD", "USDB", "USDE"]);

function endpoint(): string | null {
  if (!config.uniswapSubgraphUrl) return null;
  return config.theGraphApiKey ? config.uniswapSubgraphUrl.replace("{key}", config.theGraphApiKey) : config.uniswapSubgraphUrl;
}

const nz = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Fetch pool state + compute virtual-reserve depth. Returns null on a dark subgraph or unpriceable pair.
export async function getPoolDepth(poolId: string): Promise<PoolDepth | null> {
  const url = endpoint();
  if (!url) return null;
  const q = `query($id:ID!){ pool(id:$id){ id liquidity sqrtPrice token0Price token1Price
      token0{symbol decimals} token1{symbol decimals} } }`;
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, variables: { id: poolId.toLowerCase() } }),
      signal: AbortSignal.timeout(config.uniswapTimeoutMs),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { pool?: Record<string, unknown> }; errors?: unknown[] };
    const p = j.data?.pool;
    if (!p || j.errors) return null;

    const t0 = (p.token0 ?? {}) as Record<string, unknown>;
    const t1 = (p.token1 ?? {}) as Record<string, unknown>;
    const sym0 = String(t0.symbol ?? "?"), sym1 = String(t1.symbol ?? "?");
    const dec0 = nz(t0.decimals), dec1 = nz(t1.decimals);
    const L = nz(p.liquidity);                       // raw active liquidity (uint, decimal-scaled)
    const sqrtPriceX96 = nz(p.sqrtPrice);
    const token0Price = nz(p.token0Price);           // human: token1 per token0
    const token1Price = nz(p.token1Price);           // human: token0 per token1
    if (L <= 0 || sqrtPriceX96 <= 0) return null;

    // sqrtP (raw, base units): sqrtPriceX96 / 2^96. Virtual reserves: x = L/sqrtP, y = L*sqrtP (base units).
    const sqrtP = sqrtPriceX96 / 2 ** 96;
    const x_raw = L / sqrtP;            // token0 base units
    const y_raw = L * sqrtP;            // token1 base units
    const x_h = x_raw / 10 ** dec0;     // human token0
    const y_h = y_raw / 10 ** dec1;     // human token1

    // Price each token in USD, anchoring on the stable leg. Convention (verified empirically on this
    // subgraph): token0Price = price of token1 in token0 units (e.g. USDC/WETH → token0Price ≈ 1656 =
    // WETH's USD price), and token1Price is its inverse. So when token0 is the stable, the volatile
    // token1's USD price = token0Price; when token1 is the stable, token0's USD price = token1Price.
    // Neither stable ⇒ can't anchor to USD reliably → null, caller uses the heuristic.
    let usd0: number, usd1: number;
    if (STABLES.has(sym0.toUpperCase())) { usd0 = 1; usd1 = token0Price; }
    else if (STABLES.has(sym1.toUpperCase())) { usd1 = 1; usd0 = token1Price; }
    else return null;
    if (!(usd0 > 0) || !(usd1 > 0)) return null;

    const reserve0Usd = x_h * usd0;
    const reserve1Usd = y_h * usd1;
    return {
      poolId, token0: sym0, token1: sym1,
      priceToken1PerToken0: token0Price,
      reserve0Usd, reserve1Usd, activeLiquidityUsd: reserve0Usd + reserve1Usd,
      liquidityRaw: L, sqrtPriceRaw: sqrtP, dec0, dec1, usd0, usd1,
      source: "uniswap", as_of: new Date().toISOString(),
    };
  } catch (e) {
    logger.warn("getPoolDepth failed", { poolId, message: (e as Error).message });
    return null;
  }
}

// L1b — TRUE tick-level liquidity-share fee model. Replaces the bounded `min(eff, 8)` estimate with the
// rigorous v3 result: a position of `positionUsd` deposited into a band earns the pool's fees in
// proportion to its share of the ACTIVE liquidity at the current tick — share = Lmine/(poolL + Lmine).
// We compute Lmine in the SAME raw-L units as the pool's `liquidity` by inverting the v3 deposit math
// (value of one unit of L at spot, in USD), so the share is unit-correct (no arbitrary cap). The
// returned multiplier is the concentrated fee APR ÷ the pool's blended fee APR.
export interface ConcentratedFee {
  feeMultiplier: number;   // trueFeeApr / grossPoolFeeApr (effective concentration vs blended pool)
  feeAprPct: number;       // the position's true fee APR at this band/size
  share: number;           // Lmine/(poolL+Lmine)
  myLiquidity: number; poolLiquidity: number;
}

// bandLower/bandUpper are multiplicative bounds around spot (e.g. 0.95 / 1.05 for a ±5% band).
export function concentratedFeeMultiplier(
  depth: PoolDepth, positionUsd: number, bandLower: number, bandUpper: number, grossFeeAprPct: number, tvlUsd: number,
): ConcentratedFee | null {
  if (!(positionUsd > 0) || !(depth.liquidityRaw > 0) || !(grossFeeAprPct > 0) || !(tvlUsd > 0)) return null;
  const sP = depth.sqrtPriceRaw;
  const sa = sP * Math.sqrt(Math.max(1e-12, bandLower));
  const sb = sP * Math.sqrt(Math.max(bandLower, bandUpper));
  if (!(sb > sa)) return null;
  // Token amounts (raw base units) for one unit of liquidity at spot within [sa, sb].
  const amt0 = (sb - sP) / (sP * sb);   // token0
  const amt1 = (sP - sa);               // token1
  const valuePerUnitL = (amt0 / 10 ** depth.dec0) * depth.usd0 + (amt1 / 10 ** depth.dec1) * depth.usd1;
  if (!(valuePerUnitL > 0)) return null;
  const myLiquidity = positionUsd / valuePerUnitL;
  const share = myLiquidity / (depth.liquidityRaw + myLiquidity);
  const myFeesAnnualUsd = (grossFeeAprPct / 100) * tvlUsd * share;
  const feeAprPct = (myFeesAnnualUsd / positionUsd) * 100;
  return { feeMultiplier: feeAprPct / grossFeeAprPct, feeAprPct, share, myLiquidity, poolLiquidity: depth.liquidityRaw };
}

export interface DepthQuote { tradeUsd: number; priceImpactBps: number; depthUsd: number; note: string }

// First-order price impact of a `tradeUsd` swap against the active virtual reserves. Selling into the
// quote side moves price by ≈ Δquote / quoteReserve; we use the side being consumed. Conservative for
// trades that would cross ticks (real depth refills past the active range), honest for sizing.
export function quoteImpactFromDepth(depth: PoolDepth, tradeUsd: number, side: "buy_base" | "sell_base" = "buy_base"): DepthQuote {
  // buy_base (buy token0 with token1) consumes token0 reserve; sell_base consumes token1 reserve.
  const reserve = side === "buy_base" ? depth.reserve0Usd : depth.reserve1Usd;
  if (reserve <= 0) return { tradeUsd, priceImpactBps: 9999, depthUsd: 0, note: "No active liquidity — avoid." };
  const impact = tradeUsd / reserve;                    // marginal impact (xy=k local behavior)
  const bps = Math.round(Math.min(1, impact) * 10000);
  return {
    tradeUsd, depthUsd: reserve, priceImpactBps: bps,
    note: bps < 10 ? "Negligible impact." : bps < 50 ? "Modest impact." : bps < 200 ? "Material — split the order." : "High impact — pool too shallow for this size.",
  };
}
