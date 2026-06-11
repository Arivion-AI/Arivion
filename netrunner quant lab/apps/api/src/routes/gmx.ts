import express from "express";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DUALITY_CHAIN_IDS, realTraderEnabled } from "../config/chains.js";
import { requireOwnerId } from "../lib/auth.js";
import { db } from "../lib/db.js";

const requireCjs = createRequire(import.meta.url);
const GMX_CHAIN_ID = DUALITY_CHAIN_IDS.arbitrumOne;
const USDC_DECIMALS = 6;
const USD_DECIMALS = 30;
const MAX_COLLATERAL_USD = Number(process.env.GMX_MAX_COLLATERAL_USD ?? 250);
const MAX_LEVERAGE = Number(process.env.GMX_MAX_LEVERAGE ?? 3);
const DEFAULT_LIMIT = 120;

type GmxSdkModule = {
  GmxApiSdk: new (opts: { chainId: number }) => Record<string, (...args: unknown[]) => Promise<unknown>>;
  PrivateKeySigner: new (privateKey: string, opts?: Record<string, unknown>) => { address: string };
};

type LaunchPolicy = {
  canPrepare: boolean;
  canSubmit: boolean;
  errors: string[];
  warnings: string[];
  requiredEnv: string[];
};

type PreparedTicket = {
  chainId: number;
  venue: "gmx_v2";
  mode: "express";
  kind: "increase";
  symbol: string;
  direction: "long" | "short";
  orderType: "market" | "limit";
  collateralToken: "USDC";
  collateralUsd: number;
  leverage: number;
  sizeUsd: number;
  slippageBps: number;
  triggerPriceUsd?: number;
  strategyId?: string;
  botType?: string;
  risk: {
    maxCollateralUsd: number;
    maxLeverage: number;
    sizeToCollateral: string;
    warnings: string[];
  };
  request: Record<string, unknown>;
  docs: {
    orderLifecycle: string;
    statusTerminal: string[];
  };
};

const orderSchema = z.object({
  symbol: z.string().min(3),
  direction: z.enum(["long", "short"]).default("long"),
  orderType: z.enum(["market", "limit"]).default("market"),
  collateralUsd: z.coerce.number().positive().max(100_000),
  leverage: z.coerce.number().positive().max(100),
  slippageBps: z.coerce.number().int().min(1).max(1000).default(30),
  triggerPriceUsd: z.coerce.number().positive().optional(),
  strategyId: z.string().optional(),
  botType: z.string().optional(),
  confirm: z.literal("LAUNCH_GMX_MAINNET").optional(),
});

const closeSchema = z
  .object({
    requestId: z.string().optional(),
    orderId: z.string().optional(),
    // Fraction of the open position size to close. Defaults to a full close.
    closeFraction: z.coerce.number().positive().max(1).default(1),
    slippageBps: z.coerce.number().int().min(1).max(1000).default(30),
    confirm: z.literal("STOP_GMX_MAINNET").optional(),
  })
  .refine((d) => Boolean(d.requestId || d.orderId), { message: "requestId or orderId required" });

function getSdk(): GmxSdkModule {
  return requireCjs("@gmx-io/sdk/v2") as GmxSdkModule;
}

function parseAmountUnits(value: number, decimals: number): bigint {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const fixed = safe.toFixed(decimals);
  const [whole, frac = ""] = fixed.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0").slice(0, decimals) || "0");
}

function bigintJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, bigintJson(v)]));
  }
  return value;
}

function marketBase(symbol: string): string {
  return symbol
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\/USD.*/i, "")
    .replace(/USDT?$/i, "")
    .trim()
    .toUpperCase();
}

function policyFor(ticket?: PreparedTicket): LaunchPolicy {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requiredEnv = ["DUALITY_ENABLE_REAL_TRADER=true", "AGENT_GMX_PRIVATE_KEY"];
  if (!realTraderEnabled()) errors.push("REAL_TRADER_DISABLED");
  if (!process.env.AGENT_GMX_PRIVATE_KEY) errors.push("AGENT_GMX_PRIVATE_KEY_MISSING");
  if (ticket) {
    if (ticket.collateralUsd > MAX_COLLATERAL_USD) errors.push("COLLATERAL_ABOVE_GMX_MAX_COLLATERAL_USD");
    if (ticket.leverage > MAX_LEVERAGE) errors.push("LEVERAGE_ABOVE_GMX_MAX_LEVERAGE");
    if (ticket.orderType === "limit" && !ticket.triggerPriceUsd) errors.push("LIMIT_TRIGGER_PRICE_REQUIRED");
    if (ticket.collateralUsd < 1) warnings.push("COLLATERAL_LOW_FOR_GMX_MINIMUMS");
    if (ticket.leverage > 1.5) warnings.push("LEVERAGE_RISK_REVIEW_REQUIRED");
  }
  return {
    canPrepare: !ticket || errors.filter((e) => !["REAL_TRADER_DISABLED", "AGENT_GMX_PRIVATE_KEY_MISSING"].includes(e)).length === 0,
    canSubmit: errors.length === 0,
    errors,
    warnings,
    requiredEnv,
  };
}

