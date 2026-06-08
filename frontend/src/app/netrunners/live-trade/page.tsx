"use client";

import { useEffect, useMemo, useState } from "react";
import { Select } from "@/components/netrunners/Select";
import { TokenIcon } from "@/components/netrunners/TokenIcon";
import { SectionTitle, SparkAreaChart } from "@/components/netrunners/Visuals";
import { netrunnersGet, netrunnersPostResult } from "@/lib/netrunners/api";
import { connectInjectedWallet, hasInjectedWallet, switchOrAddChain, type WalletChain } from "@/lib/wallet/evm";

type GmxMarket = {
  symbol?: string;
  marketTokenAddress?: string;
  minPositionSizeUsd?: string;
  minCollateralUsd?: string;
  ticker?: {
    markPrice?: string;
    high24h?: string;
    low24h?: string;
    priceChangePercent24hBps?: string;
    longInterestUsd?: string;
    shortInterestUsd?: string;
    availableLiquidityLong?: string;
    availableLiquidityShort?: string;
    fundingRateLong?: string;
    fundingRateShort?: string;
    borrowingRateLong?: string;
    borrowingRateShort?: string;
  };
};

type GmxMarketsResponse = {
  chainId?: number;
  source?: string;
  markets?: GmxMarket[];
  policy?: { canSubmit?: boolean; errors?: string[]; warnings?: string[]; requiredEnv?: string[] };
  truth?: Record<string, unknown>;
};

type ChainsResponse = {
  chains?: WalletChain[];
  featureFlags?: Record<string, string>;
};

type GmxTicket = {
  symbol?: string;
  direction?: string;
  orderType?: string;
  collateralUsd?: number;
  leverage?: number;
  sizeUsd?: number;
  slippageBps?: number;
  triggerPriceUsd?: number;
  strategyId?: string;
  botType?: string;
  risk?: { maxCollateralUsd?: number; maxLeverage?: number; warnings?: string[] };
  docs?: { orderLifecycle?: string; statusTerminal?: string[] };
};

type PrepareResponse = {
  ok?: boolean;
  ticket?: GmxTicket;
  policy?: { canPrepare?: boolean; canSubmit?: boolean; errors?: string[]; warnings?: string[]; requiredEnv?: string[] };
  error?: string;
  detail?: unknown;
};

type AccountResponse = {
  positions?: unknown[];
  orders?: unknown[];
  trades?: { trades?: unknown[] } | unknown[];
  balances?: unknown;
  error?: string;
  detail?: string;
};

const STRATEGIES = [
  { value: "gmx_trend_perp", label: "Trend EMA perp", hint: "momentum" },
  { value: "gmx_funding_carry", label: "Funding carry", hint: "carry" },
  { value: "gmx_breakout_guard", label: "Breakout guard", hint: "risk" },
  { value: "manual_order", label: "Manual order", hint: "one shot" },
];

const BOTS = [
  { value: "none", label: "No bot", hint: "one-shot" },
  { value: "threshold_or_time", label: "Threshold or time rebalance", hint: "Bot OS" },
  { value: "drawdown_guard", label: "Drawdown guard", hint: "kill switch" },
  { value: "funding_rotation", label: "Funding rotation", hint: "carry bot" },
];

function compactUsd(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "--";
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n / 1e30)}`;
}

function priceUsd(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "--";
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n / 1e30)}`;
}

function bps(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "--";
  return `${(n / 100).toFixed(2)}%`;
}

function rate(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "--";
  return `${(n / 1e28).toFixed(2)}%`;
}

function baseOf(symbol: string): string {
  return symbol.replace(/\[[^\]]+\]/g, "").replace(/\/USD.*/i, "").trim().toUpperCase();
}

function statusText(prep: PrepareResponse | null, markets: GmxMarketsResponse | null): string {
  const errors = prep?.policy?.errors ?? markets?.policy?.errors ?? [];
  if (!errors.length) return "GMX mainnet submit path armed";
  if (errors.includes("REAL_TRADER_DISABLED")) return "Ready but blocked by DUALITY_ENABLE_REAL_TRADER";
  if (errors.includes("AGENT_GMX_PRIVATE_KEY_MISSING")) return "Ready but missing AGENT_GMX_PRIVATE_KEY";
  return errors.join(" / ");
}

