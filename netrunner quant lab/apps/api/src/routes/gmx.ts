import express from "express";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DUALITY_CHAIN_IDS, realTraderEnabled } from "../config/chains.js";
import { requireOwnerId } from "../lib/auth.js";
import { db } from "../lib/db.js";
import { agentWalletKey } from "../lib/agentExec.js";
import { executeGmxViaOneShot } from "../lib/gmxOneShotExec.js";
import { smartAccountExecEnabled } from "../lib/smartAccountExec.js";

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

// --- USDC + relay-router allowance helpers ---------------------------------------------------------
// GMX express relays the order: the Gelato relay router transferFroms the USDC collateral + relayer fee
// straight from the wallet. A fresh wallet has no allowance and the SDK attaches no permit
// (tokenPermits: []), so the relay reverts. We pre-approve USDC to the discovered relay router once.
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // native USDC on Arbitrum One
const MAX_UINT256 = (1n << 256n) - 1n;
// Minimal viem chain object so PrivateKeySigner.sendTransaction (used only for the approval) works.
const ARBITRUM_ONE_CHAIN = {
  id: GMX_CHAIN_ID,
  name: "Arbitrum One",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARBITRUM_ONE_RPC_URL ?? ""] } },
};

async function arbRpc(method: string, params: unknown[]): Promise<unknown> {
  const url = process.env.ARBITRUM_ONE_RPC_URL;
  if (!url) throw new Error("ARBITRUM_ONE_RPC_URL not set");
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message ?? "rpc error"}`);
  return j.result ?? null;
}

async function erc20Allowance(token: string, owner: string, spender: string): Promise<bigint> {
  const data = "0xdd62ed3e" + owner.slice(2).toLowerCase().padStart(64, "0") + spender.slice(2).toLowerCase().padStart(64, "0");
  const res = (await arbRpc("eth_call", [{ to: token, data }, "latest"])) as string | null;
  return BigInt(res ?? "0x0");
}

async function waitForApproval(txHash: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rc = (await arbRpc("eth_getTransactionReceipt", [txHash])) as { status?: string } | null;
    if (rc && rc.status) {
      if (rc.status === "0x1") return;
      throw new Error(`USDC approval reverted (${txHash})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`USDC approval not mined within ${timeoutMs}ms (${txHash})`);
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
  const requiredEnv = ["DUALITY_ENABLE_REAL_TRADER=true"];
  if (!realTraderEnabled()) errors.push("REAL_TRADER_DISABLED");
  // Signing uses the owner's per-user agent wallet (created on demand), so no shared key is required.
  if (ticket) {
    if (ticket.collateralUsd > MAX_COLLATERAL_USD) errors.push("COLLATERAL_ABOVE_GMX_MAX_COLLATERAL_USD");
    if (ticket.leverage > MAX_LEVERAGE) errors.push("LEVERAGE_ABOVE_GMX_MAX_LEVERAGE");
    if (ticket.orderType === "limit" && !ticket.triggerPriceUsd) errors.push("LIMIT_TRIGGER_PRICE_REQUIRED");
    if (ticket.collateralUsd < 1) warnings.push("COLLATERAL_LOW_FOR_GMX_MINIMUMS");
    if (ticket.leverage > 1.5) warnings.push("LEVERAGE_RISK_REVIEW_REQUIRED");
  }
  return {
    canPrepare: !ticket || errors.filter((e) => !["REAL_TRADER_DISABLED"].includes(e)).length === 0,
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

// Resolve a (possibly bare, e.g. "ETH") symbol to a canonical GMX market label. CRITICAL: we always
// pay USDC collateral (buildTicket hard-codes collateralToken="USDC"), and GMX rejects an order whose
// market does not list the paid collateral among its tokens ("Collateral token must be one of the
// market's tokens..."). Several bases have multiple markets (e.g. ETH/USD has [WSTETH-USDE],
// [WETH-USDC], [WETH-WETH]); a naive first-match picks an exotic non-USDC pool and every launch fails.
// So we prefer the market whose bracketed token pair includes the collateral token.
async function resolveCanonicalSymbol(rawSymbol: string, collateral = "USDC"): Promise<string> {
  const symbol = rawSymbol.trim();
  const coll = collateral.toUpperCase();
  const acceptsCollateral = (s: string) => (s.toUpperCase().match(/\[([^\]]+)\]/)?.[1] ?? "").includes(coll);
  // Keep a fully-qualified market only if it already accepts the collateral we pay.
  if (symbol.includes("/USD") && symbol.includes("[") && acceptsCollateral(symbol)) return symbol;
  const base = marketBase(symbol);
  const sdk = await sdkClient();
  const markets = (await sdk.fetchMarkets()) as Array<Record<string, unknown>>;
  const byBase = markets.filter((m) => String(m.symbol ?? "").toUpperCase().startsWith(`${base}/USD`) && m.isSpotOnly !== true);
  const match =
    byBase.find((m) => acceptsCollateral(String(m.symbol ?? ""))) ?? // prefer the USDC-collateral market
    byBase[0] ??
    markets.find((m) => String(m.symbol ?? "").toUpperCase().includes(`${base}/USD`));
  return String(match?.symbol ?? `${base}/USD`);
}