function buildTicket(input: z.infer<typeof orderSchema>, canonicalSymbol: string): PreparedTicket {
  const collateralUsd = Number(input.collateralUsd);
  const leverage = Number(input.leverage);
  const sizeUsd = Number((collateralUsd * leverage).toFixed(4));
  const riskWarnings: string[] = [];
  if (collateralUsd > MAX_COLLATERAL_USD) riskWarnings.push(`collateral exceeds configured cap $${MAX_COLLATERAL_USD}`);
  if (leverage > MAX_LEVERAGE) riskWarnings.push(`leverage exceeds configured cap ${MAX_LEVERAGE}x`);
  if (input.orderType === "limit" && !input.triggerPriceUsd) riskWarnings.push("limit orders need trigger price");

  const request: Record<string, unknown> = {
    kind: "increase",
    symbol: canonicalSymbol,
    direction: input.direction,
    orderType: input.orderType,
    size: parseAmountUnits(sizeUsd, USD_DECIMALS),
    collateralToken: "USDC",
    collateralToPay: { amount: parseAmountUnits(collateralUsd, USDC_DECIMALS), token: "USDC" },
    slippage: input.slippageBps,
    mode: "express",
  };
  if (input.orderType === "limit" && input.triggerPriceUsd) {
    request.triggerPrice = parseAmountUnits(input.triggerPriceUsd, USD_DECIMALS);
  }
  if (process.env.GMX_REFERRAL_CODE) request.referralCode = process.env.GMX_REFERRAL_CODE;
  if (process.env.GMX_UI_FEE_RECEIVER) request.uiFeeReceiver = process.env.GMX_UI_FEE_RECEIVER;

  return {
    chainId: GMX_CHAIN_ID,
    venue: "gmx_v2",
    mode: "express",
    kind: "increase",
    symbol: canonicalSymbol,
    direction: input.direction,
    orderType: input.orderType,
    collateralToken: "USDC",
    collateralUsd,
    leverage,
    sizeUsd,
    slippageBps: input.slippageBps,
    triggerPriceUsd: input.triggerPriceUsd,
    strategyId: input.strategyId,
    botType: input.botType,
    risk: {
      maxCollateralUsd: MAX_COLLATERAL_USD,
      maxLeverage: MAX_LEVERAGE,
      sizeToCollateral: `${sizeUsd.toFixed(2)} / ${collateralUsd.toFixed(2)}`,
      warnings: riskWarnings,
    },
    request,
    docs: {
      orderLifecycle: "GMX express order: prepare -> sign -> submit -> poll requestId until created/executed/cancelled/relay_failed/relay_reverted.",
      statusTerminal: ["executed", "cancelled", "relay_failed", "relay_reverted"],
    },
  };
}

// Build a GMX v2 express DECREASE request that closes (or partially closes) an open position and
// returns the freed collateral to the account wallet as USDC. `sizeUsd` is the USD size delta in
// GMX's 30-decimal fixed point (taken from the live position's sizeInUsd, scaled by closeFraction).
function buildDecreaseRequest(opts: {
  symbol: string;
  direction: "long" | "short";
  sizeUsd: bigint;
  slippageBps: number;
  from: string;
}): Record<string, unknown> {
  const request: Record<string, unknown> = {
    kind: "decrease",
    symbol: opts.symbol,
    direction: opts.direction,
    orderType: "market",
    size: opts.sizeUsd,
    collateralToken: "USDC",
    receiveToken: "USDC", // collateral returns to the account wallet as USDC
    keepLeverage: false, // withdraw freed collateral instead of re-levering the remainder
    slippage: opts.slippageBps,
    mode: "express",
    from: opts.from,
  };
  if (process.env.GMX_REFERRAL_CODE) request.referralCode = process.env.GMX_REFERRAL_CODE;
  if (process.env.GMX_UI_FEE_RECEIVER) request.uiFeeReceiver = process.env.GMX_UI_FEE_RECEIVER;
  return request;
}

async function sdkClient() {
  const { GmxApiSdk } = getSdk();
  return new GmxApiSdk({ chainId: GMX_CHAIN_ID });
}

