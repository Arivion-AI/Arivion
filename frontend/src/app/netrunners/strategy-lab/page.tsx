"use client";

import { useEffect, useMemo, useState } from "react";
import { SectionTitle, SparkAreaChart } from "@/components/netrunners/Visuals";
import { SymbolPicker, type SymbolMeta } from "@/components/netrunners/SymbolPicker";
import { Select } from "@/components/netrunners/Select";
import {
  netrunnersGet,
  netrunnersPost,
  getCandlesEnsured,
  seriesToPoints,
  fmtPct,
  fmtUsd,
  type PaperRuntimeResult,
} from "@/lib/netrunners/api";

type StrategyRow = {
  id: string;
  name: string;
  description: string;
  params: Record<string, unknown>;
};

type RegistryResponse = { strategies?: StrategyRow[] };
type DexCandleResponse = {
  candles?: Array<{ ts: number; open: string; high: string; low: string; close: string; volume_usd?: string; volume0?: string }>;
};
type DexPool = {
  pool_id: string;
  chain_id: number;
  venue_id?: string;
  venue_name?: string;
  token0_symbol?: string;
  token1_symbol?: string;
};

const DEFAULT_STRATEGIES: StrategyRow[] = [
  { id: "trend_ema_cross", name: "Trend EMA Cross", description: "Fast/slow EMA cross with ATR trailing stop.", params: { ema_fast: 20, ema_slow: 50, atr_len: 14, order_qty: "0.1", trail_atr_mult: "3.0" } },
  { id: "pmm", name: "Pure Market Maker", description: "Bid/ask quotes with inventory skew.", params: { bid_spread_bps: 5, ask_spread_bps: 5, order_qty: "0.01", max_inventory_qty: "1.0" } },
  { id: "grid", name: "Static Grid", description: "Range grid execution with approximate fills.", params: { spacing_bps: 30, num_levels: 5, qty_per_level: "0.01", refresh_each_bar: false } },
];

const VIP_TIERS = ["NONVIP", "VIP1", "VIP2", "VIP3", "PRO1", "PRO3"];

function coerce(original: unknown, raw: string): unknown {
  if (typeof original === "boolean") return raw === "true";
  if (typeof original === "number") return raw === "" ? 0 : Number(raw);
  return raw; // keep decimals as strings (engine uses Decimal)
}

