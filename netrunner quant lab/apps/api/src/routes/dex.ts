import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../lib/db.js";
import { dexDataEnabled, findChain, publicChain } from "../config/chains.js";

type IngestorFetch = (path: string, init?: RequestInit) => Promise<Response>;

function enabled(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!dexDataEnabled()) {
    res.status(404).json({ error: "DEX_DATA_DISABLED", flag: "DUALITY_ENABLE_DEX_DATA" });
    return;
  }
  next();
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function forwardJson(res: express.Response, upstream: Promise<Response>): Promise<void> {
  try {
    const r = await upstream;
    const raw = await r.text();
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { raw };
    }
    res.status(r.status).json(body);
  } catch (error) {
    res.status(502).json({ error: "INGESTOR_UNREACHABLE", detail: (error as Error).message });
  }
}

export function createDexRouter(ingestor: IngestorFetch, worker?: IngestorFetch): express.Router {
  const router = express.Router();
  router.use(enabled);

  router.get("/api/dex/venues", async (req, res) => {
    const chainId = req.query.chainId ? Number(req.query.chainId) : undefined;
    const params: unknown[] = [];
    const where: string[] = [];
    if (chainId) {
      params.push(chainId);
      where.push(`chain_id = $${params.length}`);
    }
    const r = await db.query(
      `
        SELECT venue_id, chain_id, name, adapter, router_address, factory_address,
               quoter_address, status, metadata_json, updated_at
        FROM dex_venues
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY chain_id, name
      `,
      params
    );
    res.json({ venues: r.rows, source: "duality_db" });
  });

  router.get("/api/dex/pools", async (req, res) => {
    const chainId = req.query.chainId ? Number(req.query.chainId) : undefined;
    const venueId = typeof req.query.venueId === "string" ? req.query.venueId : undefined;
    const token = typeof req.query.token === "string" ? req.query.token.toUpperCase() : undefined;
    const q = typeof req.query.q === "string" ? req.query.q.toLowerCase() : undefined;
    const limit = clamp(Number(req.query.limit ?? 100), 1, 500);
    const params: unknown[] = [];
    const where: string[] = [];
    if (chainId) {
      params.push(chainId);
      where.push(`p.chain_id = $${params.length}`);
    }
    if (venueId) {
      params.push(venueId);
      where.push(`p.venue_id = $${params.length}`);
    }
    if (token) {
      params.push(token);
      where.push(`(upper(p.token0_symbol) = $${params.length} OR upper(p.token1_symbol) = $${params.length})`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(lower(p.pool_id) LIKE $${params.length} OR lower(p.pool_address) LIKE $${params.length} OR lower(p.token0_symbol) LIKE $${params.length} OR lower(p.token1_symbol) LIKE $${params.length})`);
    }
    params.push(limit);
    const r = await db.query(
      `
        SELECT p.pool_id, p.chain_id, p.venue_id, v.name AS venue_name, p.pool_address,
               p.token0_symbol, p.token1_symbol, p.fee_bps, p.tick_spacing, p.status,
               p.source, p.metadata_json, p.updated_at,
               s.price_usd::text AS latest_price_usd,
               s.liquidity::text AS latest_liquidity,
               s.ts AS latest_snapshot_at,
               c.close::text AS latest_close,
               c.open_time AS latest_candle_at,
               c.coverage_score::text AS latest_coverage_score
        FROM dex_pools p
        JOIN dex_venues v ON v.venue_id = p.venue_id
        LEFT JOIN LATERAL (
          SELECT price_usd, liquidity, ts
          FROM dex_pool_snapshots
          WHERE pool_id = p.pool_id
          ORDER BY ts DESC
          LIMIT 1
        ) s ON TRUE
        LEFT JOIN LATERAL (
          SELECT close, open_time, coverage_score
          FROM dex_candles
          WHERE pool_id = p.pool_id
          ORDER BY open_time DESC
          LIMIT 1
        ) c ON TRUE
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY COALESCE(s.ts, c.open_time, p.updated_at) DESC NULLS LAST
        LIMIT $${params.length}
      `,
      params
    );
    res.json({ pools: r.rows, count: r.rowCount, source: "duality_db" });
  });

  router.get("/api/dex/candles", async (req, res) => {
    const poolId = typeof req.query.poolId === "string" ? req.query.poolId : undefined;
    const interval = String(req.query.interval ?? "hour");
    const limit = clamp(Number(req.query.limit ?? 200), 1, 2000);
    if (!poolId) return res.status(400).json({ error: "POOL_ID_REQUIRED" });
    const r = await db.query(
      `
        SELECT pool_id, synthetic_symbol, interval, EXTRACT(EPOCH FROM open_time)*1000 AS ts,
               open::text, high::text, low::text, close::text,
               volume0::text, volume1::text, volume_usd::text,
               source, coverage_score::text, blend_config_json
        FROM dex_candles
        WHERE pool_id = $1 AND interval = $2
        ORDER BY open_time DESC
        LIMIT $3
      `,
      [poolId, interval, limit]
    );
    res.json({ poolId, interval, candles: r.rows.reverse(), count: r.rowCount, data_source: "dex" });
  });

  router.get("/api/dex/swaps", async (req, res) => {
    const poolId = typeof req.query.poolId === "string" ? req.query.poolId : undefined;
    const limit = clamp(Number(req.query.limit ?? 200), 1, 1000);
    if (!poolId) return res.status(400).json({ error: "POOL_ID_REQUIRED" });
    const r = await db.query(
      `
        SELECT tx_hash, log_index, pool_id, block_number, EXTRACT(EPOCH FROM ts)*1000 AS ts,
               sender, recipient, amount0::text, amount1::text, amount_usd::text,
               price_usd::text, source, payload_json
        FROM dex_swaps
        WHERE pool_id = $1
        ORDER BY ts DESC
        LIMIT $2
      `,
      [poolId, limit]
    );
    res.json({ poolId, swaps: r.rows, count: r.rowCount, data_source: "dex" });
  });

  router.get("/api/dex/pool-snapshots", async (req, res) => {
    const poolId = typeof req.query.poolId === "string" ? req.query.poolId : undefined;
    const limit = clamp(Number(req.query.limit ?? 100), 1, 500);
    if (!poolId) return res.status(400).json({ error: "POOL_ID_REQUIRED" });
    const r = await db.query(
      `
        SELECT pool_id, block_number, EXTRACT(EPOCH FROM ts)*1000 AS ts,
               liquidity::text, reserve0::text, reserve1::text,
               price_native::text, price_usd::text, source, checksum, metadata_json
        FROM dex_pool_snapshots
        WHERE pool_id = $1
        ORDER BY ts DESC
        LIMIT $2
      `,
      [poolId, limit]
    );
    res.json({ poolId, snapshots: r.rows, count: r.rowCount, data_source: "dex" });
  });

  router.post("/api/dex/backfill/pools", async (req, res) => {
    await forwardJson(res, ingestor("/collect/dex/backfill/pools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    }));
  });

  router.post("/api/dex/backfill/swaps", async (req, res) => {
    await forwardJson(res, ingestor("/collect/dex/backfill/swaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    }));
  });

  // Raw on-chain pool state + swaps from The Graph (Uniswap v3 Arbitrum subgraph).
  router.post("/api/dex/subgraph/pools", async (req, res) => {
    await forwardJson(res, ingestor("/collect/dex/subgraph/pools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    }));
  });

  router.post("/api/dex/subgraph/swaps", async (req, res) => {
    await forwardJson(res, ingestor("/collect/dex/subgraph/swaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    }));
  });

  router.get("/api/dex/subgraph/health", async (_req, res) => {
    await forwardJson(res, ingestor("/collect/dex/subgraph/health"));
  });

  // ---- LP positions (third sleeve): raw sync via ingestor, valuation/sim via worker ----
  router.post("/api/dex/lp/sync", async (req, res) => {
    await forwardJson(res, ingestor("/collect/dex/lp/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    }));
  });

  router.get("/api/dex/lp/positions", async (req, res) => {
    const wallet = typeof req.query.wallet === "string" ? req.query.wallet.toLowerCase() : undefined;
    const chainId = req.query.chainId ? Number(req.query.chainId) : undefined;
    const r = await db.query(
      `SELECT lp.position_id, lp.wallet_address, lp.chain_id, lp.pool_id, lp.nft_id,
              lp.tick_lower, lp.tick_upper, lp.liquidity::text, lp.status, lp.venue_id,
              p.token0_symbol, p.token1_symbol, p.fee_bps
       FROM lp_positions lp JOIN dex_pools p ON p.pool_id = lp.pool_id
       WHERE ($1::text IS NULL OR lower(lp.wallet_address) = $1)
         AND ($2::bigint IS NULL OR lp.chain_id = $2)
       ORDER BY lp.updated_at DESC LIMIT 200`,
      [wallet ?? null, chainId ?? null],
    );
    res.json({ positions: r.rows, count: r.rowCount, source: "duality_db" });
  });

  router.post("/api/dex/lp/value", async (req, res) => {
    if (!worker) { res.status(503).json({ error: "WORKER_UNAVAILABLE" }); return; }
    await forwardJson(res, worker("/lp/value", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    }));
  });

  router.post("/api/dex/lp/simulate", async (req, res) => {
    if (!worker) { res.status(503).json({ error: "WORKER_UNAVAILABLE" }); return; }
    await forwardJson(res, worker("/lp/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    }));
  });

  // ---- Multiasset 3-sleeve portfolio (tokens + tokenized stocks + LP) ----
  router.post("/api/portfolio/multiasset/plan", async (req, res) => {
    if (!worker) { res.status(503).json({ error: "WORKER_UNAVAILABLE" }); return; }
    await forwardJson(res, worker("/portfolio/multiasset/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    }));
  });

  router.post("/api/portfolio/multiasset/rebalance", async (req, res) => {
    if (!worker) { res.status(503).json({ error: "WORKER_UNAVAILABLE" }); return; }
    await forwardJson(res, worker("/portfolio/multiasset/rebalance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    }));
  });

  router.post("/api/dex/subscribe", async (req, res) => {
    await forwardJson(res, ingestor("/live/dex/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    }));
  });

  router.post("/api/dex/poll", async (req, res) => {
    await forwardJson(res, ingestor("/live/dex/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    }));
  });

  router.post("/api/dex/quote", async (req, res) => {
    const parsed = z.object({
      poolId: z.string(),
      amountIn: z.union([z.string(), z.number()]),
      tokenIn: z.string().optional(),
      tokenOut: z.string().optional(),
      slippageBps: z.number().default(50),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const pool = await db.query(
      `
        SELECT p.*, v.adapter
        FROM dex_pools p
        JOIN dex_venues v ON v.venue_id = p.venue_id
        WHERE p.pool_id = $1
      `,
      [parsed.data.poolId]
    );
    if (!pool.rowCount) return res.status(404).json({ error: "POOL_NOT_FOUND" });
    const snapshot = await db.query(
      `
        SELECT reserve0, reserve1, liquidity, price_usd, ts, source
        FROM dex_pool_snapshots
        WHERE pool_id = $1
        ORDER BY ts DESC
        LIMIT 1
      `,
      [parsed.data.poolId]
    );
    const candle = await db.query(
      `
        SELECT close, open_time, source, coverage_score
        FROM dex_candles
        WHERE pool_id = $1
        ORDER BY open_time DESC
        LIMIT 1
      `,
      [parsed.data.poolId]
    );
    const amountIn = asNumber(parsed.data.amountIn);
    const row = pool.rows[0] as Record<string, unknown>;
    const snap = snapshot.rows[0] as Record<string, unknown> | undefined;
    const last = candle.rows[0] as Record<string, unknown> | undefined;
    const feeBps = asNumber(row.fee_bps, 30);
    const reserve0 = asNumber(snap?.reserve0);
    const reserve1 = asNumber(snap?.reserve1);
    const tokenIn = parsed.data.tokenIn ?? String(row.token0_symbol ?? "token0");
    const tokenOut = parsed.data.tokenOut ?? String(row.token1_symbol ?? "token1");
    const tokenInIs0 = tokenIn.toUpperCase() === String(row.token0_symbol ?? "").toUpperCase();
    let expectedOut: number | null = null;
    let mode = "amm_mid_only";
    let resultTier = "LOCAL ONLY";
    const warnings: string[] = [];
    if (reserve0 > 0 && reserve1 > 0) {
      const reserveIn = tokenInIs0 ? reserve0 : reserve1;
      const reserveOut = tokenInIs0 ? reserve1 : reserve0;
      const amountAfterFee = amountIn * (1 - feeBps / 10_000);
      expectedOut = (amountAfterFee * reserveOut) / (reserveIn + amountAfterFee);
      mode = "amm_quote_snapshot";
      resultTier = "DEX MODELED";
    } else {
      const price = asNumber(snap?.price_usd, asNumber(last?.close));
      expectedOut = price > 0 ? amountIn * price : null;
      warnings.push("NO_POOL_RESERVES_NEAR_QUOTE_TIME");
    }
    const slippageBps = clamp(parsed.data.slippageBps, 0, 5000);
    const minOut = expectedOut == null ? null : expectedOut * (1 - slippageBps / 10_000);
    const quoteId = `quote_${randomUUID()}`;
    const route = [{ pool_id: parsed.data.poolId, venue: row.venue_id, token_in: tokenIn, token_out: tokenOut, fee_bps: feeBps }];
    await db.query(
      `
        INSERT INTO dex_quotes (
          quote_id, chain_id, venue_id, route_json, amount_in, token_in, token_out,
          expected_out, slippage_bps, gas_estimate, source, honesty_json
        ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      `,
      [
        quoteId,
        Number(row.chain_id),
        String(row.venue_id),
        JSON.stringify(route),
        String(amountIn),
        tokenIn,
        tokenOut,
        expectedOut == null ? null : String(expectedOut),
        String(slippageBps),
        null,
        mode,
        JSON.stringify({ result_tier: resultTier, execution_fidelity: mode, data_source: "dex", warnings }),
      ]
    );
    res.json({
      quoteId,
      poolId: parsed.data.poolId,
      route,
      amountIn,
      expectedOut,
      minOut,
      slippageBps,
      priceImpactBps: reserve0 > 0 && reserve1 > 0 ? Number(((amountIn / (tokenInIs0 ? reserve0 : reserve1)) * 10_000).toFixed(4)) : null,
      source: mode,
      truth: {
        result_tier: resultTier,
        data_source: "dex",
        execution_fidelity: mode,
        testnet_disclaimer: null,
        can_execute_real_money: false,
        warnings,
      },
    });
  });

  router.post("/api/dex/route/compare", async (req, res) => {
    const parsed = z.object({
      poolId: z.string(),
      bybitSymbol: z.string().default("ETHUSDT"),
      bybitCategory: z.string().default("linear"),
      interval: z.string().default("60"),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const dex = await db.query(
      `
        SELECT c.close::text, c.open_time, c.source, c.coverage_score::text, p.token0_symbol, p.token1_symbol
        FROM dex_candles c
        JOIN dex_pools p ON p.pool_id = c.pool_id
        WHERE c.pool_id = $1
        ORDER BY c.open_time DESC
        LIMIT 1
      `,
      [parsed.data.poolId]
    );
    const bybit = await db.query(
      `
        SELECT close::text, open_time
        FROM candles
        WHERE symbol = $1 AND category = $2 AND interval = $3
        ORDER BY open_time DESC
        LIMIT 1
      `,
      [parsed.data.bybitSymbol.toUpperCase(), parsed.data.bybitCategory, parsed.data.interval]
    );
    const dexClose = asNumber(dex.rows[0]?.close);
    const bybitClose = asNumber(bybit.rows[0]?.close);
    const divergenceBps = dexClose > 0 && bybitClose > 0 ? ((dexClose - bybitClose) / bybitClose) * 10_000 : null;
    const warnings: string[] = [];
    if (!dex.rowCount) warnings.push("NO_DEX_CANDLE");
    if (!bybit.rowCount) warnings.push("NO_BYBIT_REFERENCE_CANDLE");
    if (divergenceBps !== null && Math.abs(divergenceBps) > 150) warnings.push("REFERENCE_DIVERGENCE_HIGH");
    res.json({
      poolId: parsed.data.poolId,
      bybitSymbol: parsed.data.bybitSymbol.toUpperCase(),
      dex: dex.rows[0] ?? null,
      bybit: bybit.rows[0] ?? null,
      divergenceBps,
      truth: {
        data_source: "blended",
        blend_config_json: { bybit: parsed.data.bybitSymbol.toUpperCase(), dex_pool_id: parsed.data.poolId },
        can_execute_real_money: false,
        warnings,
      },
    });
  });

  router.get("/api/dex/chains/:chainId", (req, res) => {
    const chain = findChain(Number(req.params.chainId));
    if (!chain) return res.status(404).json({ error: "CHAIN_NOT_FOUND" });
    res.json({ chain: publicChain(chain) });
  });

  return router;
}