async function resolveCanonicalSymbol(rawSymbol: string): Promise<string> {
  const symbol = rawSymbol.trim();
  if (symbol.includes("/USD") && symbol.includes("[")) return symbol;
  const base = marketBase(symbol);
  const sdk = await sdkClient();
  const markets = (await sdk.fetchMarkets()) as Array<Record<string, unknown>>;
  const match = markets.find((m) => {
    const s = String(m.symbol ?? "").toUpperCase();
    return s.startsWith(`${base}/USD`) && m.isSpotOnly !== true;
  }) ?? markets.find((m) => String(m.symbol ?? "").toUpperCase().includes(`${base}/USD`));
  return String(match?.symbol ?? `${base}/USD`);
}

async function marketRows(limit: number, q = ""): Promise<Array<Record<string, unknown>>> {
  const sdk = await sdkClient();
  const [markets, tickers] = await Promise.all([
    sdk.fetchMarkets() as Promise<Array<Record<string, unknown>>>,
    sdk.fetchMarketsTickers() as Promise<Array<Record<string, unknown>>>,
  ]);
  const tickerBySymbol = new Map(tickers.map((t) => [String(t.symbol ?? ""), t]));
  const needle = q.trim().toUpperCase();
  return markets
    .filter((m) => m.isSpotOnly !== true)
    .map((m): Record<string, unknown> => ({ ...m, ticker: tickerBySymbol.get(String(m.symbol ?? "")) ?? null }))
    .filter((m) => !needle || String(m.symbol ?? "").toUpperCase().includes(needle))
    .sort((a, b) => Number((b.ticker as Record<string, unknown> | null)?.longInterestUsd ?? 0) - Number((a.ticker as Record<string, unknown> | null)?.longInterestUsd ?? 0))
    .slice(0, limit)
    .map((row) => bigintJson(row) as Record<string, unknown>);
}