export default function LiveTradePage() {
  const [markets, setMarkets] = useState<GmxMarketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [symbol, setSymbol] = useState("ETH/USD [WETH-USDC]");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [collateralUsd, setCollateralUsd] = useState("25");
  const [leverage, setLeverage] = useState("1.5");
  const [slippageBps, setSlippageBps] = useState("30");
  const [triggerPriceUsd, setTriggerPriceUsd] = useState("");
  const [strategyId, setStrategyId] = useState("gmx_trend_perp");
  const [botType, setBotType] = useState("none");
  const [confirmText, setConfirmText] = useState("");
  const [prepare, setPrepare] = useState<PrepareResponse | null>(null);
  const [launchResult, setLaunchResult] = useState<PrepareResponse | Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [wallet, setWallet] = useState("");
  const [walletStatus, setWalletStatus] = useState(hasInjectedWallet() ? "Wallet available" : "No injected wallet");
  const [account, setAccount] = useState<AccountResponse | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    netrunnersGet<GmxMarketsResponse>("/api/gmx/live/markets?limit=160").then((r) => {
      if (!mounted) return;
      setMarkets(r);
      const first = r?.markets?.find((m) => String(m.symbol ?? "").startsWith("ETH/USD")) ?? r?.markets?.[0];
      if (first?.symbol) setSymbol(first.symbol);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, []);

  const marketOptions = useMemo(() => {
    return (markets?.markets ?? []).map((m) => ({
      value: String(m.symbol ?? ""),
      label: String(m.symbol ?? ""),
      icon: <TokenIcon symbol={baseOf(String(m.symbol ?? ""))} pair={false} size={18} />,
      hint: compactUsd(m.ticker?.longInterestUsd),
    }));
  }, [markets]);

  const selected = useMemo(() => (markets?.markets ?? []).find((m) => m.symbol === symbol), [markets, symbol]);
  const chartPoints = useMemo(() => {
    const mark = Number(selected?.ticker?.markPrice ?? 0) / 1e30 || 100;
    const high = Number(selected?.ticker?.high24h ?? 0) / 1e30 || mark * 1.02;
    const low = Number(selected?.ticker?.low24h ?? 0) / 1e30 || mark * 0.98;
    const mid = (high + low) / 2;
    const vals = [low, mid * 0.998, mark * 0.996, mid, mark * 1.002, high * 0.997, mark];
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return vals.map((v, i) => ({ x: (i / (vals.length - 1)) * 600, y: 20 + (1 - (v - min) / ((max - min) || 1)) * 120 }));
  }, [selected]);

  const payload = useMemo(() => ({
    symbol,
    direction,
    orderType,
    collateralUsd: Number(collateralUsd),
    leverage: Number(leverage),
    slippageBps: Number(slippageBps),
    triggerPriceUsd: orderType === "limit" && triggerPriceUsd ? Number(triggerPriceUsd) : undefined,
    strategyId,
    botType: botType === "none" ? undefined : botType,
  }), [symbol, direction, orderType, collateralUsd, leverage, slippageBps, triggerPriceUsd, strategyId, botType]);

  async function prepareTicket() {
    setBusy(true);
    setLaunchResult(null);
    const r = await netrunnersPostResult<PrepareResponse, typeof payload>("/api/gmx/live/prepare", payload);
    setPrepare(r.data ?? { ok: false, error: `HTTP ${r.status}` });
    setBusy(false);
  }

  async function launch() {
    setBusy(true);
    const r = await netrunnersPostResult<Record<string, unknown>, typeof payload & { confirm: string }>("/api/gmx/live/launch", {
      ...payload,
      confirm: confirmText,
    });
    setLaunchResult(r.data ?? { ok: false, error: `HTTP ${r.status}` });
    setBusy(false);
  }

  async function connectArbitrum() {
    setWalletStatus("Switching to Arbitrum One");
    const chains = await netrunnersGet<ChainsResponse>("/api/chains");
    const arb = chains?.chains?.find((c) => c.chainId === 42161) ?? {
      chainId: 42161,
      name: "Arbitrum One",
      nativeCurrency: { symbol: "ETH", decimals: 18 },
      explorerUrl: "https://arbiscan.io",
    };
    try {
      await switchOrAddChain(arb);
      const address = await connectInjectedWallet();
      setWallet(address);
      setWalletStatus(`Connected ${address.slice(0, 6)}...${address.slice(-4)}`);
      const state = await netrunnersGet<AccountResponse>(`/api/gmx/live/account?address=${encodeURIComponent(address)}`);
      setAccount(state);
    } catch (error) {
      setWalletStatus((error as Error).message);
    }
  }

  const policyErrors = prepare?.policy?.errors ?? markets?.policy?.errors ?? [];
  const policyWarnings = [...(prepare?.policy?.warnings ?? []), ...(prepare?.ticket?.risk?.warnings ?? [])];
  const canLaunch = confirmText === "LAUNCH_GMX_MAINNET" && !busy;

  return (
    <>
      <section className="nt-card navy nt-grid-bg live-trade-hero" style={{ gridColumn: "1 / 13" }}>
        <SectionTitle
          endpoint="@gmx-io/sdk/v2 · Arbitrum 42161"
          title="GMX Live Trade Launcher"
          right={<span className={`nt-tag ${policyErrors.length ? "warn" : ""}`}>{statusText(prepare, markets)}</span>}
        />
        <div className="live-trade-hero-grid">
          <div>
            <p className="nt-footer-note" style={{ marginTop: 0 }}>
              Launch strategies and Bot OS configs into GMX from Quant Lab only. This page uses GMX SDK v2 market reads and express-order lifecycle: prepare, sign, submit, then poll request status.
            </p>
            <div className="live-trade-proof">
              <span>chain Arbitrum One</span>
              <span>collateral USDC</span>
              <span>mode express</span>
              <span>orders gated</span>
            </div>
          </div>
          <div className="live-trade-wallet">
            <button className="nt-btn orange" onClick={connectArbitrum}>Connect Arbitrum wallet</button>
            <div className="mono">{walletStatus}</div>
            {wallet ? <div className="mono live-address">{wallet}</div> : null}
          </div>
        </div>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "1 / 4" }}>
        <SectionTitle endpoint="GMX market" title="Market" />
        <div className="nt-field">
          <label>market</label>
          <Select value={symbol} onChange={setSymbol} options={marketOptions.length ? marketOptions : [{ value: symbol, label: loading ? "Loading GMX markets..." : symbol }]} />
        </div>
        <div className="live-market-card">
          <TokenIcon symbol={baseOf(symbol)} pair={false} size={38} />
          <div>
            <div className="dsp">{baseOf(symbol)} perpetual</div>
            <div className="mono">{symbol}</div>
          </div>
        </div>
        <div className="nt-metric-row live-mini-metrics">
          <div className="nt-metric"><div className="m-l">mark</div><div className="m-v">{priceUsd(selected?.ticker?.markPrice)}</div></div>
          <div className="nt-metric"><div className="m-l">24h</div><div className="m-v">{bps(selected?.ticker?.priceChangePercent24hBps)}</div></div>
          <div className="nt-metric"><div className="m-l">long OI</div><div className="m-v">{compactUsd(selected?.ticker?.longInterestUsd)}</div></div>
          <div className="nt-metric"><div className="m-l">short OI</div><div className="m-v">{compactUsd(selected?.ticker?.shortInterestUsd)}</div></div>
        </div>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "4 / 9" }}>
        <SectionTitle endpoint="launch ticket" title="Strategy + Bot Config" />
        <div className="nt-grid-2">
          <div className="nt-field"><label>strategy</label><Select value={strategyId} onChange={setStrategyId} options={STRATEGIES} /></div>
          <div className="nt-field"><label>bot</label><Select value={botType} onChange={setBotType} options={BOTS} /></div>
          <div className="nt-field"><label>side</label><Select value={direction} onChange={(v) => setDirection(v as "long" | "short")} options={[{ value: "long", label: "Long" }, { value: "short", label: "Short" }]} /></div>
          <div className="nt-field"><label>order type</label><Select value={orderType} onChange={(v) => setOrderType(v as "market" | "limit")} options={[{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }]} /></div>
          <div className="nt-field"><label>collateral USD</label><input className="nt-input" value={collateralUsd} onChange={(e) => setCollateralUsd(e.target.value)} /></div>
          <div className="nt-field"><label>leverage</label><input className="nt-input" value={leverage} onChange={(e) => setLeverage(e.target.value)} /></div>
          <div className="nt-field"><label>slippage bps</label><input className="nt-input" value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} /></div>
          <div className="nt-field"><label>limit trigger</label><input className="nt-input" disabled={orderType !== "limit"} value={triggerPriceUsd} onChange={(e) => setTriggerPriceUsd(e.target.value)} placeholder="only for limit" /></div>
        </div>
        <div className="live-ticket-summary">
          <div><span>position size</span><b>${prepare?.ticket?.sizeUsd?.toFixed?.(2) ?? (Number(collateralUsd) * Number(leverage || 0)).toFixed(2)}</b></div>
          <div><span>collateral</span><b>${Number(collateralUsd || 0).toFixed(2)} USDC</b></div>
          <div><span>strategy</span><b>{strategyId}</b></div>
          <div><span>bot</span><b>{botType === "none" ? "one-shot" : botType}</b></div>
        </div>
        <button className="nt-btn orange" style={{ width: "100%", marginTop: 12 }} disabled={busy} onClick={prepareTicket}>
          {busy ? "Preparing..." : "Prepare GMX Launch Ticket"}
        </button>
      </section>

      <section className="nt-card cream" style={{ gridColumn: "9 / 13" }}>
        <SectionTitle endpoint="risk + account" title="Preflight" dark />
        <div className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}>
          <SparkAreaChart points={chartPoints} height={150} stroke="var(--orange-deep)" />
        </div>
        <div className="live-preflight-list">
          <div><span>funding long</span><b>{rate(selected?.ticker?.fundingRateLong)}</b></div>
          <div><span>funding short</span><b>{rate(selected?.ticker?.fundingRateShort)}</b></div>
          <div><span>liq availability long</span><b>{compactUsd(selected?.ticker?.availableLiquidityLong)}</b></div>
          <div><span>liq availability short</span><b>{compactUsd(selected?.ticker?.availableLiquidityShort)}</b></div>
        </div>
        {policyErrors.length ? <div className="nt-alert danger" style={{ marginTop: 10 }}>{policyErrors.join(" / ")}</div> : <div className="nt-alert" style={{ marginTop: 10, color: "var(--teal)" }}>Policy checks clear.</div>}
        {policyWarnings.length ? <div className="nt-alert warn" style={{ marginTop: 8 }}>{policyWarnings.join(" / ")}</div> : null}
      </section>

      <section className="nt-card navy" style={{ gridColumn: "1 / 8" }}>
        <SectionTitle endpoint="prepare -> sign -> submit" title="Launch Control" />
        <div className="nt-grid-2">
          <div className="nt-box">
            <div className="nt-eyebrow">prepared ticket</div>
            <pre className="nt-code live-code">{prepare?.ticket ? JSON.stringify(prepare.ticket, null, 2) : "Prepare a ticket to inspect exact GMX request, caps, lifecycle and status terminal states."}</pre>
          </div>
          <div className="nt-box">
            <div className="nt-eyebrow">mainnet confirmation</div>
            <p className="nt-footer-note" style={{ marginTop: 4 }}>
              Type LAUNCH_GMX_MAINNET to broadcast. If backend env gates are off, launch returns the exact blocker and does not submit.
            </p>
            <input className="nt-input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="LAUNCH_GMX_MAINNET" />
            <button className="nt-btn orange" style={{ width: "100%", marginTop: 10 }} disabled={!canLaunch} onClick={launch}>Broadcast GMX Express Order</button>
            <pre className="nt-code live-code small">{launchResult ? JSON.stringify(launchResult, null, 2) : "No launch attempt yet."}</pre>
          </div>
        </div>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "8 / 13" }}>
        <SectionTitle endpoint="fetchPositionsInfo + fetchOrders" title="Wallet State" />
        {!wallet ? (
          <div className="nt-box"><span className="mono" style={{ color: "var(--muted)" }}>Connect an Arbitrum wallet to read live GMX positions, active orders, trades and balances.</span></div>
        ) : account?.error ? (
          <div className="nt-alert danger">{account.error} {account.detail ?? ""}</div>
        ) : (
          <div className="nt-grid-2">
            <div className="nt-metric"><div className="m-l">positions</div><div className="m-v">{account?.positions?.length ?? 0}</div></div>
            <div className="nt-metric"><div className="m-l">orders</div><div className="m-v">{account?.orders?.length ?? 0}</div></div>
            <div className="nt-metric"><div className="m-l">trades</div><div className="m-v">{Array.isArray(account?.trades) ? account?.trades.length : (account?.trades?.trades?.length ?? 0)}</div></div>
            <div className="nt-metric"><div className="m-l">wallet</div><div className="m-v">{wallet.slice(0, 6)}...{wallet.slice(-4)}</div></div>
          </div>
        )}
        <pre className="nt-code live-code small" style={{ marginTop: 12 }}>{account ? JSON.stringify(account, null, 2).slice(0, 3000) : "GMX account state appears here after wallet connect."}</pre>
      </section>
    </>
  );
}
