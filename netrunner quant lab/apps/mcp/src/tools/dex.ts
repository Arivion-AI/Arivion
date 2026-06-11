import { z } from "zod";
import { Registrar, textResult, summarize } from "./registry.js";
import { buildBody, dec, extraField, fullField } from "./shared.js";

export function registerDexTools(r: Registrar): void {
  const api = () => r.clients.api;
  const ctx = () => r.ctx();

  r.tool("chains", "list_chains", "List Duality chain registry, feature flags, and execution/data roles.", {},
    async () => textResult(await api().get("/api/chains", undefined, ctx())));
  r.tool("chains", "chainlink_price", "Read an on-chain USD price feed. Crypto (ETH/BTC/USDC/ARB/LINK/DAI/USDT) = GENUINE Chainlink AggregatorV3 on Arbitrum Sepolia. Equities (TSLA/AMZN/PLTR/NFLX/AMD) = DualityStockVault AggregatorV3-compatible stand-in on Robinhood Chain (source=chainlink_aggv3_standin; no native Chainlink equity feed exists on testnet). Omit symbol to list all crypto feeds + stocks.",
    { symbol: z.string().optional() },
    async (a) => textResult(await (a.symbol ? api().get(`/api/chainlink/${encodeURIComponent(String(a.symbol))}`, undefined, ctx()) : api().get("/api/chainlink", undefined, ctx()))));
  r.tool("chains", "chain_health", "Check one chain RPC health without exposing secrets.",
    { chainId: z.number().int() },
    async (a) => textResult(await api().get(`/api/chains/${encodeURIComponent(String(a.chainId))}/health`, undefined, ctx())));
  r.tool("chains", "list_tokens_on_chain", "List token registry entries for Arbitrum/RH testnet chains.",
    { chainId: z.number().int(), q: z.string().optional(), kind: z.string().optional(), full: fullField },
    async (a) => textResult(summarize(await api().get(`/api/chains/${encodeURIComponent(String(a.chainId))}/tokens`, buildBody(a, ["full", "chainId"]), ctx()), Boolean(a.full))));

  r.tool("dex", "list_dex_venues", "List indexed DEX venues by chain.", { chainId: z.number().int().optional(), full: fullField },
    async (a) => textResult(summarize(await api().get("/api/dex/venues", buildBody(a, ["full"]), ctx()), Boolean(a.full))));
  r.tool("dex", "list_dex_pools", "Search indexed DEX pools with latest snapshot/candle proof.",
    { chainId: z.number().int().optional(), venueId: z.string().optional(), token: z.string().optional(), q: z.string().optional(), limit: z.number().int().optional(), full: fullField },
    async (a) => textResult(summarize(await api().get("/api/dex/pools", buildBody(a, ["full"]), ctx()), Boolean(a.full))));
  r.tool("dex", "get_dex_candles", "Get DEX OHLCV candles for one pool.",
    { poolId: z.string(), interval: z.string().optional(), limit: z.number().int().optional(), full: fullField },
    async (a) => textResult(summarize(await api().get("/api/dex/candles", buildBody(a, ["full"]), ctx()), Boolean(a.full))));
  r.tool("dex", "get_dex_swaps", "Get recent swap prints for one pool.",
    { poolId: z.string(), limit: z.number().int().optional(), full: fullField },
    async (a) => textResult(summarize(await api().get("/api/dex/swaps", buildBody(a, ["full"]), ctx()), Boolean(a.full))));
  r.tool("dex", "get_dex_pool_snapshots", "Get recent reserve/liquidity snapshots for one pool.",
    { poolId: z.string(), limit: z.number().int().optional(), full: fullField },
    async (a) => textResult(summarize(await api().get("/api/dex/pool-snapshots", buildBody(a, ["full"]), ctx()), Boolean(a.full))));
  r.tool("dex", "quote_dex_swap", "Quote a modeled AMM swap. Always returns truth metadata; never implies real-money execution.",
    { poolId: z.string(), amountIn: dec, tokenIn: z.string().optional(), tokenOut: z.string().optional(), slippageBps: z.number().optional() },
    async (a) => textResult(await api().post("/api/dex/quote", buildBody(a), ctx())));
  r.tool("dex", "compare_bybit_dex", "Compare latest DEX pool price against a Bybit reference candle.",
    { poolId: z.string(), bybitSymbol: z.string().optional(), bybitCategory: z.string().optional(), interval: z.string().optional() },
    async (a) => textResult(await api().post("/api/dex/route/compare", buildBody(a), ctx())));
  r.tool("dex", "backfill_dex_pools", "Ask the ingestor to discover DEX pools for a chain/network.",
    { chainId: z.number().int().optional(), network: z.string().optional(), token: z.string().optional(), limit: z.number().int().optional(), extra: extraField },
    async (a) => textResult(await api().post("/api/dex/backfill/pools", buildBody(a), ctx())));
  r.tool("dex", "backfill_dex_swaps", "Backfill DEX swaps/candles for one pool.",
    { poolId: z.string(), network: z.string().optional(), days: z.number().int().optional(), aggregate: z.number().int().optional(), extra: extraField },
    async (a) => textResult(await api().post("/api/dex/backfill/swaps", buildBody(a), ctx())));
  r.tool("dex", "subscribe_dex_pool", "Add a DEX pool to the live poller.",
    { poolId: z.string(), network: z.string().optional(), cadenceSeconds: z.number().int().optional() },
    async (a) => textResult(await api().post("/api/dex/subscribe", buildBody(a), ctx())));
  r.tool("dex", "poll_dex_once", "Force one live DEX poll cycle.",
    { poolId: z.string().optional() },
    async (a) => textResult(await api().post("/api/dex/poll", buildBody(a), ctx())));

  // Liquidity-pool positions (the LP sleeve): Uniswap v3 Arbitrum via The Graph.
  r.tool("lp", "sync_lp_positions", "Sync a wallet's Uniswap v3 Arbitrum LP positions from the subgraph into Duality.",
    { wallet: z.string(), first: z.number().int().optional() },
    async (a) => textResult(await api().post("/api/dex/lp/sync", buildBody(a), ctx())));
  r.tool("lp", "list_lp_positions", "List stored LP positions for a wallet (pair, range, status).",
    { wallet: z.string().optional(), chainId: z.number().int().optional() },
    async (a) => textResult(await api().get("/api/dex/lp/positions", buildBody(a), ctx())));
  r.tool("lp", "value_lp_position", "Value an LP position (amounts, in-range, USD, collected fees) or a whole wallet. Truth-labeled.",
    { positionId: z.string().optional(), wallet: z.string().optional() },
    async (a) => textResult(await api().post("/api/dex/lp/value", buildBody(a), ctx())));
  r.tool("lp", "simulate_lp_range", "Simulate opening a concentrated LP position of capital_usd in a +/- range around the current price. Estimate, not a quote.",
    { poolId: z.string(), capitalUsd: dec, rangePct: dec.optional() },
    async (a) => textResult(await api().post("/api/dex/lp/simulate", buildBody(a), ctx())));

  // Single-deposit multiasset planner (tokens + tokenized stocks + LP).
  r.tool("portfolio", "plan_multiasset_portfolio",
    "Plan a single-deposit portfolio split across crypto tokens, tokenized stocks, and LP positions. Sizes each leg and simulates LP positions. Planning only — testnet-gated execution.",
    { depositUsd: dec, sleeves: z.record(z.any()), cryptoLegs: z.array(z.string()).optional(),
      stockLegs: z.array(z.string()).optional(), lpLegs: z.array(z.record(z.any())).optional(),
      weighting: z.string().optional() },
    async (a) => textResult(await api().post("/api/portfolio/multiasset/plan", buildBody(a), ctx())));
  r.tool("portfolio", "rebalance_multiasset_portfolio",
    "Given target USD allocations and current values, return rebalance trims/adds beyond a drift threshold.",
    { targets: z.array(z.record(z.any())), current: z.record(z.any()), thresholdPct: dec.optional() },
    async (a) => textResult(await api().post("/api/portfolio/multiasset/rebalance", buildBody(a), ctx())));

  r.tool("wallets", "list_wallets", "List wallet links for this owner.", {},
    async () => textResult(await api().get("/api/wallets", undefined, ctx())));
  r.tool("wallets", "prepare_wallet_nonce", "Create a SIWE-style nonce message for a wallet link.",
    { address: z.string(), chainId: z.number().int() },
    async (a) => textResult(await api().post("/api/wallets/nonce", buildBody(a), ctx())));
  r.tool("wallets", "verify_wallet_signature", "Verify wallet ownership and persist a wallet link.",
    { address: z.string(), chainId: z.number().int(), message: z.string(), signature: z.string() },
    async (a) => textResult(await api().post("/api/wallets/verify", buildBody(a), ctx())));
  r.tool("wallets", "wallet_balances", "Read native/ERC20 balances on supported testnet chains.",
    { address: z.string(), chainId: z.number().int() },
    async (a) => textResult(await api().get(`/api/wallets/${encodeURIComponent(String(a.address))}/balances`, { chainId: a.chainId }, ctx())));

  r.tool("testnet", "list_testnet_intents", "List prepared/submitted testnet intents for this owner.", {},
    async () => textResult(await api().get("/api/testnet/intents", undefined, ctx())));
  r.tool("testnet", "prepare_testnet_intent", "Prepare a testnet-only intent after policy checks. This does not submit a transaction.",
    { chainId: z.number().int(), walletAddress: z.string(), actionType: z.string().optional(), payload: z.record(z.any()).optional() },
    async (a) => textResult(await api().post("/api/testnet/intents/prepare", buildBody(a), ctx())));
  r.tool("testnet", "execute_stock_buy", "EXECUTE a real testnet stock buy on Robinhood Chain (46630): the agent wallet mints a tokenized stock (dTSLA/dAMZN/dPLTR/dNFLX/dAMD) against USDG at the oracle price. Real on-chain tx. Testnet-gated; the launch step of a stock plan.",
    { symbol: z.string(), usdgAmount: dec },
    async (a) => textResult(await api().post("/api/exec/stock-buy", buildBody(a), ctx())));
  r.tool("testnet", "execute_lp", "EXECUTE a real LP add on Arbitrum Sepolia (Duality AMM): the agent wallet mints both pool tokens and provides liquidity. usdAmount splits 50/50. Real on-chain tx.",
    { usdAmount: dec },
    async (a) => textResult(await api().post("/api/exec/lp", buildBody(a), ctx())));
  r.tool("testnet", "execute_swap", "EXECUTE a real swap on the Duality AMM (Arbitrum Sepolia). zeroForOne=true sells dWETH for dUSDC; default sells dUSDC for dWETH. Real on-chain tx.",
    { usdAmount: dec, zeroForOne: z.boolean().optional() },
    async (a) => textResult(await api().post("/api/exec/swap", buildBody(a), ctx())));
  r.tool("testnet", "execute_bridge", "Bridge stablecoin between Arbitrum Sepolia and Robinhood testnet (demo lock/mint: real burn on source + mint on dest). direction 'arb_to_rh' or 'rh_to_arb'. Keep amounts small. Use when a plan needs funds on the other chain.",
    { amountUsd: dec, direction: z.enum(["arb_to_rh", "rh_to_arb"]).optional() },
    async (a) => textResult(await api().post("/api/exec/bridge", buildBody(a), ctx())));
  r.tool("testnet", "launch_plan", "LAUNCH a composed plan: flip from simulation to REAL testnet execution, running each leg on-chain (stock buys on Robinhood, LP on Arbitrum). Pass legs:[{sleeve,symbol?,weight?,usd?}] + depositUsd. The final 'go live (testnet)' step.",
    { depositUsd: dec.optional(), legs: z.array(z.record(z.any())) },
    async (a) => textResult(await api().post("/api/exec/launch-plan", buildBody(a), ctx())));
  r.tool("testnet", "record_testnet_intent_submission", "Record a user-submitted testnet tx hash/receipt for an existing intent.",
    { intentId: z.string(), txHash: z.string().optional(), status: z.enum(["submitted", "confirmed", "failed", "cancelled"]).optional(), receipt: z.record(z.any()).optional() },
    async (a) => textResult(await api().post(`/api/testnet/intents/${encodeURIComponent(String(a.intentId))}/submit`, buildBody(a, ["intentId"]), ctx())));
}