export function createGmxRouter(): express.Router {
  const router = express.Router();

  router.get("/api/gmx/live/markets", async (req, res) => {
    try {
      const limit = Math.max(10, Math.min(250, Number(req.query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
      const rows = await marketRows(limit, typeof req.query.q === "string" ? req.query.q : "");
      res.json({
        chainId: GMX_CHAIN_ID,
        source: "gmx_sdk_v2",
        markets: rows,
        policy: policyFor(),
        truth: {
          data_source: "@gmx-io/sdk/v2 fetchMarkets + fetchMarketsTickers",
          can_execute_real_money: realTraderEnabled() && Boolean(process.env.AGENT_GMX_PRIVATE_KEY),
        },
      });
    } catch (error) {
      res.status(502).json({ error: "GMX_SDK_MARKETS_FAILED", detail: (error as Error).message });
    }
  });

  router.get("/api/gmx/live/account", async (req, res) => {
    try {
      const address = typeof req.query.address === "string" ? req.query.address : "";
      if (!address) {
        res.status(400).json({ error: "address required" });
        return;
      }
      const sdk = await sdkClient();
      const [positions, orders, trades, balances] = await Promise.all([
        sdk.fetchPositionsInfo({ address, includeRelatedOrders: true }),
        sdk.fetchOrders({ address }),
        sdk.fetchTrades({ address, limit: 20 }).catch((e: unknown) => ({ error: (e as Error).message })),
        sdk.fetchWalletBalances({ address }).catch((e: unknown) => ({ error: (e as Error).message })),
      ]);
      res.json(bigintJson({ chainId: GMX_CHAIN_ID, address, positions, orders, trades, balances, source: "gmx_sdk_v2" }));
    } catch (error) {
      res.status(502).json({ error: "GMX_ACCOUNT_FAILED", detail: (error as Error).message });
    }
  });

  router.get("/api/gmx/live/sessions", async (req, res) => {
    const ownerId = requireOwnerId(req);
    try {
      const r = await db.query(
        `SELECT id, chain_id, account, request_id, status, symbol, strategy_id, bot_type,
                direction, collateral_usd, leverage, size_usd, ticket, submitted, created_at, updated_at
           FROM agent_gmx_live_orders
          WHERE owner_id = $1
          ORDER BY created_at DESC
          LIMIT 100`,
        [ownerId],
      );
      res.json({
        orders: r.rows,
        policy: policyFor(),
        truth: {
          data_source: "agent_gmx_live_orders + GMX account endpoints",
          note: "This is the owner-scoped launch ledger. Open GMX positions/orders are read from /api/gmx/live/account.",
        },
      });
    } catch (error) {
      res.status(500).json({ error: "GMX_LIVE_SESSIONS_FAILED", detail: (error as Error).message });
    }
  });

  router.post("/api/gmx/live/prepare", async (req, res) => {
    const parsed = orderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_GMX_ORDER", detail: parsed.error.flatten() });
      return;
    }
    try {
      const canonical = await resolveCanonicalSymbol(parsed.data.symbol);
      const ticket = buildTicket(parsed.data, canonical);
      const policy = policyFor(ticket);
      res.status(policy.canPrepare ? 200 : 400).json(bigintJson({ ok: policy.canPrepare, ticket, policy }));
    } catch (error) {
      res.status(502).json({ error: "GMX_PREPARE_FAILED", detail: (error as Error).message });
    }
  });

  router.post("/api/gmx/live/launch", async (req, res) => {
    const ownerId = requireOwnerId(req);
    const parsed = orderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_GMX_ORDER", detail: parsed.error.flatten() });
      return;
    }
    try {
      const canonical = await resolveCanonicalSymbol(parsed.data.symbol);
      const ticket = buildTicket(parsed.data, canonical);
      const policy = policyFor(ticket);
      if (parsed.data.confirm !== "LAUNCH_GMX_MAINNET") {
        res.status(400).json(bigintJson({ ok: false, error: "CONFIRMATION_REQUIRED", required: "LAUNCH_GMX_MAINNET", ticket, policy }));
        return;
      }
      if (!policy.canSubmit) {
        res.status(403).json(bigintJson({ ok: false, error: "GMX_LIVE_BLOCKED", ticket, policy }));
        return;
      }
      const { GmxApiSdk, PrivateKeySigner } = getSdk();
      const privateKey = String(process.env.AGENT_GMX_PRIVATE_KEY ?? "");
      const sdk = new GmxApiSdk({ chainId: GMX_CHAIN_ID });
      const signer = new PrivateKeySigner(privateKey);
      ticket.request.from = signer.address;
      const submitted = await sdk.executeExpressOrder(ticket.request, signer);
      const requestId = (submitted as Record<string, unknown>)?.requestId;
      const status = String((submitted as Record<string, unknown>)?.status ?? "submitted");
      await db.query(
        `INSERT INTO agent_gmx_live_orders
           (id, owner_id, chain_id, account, request_id, status, symbol, strategy_id, bot_type,
            direction, collateral_usd, leverage, size_usd, ticket, submitted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)`,
        [
          `gmx_live_${randomUUID()}`,
          ownerId,
          GMX_CHAIN_ID,
          signer.address,
          typeof requestId === "string" ? requestId : null,
          status,
          ticket.symbol,
          ticket.strategyId ?? null,
          ticket.botType ?? null,
          ticket.direction,
          ticket.collateralUsd,
          ticket.leverage,
          ticket.sizeUsd,
          JSON.stringify(bigintJson(ticket)),
          JSON.stringify(bigintJson(submitted)),
        ],
      );
      res.json(bigintJson({
        ok: true,
        ownerId,
        chainId: GMX_CHAIN_ID,
        account: signer.address,
        submitted,
        requestId,
        status,
        ticket,
        truth: {
          result_tier: "GMX_MAINNET_SUBMITTED",
          venue: "gmx_v2",
          can_execute_real_money: true,
          source: "@gmx-io/sdk/v2 executeExpressOrder",
        },
      }));
    } catch (error) {
      res.status(502).json({ ok: false, error: "GMX_LAUNCH_FAILED", detail: (error as Error).message });
    }
  });

  router.get("/api/gmx/live/order-status/:requestId", async (req, res) => {
    try {
      const sdk = await sdkClient();
      const status = await sdk.fetchOrderStatus({ requestId: req.params.requestId });
      res.json(bigintJson({ requestId: req.params.requestId, status }));
    } catch (error) {
      res.status(502).json({ error: "GMX_STATUS_FAILED", detail: (error as Error).message });
    }
  });

  router.post("/api/gmx/live/stop", async (req, res) => {
    const ownerId = requireOwnerId(req);
    const parsed = closeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_GMX_CLOSE", detail: parsed.error.flatten() });
      return;
    }
    const { requestId, orderId, closeFraction, slippageBps } = parsed.data;
    const policy = policyFor();
    try {
      // 1. Resolve which launched position this close targets, from the owner-scoped ledger.
      const ledger = await db.query<{ symbol: string; direction: string; size_usd: number; strategy_id: string | null; bot_type: string | null }>(
        `SELECT symbol, direction, size_usd, strategy_id, bot_type
           FROM agent_gmx_live_orders
          WHERE owner_id = $1 AND ($2::text IS NULL OR request_id = $2) AND ($3::text IS NULL OR id = $3)
          ORDER BY created_at DESC
          LIMIT 1`,
        [ownerId, requestId ?? null, orderId ?? null],
      );
      const row = ledger.rows[0];
      if (!row) {
        res.status(404).json({ ok: false, error: "GMX_LAUNCH_NOT_FOUND", requestId, orderId });
        return;
      }
      if (parsed.data.confirm !== "STOP_GMX_MAINNET") {
        res.status(400).json(bigintJson({ ok: false, error: "CONFIRMATION_REQUIRED", required: "STOP_GMX_MAINNET", policy }));
        return;
      }
      if (!policy.canSubmit) {
        res.status(403).json(bigintJson({ ok: false, error: "GMX_LIVE_BLOCKED", policy }));
        return;
      }
      const direction = row.direction === "short" ? "short" : "long";
      const { GmxApiSdk, PrivateKeySigner } = getSdk();
      const sdk = new GmxApiSdk({ chainId: GMX_CHAIN_ID });
      const signer = new PrivateKeySigner(String(process.env.AGENT_GMX_PRIVATE_KEY ?? ""));

      // 2. Read the live position so we close the real on-chain size, not the ledger's notional.
      const base = marketBase(row.symbol);
      const positions = (await sdk.fetchPositionsInfo({ address: signer.address, includeRelatedOrders: false })) as Array<Record<string, unknown>>;
      const position = positions.find((p) => {
        const idx = String(p.indexName ?? "").toUpperCase();
        return Boolean(p.isLong) === (direction === "long") && idx.startsWith(`${base}/`) && BigInt((p.sizeInUsd as bigint) ?? 0n) > 0n;
      });
      if (!position) {
        res.status(409).json({ ok: false, error: "GMX_POSITION_NOT_OPEN", symbol: row.symbol, direction, detail: "No open GMX position matches this launch; nothing to close." });
        return;
      }
      const fullSizeUsd = BigInt((position.sizeInUsd as bigint) ?? 0n);
      const fracBps = BigInt(Math.round(closeFraction * 1_000_000));
      const sizeDeltaUsd = (fullSizeUsd * fracBps) / 1_000_000n;

      // 3. Build + submit the decrease express order (same signer/relay path as launch).
      const request = buildDecreaseRequest({ symbol: row.symbol, direction, sizeUsd: sizeDeltaUsd, slippageBps, from: signer.address });
      const submitted = await sdk.executeExpressOrder(request, signer);
      const closeRequestId = (submitted as Record<string, unknown>)?.requestId;
      const status = String((submitted as Record<string, unknown>)?.status ?? "submitted");

      // 4. Record the close leg and mark the originating launch as closing.
      const closeUsd = Number(sizeDeltaUsd) / 10 ** USD_DECIMALS;
      await db.query(
        `INSERT INTO agent_gmx_live_orders
           (id, owner_id, chain_id, account, request_id, status, symbol, strategy_id, bot_type,
            direction, collateral_usd, leverage, size_usd, ticket, submitted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)`,
        [
          `gmx_close_${randomUUID()}`,
          ownerId,
          GMX_CHAIN_ID,
          signer.address,
          typeof closeRequestId === "string" ? closeRequestId : null,
          status,
          row.symbol,
          row.strategy_id,
          row.bot_type,
          direction,
          0,
          0,
          closeUsd,
          JSON.stringify(bigintJson({ kind: "decrease", request, closeFraction })),
          JSON.stringify(bigintJson(submitted)),
        ],
      );
      if (requestId) {
        await db.query(
          `UPDATE agent_gmx_live_orders SET status = $2, updated_at = now() WHERE owner_id = $1 AND request_id = $3`,
          [ownerId, closeFraction >= 1 ? "closing" : "partial_close", requestId],
        );
      }

      res.json(bigintJson({
        ok: true,
        ownerId,
        chainId: GMX_CHAIN_ID,
        account: signer.address,
        requestId: closeRequestId,
        status,
        symbol: row.symbol,
        direction,
        closeFraction,
        closedSizeUsd: closeUsd,
        submitted,
        policy,
        truth: {
          result_tier: "GMX_MAINNET_SUBMITTED",
          venue: "gmx_v2",
          can_execute_real_money: true,
          source: "@gmx-io/sdk/v2 executeExpressOrder (decrease)",
          note: "Decrease order submitted. Poll /api/gmx/live/order-status/:requestId until executed; freed collateral returns to the GMX account wallet as USDC.",
        },
      }));
    } catch (error) {
      res.status(502).json({ ok: false, error: "GMX_CLOSE_FAILED", detail: (error as Error).message });
    }
  });

  return router;
}