// Resolve a canonical market symbol (e.g. "ETH/USD [WETH-USDC]") to its GM marketToken address, needed
// by the onchain GMX→1Shot adapter (which addresses markets by token address, not symbol).
async function resolveMarketAddress(canonicalSymbol: string): Promise<string | null> {
  const sdk = await sdkClient();
  const markets = (await sdk.fetchMarkets()) as Array<Record<string, unknown>>;
  const want = canonicalSymbol.trim().toUpperCase();
  const m = markets.find((x) => String(x.symbol ?? "").toUpperCase() === want)
    ?? markets.find((x) => String(x.symbol ?? "").toUpperCase().startsWith(want.split(" ")[0]) && /\[[^\]]*USDC[^\]]*\]/i.test(String(x.symbol ?? "")));
  const addr = m?.marketTokenAddress ?? m?.marketToken ?? m?.address;
  return addr ? String(addr) : null;
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
          can_execute_real_money: realTraderEnabled(),
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

  // Candlestick OHLCV for the inspect chart. Accepts a bare base ("BTC") or canonical market label.
  router.get("/api/gmx/live/ohlcv", async (req, res) => {
    try {
      const raw = typeof req.query.symbol === "string" && req.query.symbol.trim() ? req.query.symbol.trim() : "BTC";
      const symbol = marketBase(raw) || raw; // fetchOhlcv takes the index token base (e.g. "BTC")
      const timeframe = typeof req.query.timeframe === "string" ? req.query.timeframe : "1h";
      const limit = Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 10), 1000);
      const sdk = await sdkClient();
      const candles = await sdk.fetchOhlcv({ symbol, timeframe, limit });
      res.json(bigintJson({ symbol, timeframe, candles }));
    } catch (error) {
      res.status(502).json({ error: "GMX_OHLCV_FAILED", detail: (error as Error).message });
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
      // Smart-account / 1Shot execution path (flag-gated). We capture the EXACT GMX ExchangeRouter
      // .multicall calldata the SDK would broadcast (via gmxOneShotExec's SDK interception) and relay it
      // through 1Shot as an EIP-7710 delegated execution under a FunctionCall-scoped delegation — gas in
      // USDC. Proven live on mainnet (see GMX_TO_1SHOT.md, tx 0x772bcc8…36c8). Requires the agent wallet
      // to hold the USDC collateral + a little ETH (GMX's native keeper execution fee) + USDC approval to
      // the GMX Router (ensured below). When the flag is off, the native Gelato express path runs.
      if (smartAccountExecEnabled()) {
        const marketAddress = await resolveMarketAddress(canonical);
        if (!marketAddress) {
          res.status(409).json(bigintJson({ ok: false, error: "GMX_MARKET_UNRESOLVED", detail: `Could not resolve a USDC-collateral market for ${canonical}.`, ticket, policy }));
          return;
        }
        const r = await executeGmxViaOneShot({
          ownerId,
          marketAddress: marketAddress as `0x${string}`,
          collateralUsd: ticket.collateralUsd,
          leverageBps: Math.round(ticket.leverage * 10000),
          isLong: ticket.direction !== "short",
        });
        if (!r.ok) {
          res.status(502).json(bigintJson({ ok: false, error: "GMX_1SHOT_FAILED", detail: r.error, ticket, policy }));
          return;
        }
        await db.query(
          `INSERT INTO agent_gmx_live_orders
             (id, owner_id, chain_id, account, request_id, status, symbol, strategy_id, bot_type,
              direction, collateral_usd, leverage, size_usd, ticket, submitted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)`,
          [
            `gmx_1shot_${randomUUID()}`, ownerId, GMX_CHAIN_ID, r.exchangeRouter, r.taskId, "relayed",
            ticket.symbol, ticket.strategyId ?? null, ticket.botType ?? null, ticket.direction,
            ticket.collateralUsd, ticket.leverage, ticket.sizeUsd,
            JSON.stringify(bigintJson(ticket)), JSON.stringify({ via: "1shot", taskId: r.taskId, exchangeRouter: r.exchangeRouter, executionFeeWei: r.executionFeeWei, feeUsdc: r.feeUsdc }),
          ],
        );
        res.json(bigintJson({
          ok: true, ownerId, chainId: GMX_CHAIN_ID, account: r.exchangeRouter, taskId: r.taskId, status: "relayed", ticket, policy,
          truth: { result_tier: "GMX_MAINNET_RELAYED_1SHOT", venue: "gmx_v2", can_execute_real_money: true, source: "gmxOneShotExec → 1Shot relayer (EIP-7710, gas in USDC)", feeUsdc: r.feeUsdc },
        }));
        return;
      }
      const { GmxApiSdk, PrivateKeySigner } = getSdk();
      // Sign with the owner's own agent wallet (same account they fund) — not a shared backend key.
      const { privateKey } = await agentWalletKey(ownerId);
      const sdk = new GmxApiSdk({ chainId: GMX_CHAIN_ID });
      // rpcUrl + chain are required so the one-time on-chain USDC approval below can be sent.
      const signer = new PrivateKeySigner(privateKey, { rpcUrl: process.env.ARBITRUM_ONE_RPC_URL, chain: ARBITRUM_ONE_CHAIN });
      ticket.request.from = signer.address;
      // GMX v2 pulls collateral via its Router (plugin-transfer): the wallet must approve the canonical
      // GMX Router, NOT the Gelato relay router. buildApproveTransaction(spender:"router") encodes
      // approve(router, amount); we extract that router address and ensure a one-time max approval.
      const approveTpl = (await sdk.buildApproveTransaction({
        tokenAddress: USDC_ADDRESS,
        spender: "router",
        amount: MAX_UINT256,
      })) as { to: string; data: string };
      const gmxRouter = ("0x" + String(approveTpl.data).slice(34, 74)).toLowerCase();
      if (gmxRouter.length === 42) {
        const needed = parseAmountUnits(ticket.collateralUsd + 5, USDC_DECIMALS); // collateral + fee headroom
        const current = await erc20Allowance(USDC_ADDRESS, signer.address, gmxRouter);
        if (current < needed) {
          const approvalTx = (await sdk.executeErc20Approve(signer, {
            tokenAddress: USDC_ADDRESS,
            spender: gmxRouter,
            amount: MAX_UINT256,
          })) as unknown as string;
          await waitForApproval(approvalTx);
        }
      }
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
      console.error("[gmx/live/launch] failed:", (error as Error)?.message, "|", (error as Error)?.stack?.split("\n").slice(0, 3).join(" | "));
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
      const { privateKey: closeKey } = await agentWalletKey(ownerId);
      const signer = new PrivateKeySigner(closeKey);

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