export default function StrategyLabPage() {
  const [strategies, setStrategies] = useState<StrategyRow[]>(DEFAULT_STRATEGIES);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_STRATEGIES[0].id);
  const [paramOverrides, setParamOverrides] = useState<Record<string, string>>({});
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [category, setCategory] = useState("linear");
  const [assetMeta, setAssetMeta] = useState<SymbolMeta | null>(null);
  const [dataSource, setDataSource] = useState<"bybit" | "dex" | "testnet">("bybit");
  const [dexPools, setDexPools] = useState<DexPool[]>([]);
  const [selectedPoolId, setSelectedPoolId] = useState("");
  const [executionFidelity, setExecutionFidelity] = useState("bar_based");
  const [venueExact, setVenueExact] = useState(false);
  const [vipTier, setVipTier] = useState("NONVIP");

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Idle · pick a strategy and run a backtest on real candles.");
  const [result, setResult] = useState<PaperRuntimeResult | null>(null);

  useEffect(() => {
    let mounted = true;
    netrunnersGet<RegistryResponse>("/api/strategies/registry").then((registry) => {
      if (mounted && registry?.strategies?.length) {
        setStrategies(registry.strategies);
        setSelectedId(registry.strategies[0].id);
      }
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    netrunnersGet<{ pools?: DexPool[] }>("/api/dex/pools?chainId=42161&limit=60").then((r) => {
      if (!mounted) return;
      const rows = r?.pools ?? [];
      setDexPools(rows);
      setSelectedPoolId((current) => current || rows[0]?.pool_id || "");
    });
    return () => { mounted = false; };
  }, []);

  const selected = useMemo(
    () => strategies.find((s) => s.id === selectedId) ?? strategies[0],
    [strategies, selectedId],
  );
  const baseParams = selected?.params ?? {};
  const paramEntries = Object.entries(baseParams);

  function paramValue(key: string): string {
    if (key in paramOverrides) return paramOverrides[key];
    const v = baseParams[key];
    return typeof v === "boolean" ? String(v) : typeof v === "number" ? String(v) : String(v ?? "");
  }

  async function runBacktest() {
    setRunning(true);
    setResult(null);
    if (dataSource === "testnet") {
      setStatus("Testnet assets are wallet/intent-only in this phase. Link a wallet and prepare a testnet intent; do not backtest them as production assets.");
      setRunning(false);
      return;
    }
    const interval = dataSource === "dex" ? "hour" : category === "spot" ? "D" : "60";
    setStatus(dataSource === "dex"
      ? `Fetching DEX candles for ${selectedPoolId || assetMeta?.pool_id || "selected pool"} ...`
      : `Fetching candles for ${symbol} (auto-backfilling from Bybit if needed) ...`);
    const poolId = assetMeta?.pool_id || selectedPoolId;
    const bars = dataSource === "dex"
      ? ((await netrunnersGet<DexCandleResponse>(`/api/dex/candles?poolId=${encodeURIComponent(poolId)}&interval=${interval}&limit=240`))?.candles ?? []).map((b) => ({
          ts: b.ts,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume_usd ?? b.volume0 ?? "0",
        }))
      : await getCandlesEnsured(symbol, category, interval, 120);
    if (bars.length < 30) {
      setStatus(dataSource === "dex" ? `Selected DEX pool has only ${bars.length} ${interval} candles. Run DEX backfill from Data first.` : `${symbol} has no Bybit ${interval} candle data available (got ${bars.length}).`);
      setRunning(false);
      return;
    }

    const strategy_params: Record<string, unknown> = {};
    for (const [k, v] of paramEntries) strategy_params[k] = k in paramOverrides ? coerce(v, paramOverrides[k]) : v;

    const payload: Record<string, unknown> = {
      symbol,
      strategy_id: selected.id,
      strategy_params,
      starting_equity: "10000",
      bars,
      fee_bps_taker: "5.5",
      fee_bps_maker: "1.0",
      slippage_bps_one_way: "2.0",
      interval_minutes: interval === "D" ? 1440 : 60,
      risk: { max_position_fraction: "1.0", max_total_exposure_fraction: "3.0" },
    };
    if (dataSource === "dex") {
      const pool = dexPools.find((p) => p.pool_id === poolId);
      payload.data_source = "dex";
      payload.venue = pool?.venue_id ?? "dex";
      payload.chain_id = pool?.chain_id ?? assetMeta?.chain_id ?? 42161;
      payload.pool_id = poolId;
      payload.route = [{ pool_id: poolId, venue: pool?.venue_id ?? assetMeta?.venue_id ?? "dex" }];
      payload.execution_fidelity = executionFidelity;
      payload.honesty_required = true;
      payload.allow_data_blending = false;
    }
    if (venueExact && dataSource === "bybit") {
      payload.venue_exact = true;
      payload.category = category;
      payload.vip_tier = vipTier;
      payload.instrument_filter = category === "linear"
        ? { tick_size: "0.1", qty_step: "0.001", min_order_qty: "0.001", min_notional: "5" }
        : { tick_size: "0.01", qty_step: "0.0001", min_order_qty: "0.0001", min_notional: "1" };
    }

    setStatus(`Running ${selected.id} on ${bars.length} ${dataSource === "dex" ? "DEX" : "Bybit"} bars ...`);
    const r = await netrunnersPost<PaperRuntimeResult, typeof payload>("/api/paper/runtime/run", payload);
    if (!r) {
      setStatus("Run failed: worker/API unreachable.");
      setRunning(false);
      return;
    }
    if (r.error) {
      setStatus(`Run failed: ${r.error}`);
      setRunning(false);
      return;
    }
    setResult(r);
    setStatus(`Completed · ${bars.length} bars · ${(r.fills ?? []).length} fills`);
    setRunning(false);
  }

  const perf = result?.performance;
  const equityPoints = useMemo(
    () => seriesToPoints(result?.equity_curve ?? [], 170),
    [result],
  );
  const ledger = (result?.events ?? []).slice(-8).reverse();
  const fillModel = result?.fill_model as Record<string, unknown> | undefined;
  const venue = result?.venue as Record<string, unknown> | undefined;
  const truthCard = result?.truth_card as Record<string, unknown> | undefined;
  const finalEquity = result?.final_equity ? Number(result.final_equity) : undefined;
  const selectedPool = dexPools.find((pool) => pool.pool_id === selectedPoolId);

  return (
    <>
      <section className="nt-card navy nt-grid-bg" style={{ gridColumn: "1 / 4" }}>
        <SectionTitle endpoint="GET /api/strategies/registry" title="Algo Library" />
        <div className="nt-grid-2">
          {strategies.map((strategy) => (
            <button
              key={strategy.id}
              type="button"
              onClick={() => { setSelectedId(strategy.id); setParamOverrides({}); }}
              className="nt-box"
              style={{
                textAlign: "left", cursor: "pointer",
                borderColor: selectedId === strategy.id ? "var(--orange)" : "var(--navy-line)",
                background: selectedId === strategy.id ? "linear-gradient(180deg,#2d2150,#241b40)" : "var(--navy-2)",
              }}
            >
              <div className="dsp" style={{ fontSize: "14px", letterSpacing: "0.04em", color: "var(--white)" }}>{strategy.id}</div>
              <div className="mono" style={{ fontSize: "9px", color: "var(--muted)", marginTop: "4px", textTransform: "uppercase", letterSpacing: "0.08em" }}>{strategy.description}</div>
            </button>
          ))}
        </div>
        <div className="nt-field" style={{ marginTop: "18px" }}>
          <label>Asset / Symbol · Bybit + DEX + testnet</label>
          <SymbolPicker value={symbol} onChange={(sym, meta) => {
            setSymbol(sym);
            setAssetMeta(meta ?? null);
            setDataSource(meta?.data_source ?? "bybit");
            if (meta?.pool_id) setSelectedPoolId(meta.pool_id);
            setCategory(meta?.category && meta.category !== "dex" && meta.category !== "testnet" ? meta.category : (sym.endsWith("XUSDT") ? "spot" : "linear"));
            setExecutionFidelity(meta?.data_source === "dex" ? "amm_quote_snapshot" : "bar_based");
          }} />
        </div>
        <div className="nt-grid-2">
          <div className="nt-field">
            <label>data source</label>
            <Select value={dataSource} onChange={(v) => setDataSource(v as "bybit" | "dex" | "testnet")} options={[
              { value: "bybit", label: "Bybit" },
              { value: "dex", label: "Arbitrum DEX" },
              { value: "testnet", label: "Testnet intent" },
            ]} />
          </div>
          <div className="nt-field">
            <label>fill model</label>
            <Select value={executionFidelity} onChange={setExecutionFidelity} options={[
              { value: "bar_based", label: "bar_based" },
              { value: "amm_mid_only", label: "amm_mid_only" },
              { value: "amm_quote_snapshot", label: "amm_quote_snapshot" },
              { value: "amm_swap_replay", label: "amm_swap_replay" },
            ]} disabled={dataSource === "testnet"} />
          </div>
        </div>
        {dataSource === "dex" && (
          <div className="nt-field">
            <label>dex pool</label>
            <Select value={selectedPoolId} onChange={setSelectedPoolId} options={(dexPools.length ? dexPools : [{ pool_id: "", chain_id: 42161, token0_symbol: "No", token1_symbol: "pools" }]).map((pool) => ({
              value: pool.pool_id,
              label: `${pool.token0_symbol ?? "TOKEN0"}/${pool.token1_symbol ?? "TOKEN1"}`,
              hint: pool.venue_name ?? "DEX",
            }))} />
          </div>
        )}
        {dataSource === "testnet" && (
          <div className="nt-alert warn">Testnet tokens can prepare wallet intents only. They are excluded from production rankings and real-money execution.</div>
        )}
        <div className="nt-box">
          <div className="nt-eyebrow">Bybit-Exactness (venue layer)</div>
          <label className="mono" style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "8px", fontSize: "11px", color: "var(--white)" }}>
            <input type="checkbox" checked={venueExact} onChange={(e) => setVenueExact(e.target.checked)} />
            venue_exact · instrument filters + tiered fees
          </label>
          {venueExact && dataSource === "bybit" && (
            <div className="nt-field" style={{ marginTop: "8px" }}>
              <label>vip_tier</label>
              <Select value={vipTier} onChange={setVipTier} options={VIP_TIERS.map((t) => ({ value: t, label: t }))} />
            </div>
          )}
        </div>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "4 / 9" }}>
        <SectionTitle endpoint={`strategy_params · ${selected?.id ?? "strategy"}`} title="Parameters"
          right={<span className="nt-tag" style={{ color: "var(--orange)" }}>EDITABLE</span>} />
        <div className="nt-grid-2">
          {paramEntries.map(([key, value]) => (
            <div className="nt-field" key={key}>
              <label>{key}</label>
              {typeof value === "boolean" ? (
                <Select value={paramValue(key)} onChange={(v) => setParamOverrides((p) => ({ ...p, [key]: v }))} options={[{ value: "true", label: "true" }, { value: "false", label: "false" }]} />
              ) : (
                <input className="nt-input" value={paramValue(key)} onChange={(e) => setParamOverrides((p) => ({ ...p, [key]: e.target.value }))} />
              )}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: "10px", marginTop: "20px", flexWrap: "wrap", alignItems: "center" }}>
          <button className="nt-btn ghost" onClick={() => setParamOverrides({})}>Reset Params</button>
          <button className="nt-btn orange" style={{ marginLeft: "auto" }} disabled={running} onClick={runBacktest}>
            {running ? "Running …" : "▶ Run Backtest"}
          </button>
        </div>
        <div className="nt-footer-note">{status}</div>
      </section>

      <section className="nt-card cream" style={{ gridColumn: "9 / 13" }}>
        <SectionTitle endpoint="fill_model · honesty flags" title="Execution Realism" dark />
        {fillModel ? (
          <div className="nt-code" style={{ fontSize: "10px" }}>
            {`l2_aware: ${fillModel.l2_aware}
bar_based: ${fillModel.bar_based}
maker_fills: ${fillModel.maker_fills}
maker_optimistic: ${fillModel.maker_fills_optimistic}
maker_participation_rate: ${fillModel.maker_participation_rate}
market_impact_coef: ${fillModel.market_impact_coef}`}
          </div>
        ) : (
          <div className="nt-code" style={{ fontSize: "10px" }}>Run a backtest to populate the fill-model honesty flags.</div>
        )}
        <div className="nt-eyebrow dk" style={{ margin: "14px 0 8px" }}>Venue</div>
        {truthCard ? (
          <div className="nt-code" style={{ fontSize: "10px", marginBottom: 12 }}>
            {`result_tier: ${truthCard.result_tier ?? "--"}
data_source: ${truthCard.data_source ?? dataSource}
execution_fidelity: ${truthCard.execution_fidelity ?? executionFidelity}
can_execute_real_money: ${truthCard.can_execute_real_money ?? false}
pool_id: ${truthCard.pool_id ?? selectedPool?.pool_id ?? "--"}`}
          </div>
        ) : null}
        {venue ? (
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <span className="nt-tag" style={{ color: "var(--orange-deep)" }}>{venue.venue_exact ? "VENUE-EXACT" : "GENERIC"}</span>
            {venue.vip_tier ? <span className="nt-tag" style={{ color: "#7a7a72" }}>{String(venue.vip_tier)}</span> : null}
            <span className="nt-tag" style={{ color: "#7a7a72" }}>maker {String(venue.fee_bps_maker)}bps</span>
            <span className="nt-tag" style={{ color: "#7a7a72" }}>taker {String(venue.fee_bps_taker)}bps</span>
          </div>
        ) : (
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <span className="nt-tag" style={{ color: "var(--orange-deep)" }}>✓ NO-LOOKAHEAD</span>
            <span className="nt-tag" style={{ color: "var(--orange-deep)" }}>✓ DETERMINISTIC</span>
          </div>
        )}
      </section>

      <section className="nt-card navy nt-grid-bg" style={{ gridColumn: "1 / 9" }}>
        <SectionTitle endpoint="POST /api/paper/runtime/run" title="Backtest Result"
          right={<span className="nt-tag" style={{ color: "var(--orange)" }}>{fillModel?.liquidity_free_upper_bound ? "⚠ liquidity-free upper bound" : "real fills"}</span>} />
        <div className="nt-box ink">
          <SparkAreaChart points={equityPoints} stroke={finalEquity && finalEquity >= 10000 ? "var(--teal)" : "var(--red)"} />
        </div>
        <div className="nt-metric-row">
          <div className="nt-metric"><div className="m-l">final_equity</div><div className="m-v" style={{ color: "var(--teal)" }}>{finalEquity !== undefined ? fmtUsd(finalEquity) : "--"}</div></div>
          <div className="nt-metric"><div className="m-l">total_return</div><div className="m-v" style={{ color: (perf?.total_return ?? 0) >= 0 ? "var(--teal)" : "var(--red)" }}>{fmtPct(perf?.total_return)}</div></div>
          <div className="nt-metric"><div className="m-l">sharpe</div><div className="m-v">{perf?.sharpe?.toFixed(2) ?? "--"}</div></div>
          <div className="nt-metric"><div className="m-l">max_dd</div><div className="m-v" style={{ color: "var(--red)" }}>{fmtPct(perf?.max_drawdown)}</div></div>
          <div className="nt-metric"><div className="m-l">fills</div><div className="m-v">{(result?.fills ?? []).length}</div></div>
        </div>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "9 / 13" }}>
        <SectionTitle endpoint="result.events" title="Event Ledger" />
        <div className="nt-list">
          {ledger.length === 0 ? (
            <div className="nt-box" style={{ color: "var(--muted)" }} ><span className="mono">No events yet — run a backtest.</span></div>
          ) : ledger.map((ev, i) => {
            const color = ev.type.includes("FILL") ? "var(--teal)" : ev.type.includes("LIQUID") || ev.type.includes("REJECT") || ev.type.includes("KILL") ? "var(--red)" : "var(--orange)";
            const detail = ev.payload?.price ? `${ev.payload.side ?? ""} ${ev.payload.price}` : ev.payload?.reason ? String(ev.payload.reason) : JSON.stringify(ev.payload).slice(0, 28);
            return (
              <div key={i} className="nt-box" style={{ display: "flex", justifyContent: "space-between", borderRadius: "10px" }}>
                <span className="mono" style={{ color }}>{`● ${ev.type}`}</span>
                <span className="mono" style={{ color: "var(--muted)" }}>{detail}</span>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
