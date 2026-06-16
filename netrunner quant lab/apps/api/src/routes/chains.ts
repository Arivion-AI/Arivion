import express from "express";
import { chainRegistry, findChain, publicChain, realTraderEnabled } from "../config/chains.js";
import { db } from "../lib/db.js";
import { CHAINLINK_FEEDS, readChainlink, readChainlinkMany, readStockFeedMany, readFeed, STOCK_FEED_SYMBOLS } from "../lib/chainlink.js";
import { executeStockBuy, executeStockSell, executeLp, executeSwap, executeBridge, executionEnabled, agentWalletInfo, stockMarketState, testnetLaunchPreflight, buildTestnetLaunchPlan, executeTestnetLaunchPlan, listAgentAccounts } from "../lib/agentExec.js";
import { requireOwnerId } from "../lib/auth.js";

export function createChainsRouter(): express.Router {
  const router = express.Router();

  // Agent on-chain execution (TESTNET ONLY). The "launch" step that actually transacts.
  router.get("/api/exec/agent-wallet", async (req, res) => {
    try { res.json({ executionEnabled: executionEnabled(), ...(await agentWalletInfo(requireOwnerId(req))) }); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // A2A delegate accounts: the orchestrator + specialist agent addresses the user delegates to.
  // Addresses only — private keys never leave the backend. Lazily created on first read.
  router.get("/api/agents/accounts", async (req, res) => {
    try { res.json({ accounts: await listAgentAccounts(requireOwnerId(req)) }); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  router.get("/api/exec/stocks", async (req, res) => {
    try {
      const r = await stockMarketState(requireOwnerId(req));
      res.status(r.ok ? 200 : 503).json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });
  router.post("/api/exec/stock-buy", async (req, res) => {
    const symbol = String(req.body?.symbol ?? "");
    const usdgAmount = Number(req.body?.usdgAmount ?? req.body?.amount ?? 0);
    if (!symbol) { res.status(400).json({ error: "symbol required" }); return; }
    const r = await executeStockBuy(requireOwnerId(req), symbol, usdgAmount);
    res.status(r.ok ? 200 : 400).json(r);
  });
  router.post("/api/exec/stock-sell", async (req, res) => {
    const symbol = String(req.body?.symbol ?? "");
    const stockAmount = Number(req.body?.stockAmount ?? req.body?.amount ?? 0);
    if (!symbol) { res.status(400).json({ error: "symbol required" }); return; }
    const r = await executeStockSell(requireOwnerId(req), symbol, stockAmount);
    res.status(r.ok ? 200 : 400).json(r);
  });
  router.post("/api/exec/lp", async (req, res) => {
    const r = await executeLp(requireOwnerId(req), Number(req.body?.usdAmount ?? req.body?.amount ?? 0));
    res.status(r.ok ? 200 : 400).json(r);
  });
  router.post("/api/exec/swap", async (req, res) => {
    const r = await executeSwap(requireOwnerId(req), Number(req.body?.usdAmount ?? req.body?.amount ?? 0), req.body?.zeroForOne === true);
    res.status((r as { ok?: boolean }).ok ? 200 : 400).json(r);
  });
  router.post("/api/exec/bridge", async (req, res) => {
    const dir = req.body?.direction === "rh_to_arb" ? "rh_to_arb" : "arb_to_rh";
    const r = await executeBridge(requireOwnerId(req), Number(req.body?.amountUsd ?? req.body?.amount ?? 0), dir);
    res.status((r as { ok?: boolean }).ok ? 200 : 400).json(r);
  });
  router.post("/api/exec/launch-preflight", async (req, res) => {
    try {
      const r = await testnetLaunchPreflight(requireOwnerId(req), req.body ?? {});
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: "LAUNCH_PREFLIGHT_FAILED", detail: (e as Error).message });
    }
  });
  router.post("/api/exec/launch-preview", async (req, res) => {
    try {
      const r = await buildTestnetLaunchPlan(requireOwnerId(req), req.body ?? {});
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: "LAUNCH_PREVIEW_FAILED", detail: (e as Error).message });
    }
  });
  // LAUNCH a plan: flip from simulation to real testnet execution, executing each leg on-chain.
  router.post("/api/exec/launch-plan", async (req, res) => {
    try {
      const r = await executeTestnetLaunchPlan(requireOwnerId(req), req.body ?? {});
      res.status((r as { ok?: boolean }).ok ? 200 : executionEnabled() ? 400 : 403).json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: "LAUNCH_PLAN_FAILED", detail: (e as Error).message });
    }
  });

  // Real Chainlink Data Feeds (Arbitrum Sepolia). GET /api/chainlink lists all; /:symbol reads one.
  router.get("/api/chainlink", async (_req, res) => {
    const [crypto, stocks] = await Promise.all([
      readChainlinkMany(Object.keys(CHAINLINK_FEEDS)),
      readStockFeedMany(STOCK_FEED_SYMBOLS),
    ]);
    res.json({
      source: "chainlink", chainId: 421614,
      prices: crypto.prices, errors: crypto.errors, feeds: CHAINLINK_FEEDS,
      stocks: stocks.prices, stockErrors: stocks.errors, stockSymbols: STOCK_FEED_SYMBOLS,
      truth: {
        data_source: "chainlink",
        note: "Crypto: genuine Chainlink AggregatorV3 feeds on Arbitrum Sepolia. Equities: DualityStockVault AggregatorV3-compatible oracle on Robinhood Chain (Chainlink Data Streams stand-in — no native Chainlink equity feed exists on these testnets).",
      },
    });
  });
  router.get("/api/chainlink/:symbol", async (req, res) => {
    try {
      res.json(await readFeed(String(req.params.symbol))); // crypto → Chainlink, equity → vault stand-in
    } catch (e) {
      res.status(404).json({ error: "FEED_UNAVAILABLE", detail: (e as Error).message });
    }
  });

  router.get("/api/chains", (_req, res) => {
    res.json({
      chains: chainRegistry().map(publicChain),
      featureFlags: {
        dexData: process.env.DUALITY_ENABLE_DEX_DATA ?? "true",
        testnetActions: process.env.DUALITY_ENABLE_TESTNET_ACTIONS ?? "false",
        robinhoodTestnet: process.env.DUALITY_ENABLE_RH_TESTNET ?? "true",
        realTrader: process.env.DUALITY_ENABLE_REAL_TRADER ?? "false",
      },
      truth: {
        realMoneyExecutionEnabled: realTraderEnabled(),
        note: realTraderEnabled()
          ? "Arbitrum One GMX live trading is enabled only through the dedicated Quant Lab GMX Live route."
          : "Arbitrum One is market-data only until DUALITY_ENABLE_REAL_TRADER=true and a GMX signing key are configured.",
      },
    });
  });

  router.get("/api/chains/:chainId/health", async (req, res) => {
    const chainId = Number(req.params.chainId);
    const chain = findChain(chainId);
    if (!chain) return res.status(404).json({ error: "CHAIN_NOT_FOUND" });
    const started = Date.now();
    if (!chain.rpcUrl) {
      return res.json({ chain: publicChain(chain), rpc: "not_configured", latencyMs: null });
    }
    try {
      const response = await fetch(chain.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(3500),
      });
      const body = await response.json() as { result?: string; error?: unknown };
      const reported = body.result ? Number.parseInt(body.result, 16) : null;
      return res.status(response.ok && reported === chainId ? 200 : 502).json({
        chain: publicChain(chain),
        rpc: response.ok && reported === chainId ? "up" : "mismatch",
        reportedChainId: reported,
        latencyMs: Date.now() - started,
        error: body.error,
      });
    } catch (error) {
      return res.status(502).json({ chain: publicChain(chain), rpc: "down", latencyMs: Date.now() - started, error: (error as Error).message });
    }
  });

  router.get("/api/chains/:chainId/tokens", async (req, res) => {
    const chainId = Number(req.params.chainId);
    const chain = findChain(chainId);
    if (!chain) return res.status(404).json({ error: "CHAIN_NOT_FOUND" });
    const q = typeof req.query.q === "string" ? req.query.q.toLowerCase() : undefined;
    const kind = typeof req.query.kind === "string" ? req.query.kind.toLowerCase() : undefined;
    const params: unknown[] = [chainId];
    const where = ["chain_id = $1"];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(lower(symbol) LIKE $${params.length} OR lower(name) LIKE $${params.length} OR lower(address) LIKE $${params.length})`);
    }
    if (kind) {
      params.push(kind);
      where.push(`lower(asset_class) = $${params.length}`);
    }
    const r = await db.query(
      `
        SELECT chain_id, address, symbol, name, decimals, asset_class AS kind,
               underlying_symbol,
               is_testnet_asset AS is_test_asset,
               metadata_json, updated_at
        FROM token_registry
        WHERE ${where.join(" AND ")}
        ORDER BY is_test_asset DESC, kind, symbol
        LIMIT 250
      `,
      params
    );
    res.json({ chain: publicChain(chain), tokens: r.rows, count: r.rowCount });
  });

  return router;
}
