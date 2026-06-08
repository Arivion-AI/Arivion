"use client";
/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import { useEffect, useState } from "react";
import { SectionTitle, SparkAreaChart } from "@/components/netrunners/Visuals";
import { SymbolPicker } from "@/components/netrunners/SymbolPicker";
import { TokenIcon } from "@/components/netrunners/TokenIcon";
import { netrunnersGet, netrunnersPost, seriesToPoints } from "@/lib/netrunners/api";

type DataHealthRow = { symbol: string; ageMs: number; status: string };
type DataHealthResponse = { rows?: DataHealthRow[]; staleThresholdMs?: number };
type CandleResponse = { bars?: Array<{ ts: number; close: string }> };
type XStockRow = { symbol?: string; underlying?: string; name?: string; xstock_multiplier?: string; tick_size?: string; position_cap_usdt?: string; bot_enabled?: boolean };
type XStocksResponse = { xstocks?: XStockRow[] };
type Schedule = { schedule_id: string; endpoint: string; symbol: string; interval: string; cadence_cron: string; enabled: boolean };
type QueueResponse = { stats?: Record<string, number>; jobs?: Array<{ job_key: string; endpoint: string; status: string }> };
type DexPool = {
  pool_id: string;
  chain_id: number;
  venue_name?: string;
  token0_symbol?: string;
  token1_symbol?: string;
  latest_close?: string | null;
  latest_liquidity?: string | null;
  latest_candle_at?: string | null;
  latest_coverage_score?: string | null;
};
type DexPoolsResponse = { pools?: DexPool[]; count?: number };

export default function DataPage() {
  const [healthRows, setHealthRows] = useState<DataHealthRow[]>([]);
  const [candles, setCandles] = useState<CandleResponse["bars"]>([]);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [xstocks, setXstocks] = useState<XStockRow[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [queueStats, setQueueStats] = useState<Record<string, number>>({});
  const [l2Status, setL2Status] = useState("OFF by default · enables verified-execution tier");
  const [dexPools, setDexPools] = useState<DexPool[]>([]);
  const [dexChainId, setDexChainId] = useState("42161");
  const [dexToken, setDexToken] = useState("ETH");
  const [dexStatus, setDexStatus] = useState("Idle · DEX data is additive beside Bybit.");
  const [selectedPoolId, setSelectedPoolId] = useState("");

  async function loadHealth() {
    const r = await netrunnersGet<DataHealthResponse>("/api/data/health");
    setHealthRows(r?.rows ?? []);
  }
  async function loadCandles(sym: string) {
    const category = sym.endsWith("XUSDT") ? "spot" : "linear";
    const interval = sym.endsWith("XUSDT") ? "D" : "60";
    const r = await netrunnersGet<CandleResponse>(`/api/candles?symbol=${encodeURIComponent(sym)}&category=${category}&interval=${interval}&limit=80`);
    setCandles(r?.bars ?? []);
  }
  async function loadXstocks() {
    const r = await netrunnersGet<XStocksResponse>("/api/xstocks/catalog");
    setXstocks((r?.xstocks ?? []).slice(0, 10));
  }
  async function loadBackfill() {
    const q = await netrunnersGet<QueueResponse>("/api/backfill/queue");
    setQueueStats(q?.stats ?? {});
    const s = await netrunnersGet<{ rows?: Schedule[] }>("/api/backfill/schedules");
    setSchedules((s?.rows ?? []).slice(0, 8));
  }
  async function loadDex() {
    const r = await netrunnersGet<DexPoolsResponse>(`/api/dex/pools?chainId=${encodeURIComponent(dexChainId)}&limit=12`);
    const rows = r?.pools ?? [];
    setDexPools(rows);
    setSelectedPoolId((current) => current || rows[0]?.pool_id || "");
  }

  useEffect(() => {
    void Promise.all([loadHealth(), loadXstocks(), loadBackfill(), loadDex()]);
    const t = setInterval(() => void loadHealth(), 10000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { void loadCandles(symbol); }, [symbol]);
  useEffect(() => { void loadDex(); }, [dexChainId]);

  async function toggleL2(enable: boolean) {
    const r = await netrunnersPost<Record<string, unknown>, Record<string, unknown>>("/api/live/record-l2", { enable, symbols: [symbol] });
    setL2Status(!r || r.error ? "L2 toggle failed (worker/ingestor)" : enable ? `L2 recording enabled for ${symbol}` : "L2 recording disabled");
  }

  async function backfillDexPools() {
    setDexStatus(`Discovering ${dexToken || "top"} pools on chain ${dexChainId} ...`);
    const r = await netrunnersPost<Record<string, unknown>, Record<string, unknown>>("/api/dex/backfill/pools", {
      chainId: Number(dexChainId),
      token: dexToken || undefined,
      limit: 25,
    });
    setDexStatus(!r || r.error ? `DEX pool discovery failed: ${String(r?.error ?? "unknown")}` : `DEX pool discovery complete · ${String(r.count ?? r.inserted ?? "ok")}`);
    await loadDex();
  }

  async function backfillDexSwaps() {
    if (!selectedPoolId) return;
    setDexStatus(`Backfilling swaps/candles for ${selectedPoolId.slice(0, 28)} ...`);
    const r = await netrunnersPost<Record<string, unknown>, Record<string, unknown>>("/api/dex/backfill/swaps", {
      poolId: selectedPoolId,
      days: 7,
      aggregate: 1,
    });
    setDexStatus(!r || r.error ? `DEX swap backfill failed: ${String(r?.error ?? "unknown")}` : "DEX swap/candle backfill complete");
    await loadDex();
  }

  async function pollDex() {
    const r = await netrunnersPost<Record<string, unknown>, Record<string, unknown>>("/api/dex/poll", selectedPoolId ? { poolId: selectedPoolId } : {});
    setDexStatus(!r || r.error ? "DEX poll failed" : "DEX poll complete");
    await loadDex();
  }

  const candlePoints = seriesToPoints((candles ?? []).slice(-60).map((b) => b.close), 170);

  return (
    <>
      <section className="nt-card navy nt-grid-bg" style={{ gridColumn: "1 / 7" }}>
        <SectionTitle endpoint="GET /api/data/health" title="Coverage Grid" right={<span className="nt-tag" style={{ color: "var(--muted)" }}>{healthRows.length} symbols</span>} />
        <div className="nt-list">
          {healthRows.length === 0 && <div className="nt-box"><div className="mono" style={{ color: "var(--muted)" }}>No tracked symbols yet — subscribe to a live feed or run a backtest.</div></div>}
          {healthRows.map((row) => (
            <div key={row.symbol} className="nt-box" style={{ display: "grid", gridTemplateColumns: "160px 1fr auto", gap: "12px", alignItems: "center" }}>
              <div className="mono" style={{ color: "var(--white)", display: "flex", gap: "8px", alignItems: "center" }}><TokenIcon symbol={row.symbol} size={20} />{row.symbol}</div>
              <div className="nt-progress">
                <i style={{ width: `${Math.max(6, 100 - Math.min(100, row.ageMs / 700))}%`, background: row.status === "fresh" ? "linear-gradient(90deg,var(--teal),#0bbf94)" : "linear-gradient(90deg,var(--orange),var(--orange-2))" }} />
              </div>
              <span className="nt-tag" style={{ color: row.status === "fresh" ? "var(--teal)" : "var(--orange)" }}>{row.status} · {Math.round(row.ageMs / 1000)}s</span>
            </div>
          ))}
        </div>
        <div className="nt-footer-note">Stale &gt; 1 min triggers a demand-driven live pull (no mock/old data served).</div>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "7 / 13" }}>
        <SectionTitle endpoint="GET /api/candles" title="Candle Inspector" right={<span className="nt-tag" style={{ color: "var(--muted)" }}>{(candles ?? []).length} bars</span>} />
        <div className="nt-field">
          <label>symbol · full Bybit universe</label>
          <SymbolPicker value={symbol} onChange={(sym) => setSymbol(sym)} />
        </div>
        <div className="nt-box ink">
          {candlePoints.length > 0 ? <SparkAreaChart points={candlePoints} /> : <div className="mono" style={{ color: "var(--muted)", padding: "40px 0", textAlign: "center" }}>No candles for {symbol}.</div>}
        </div>
        <div className="nt-footer-note">Real OHLC close series from the candles store.</div>
      </section>

      <section className="nt-card navy nt-grid-bg" style={{ gridColumn: "1 / 9" }}>
        <SectionTitle endpoint="POST /api/dex/backfill/*" title="DEX Data Plane"
          right={<span className="nt-tag" style={{ color: "var(--teal)" }}>{dexPools.length} pools indexed</span>} />
        <div className="nt-grid-3">
          <div className="nt-field">
            <label>chain</label>
            <select className="nt-input" value={dexChainId} onChange={(e) => setDexChainId(e.target.value)}>
              <option value="42161">Arbitrum One · data only</option>
              <option value="46630">Robinhood Testnet · test assets</option>
            </select>
          </div>
          <div className="nt-field">
            <label>token filter</label>
            <input className="nt-input" value={dexToken} onChange={(e) => setDexToken(e.target.value.toUpperCase())} placeholder="ETH, USDC, WETH" />
          </div>
          <div className="nt-field">
            <label>selected pool</label>
            <select className="nt-input" value={selectedPoolId} onChange={(e) => setSelectedPoolId(e.target.value)}>
              {dexPools.length === 0 ? <option value="">No pools indexed</option> : dexPools.map((p) => (
                <option key={p.pool_id} value={p.pool_id}>{p.token0_symbol}/{p.token1_symbol} · {p.venue_name ?? "DEX"}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button className="nt-btn orange" onClick={backfillDexPools}>Discover Pools</button>
          <button className="nt-btn ghost" onClick={backfillDexSwaps}>Backfill Swaps</button>
          <button className="nt-btn ghost" onClick={pollDex}>Poll Now</button>
        </div>
        <div className="nt-footer-note">{dexStatus}</div>
      </section>

      <section className="nt-card cream" style={{ gridColumn: "9 / 13" }}>
        <SectionTitle endpoint="GET /api/dex/pools" title="Pool Health" dark />
        <div className="nt-list">
          {dexPools.length === 0 && <div className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}><div className="mono" style={{ color: "var(--ink)" }}>No DEX pools indexed yet.</div></div>}
          {dexPools.slice(0, 6).map((pool) => (
            <button key={pool.pool_id} className="nt-box" onClick={() => setSelectedPoolId(pool.pool_id)}
              style={{ background: selectedPoolId === pool.pool_id ? "#d9ccb0" : "#e3d9c2", borderColor: selectedPoolId === pool.pool_id ? "var(--orange-deep)" : "#cfc4a8", textAlign: "left", cursor: "pointer" }}>
              <div className="mono" style={{ color: "var(--ink)", fontWeight: 800 }}>{pool.token0_symbol}/{pool.token1_symbol}</div>
              <div className="mono" style={{ color: "var(--muted-ink)", fontSize: "10px", marginTop: 4 }}>{pool.venue_name ?? "DEX"} · close {pool.latest_close ?? "--"} · liq {pool.latest_liquidity ?? "--"}</div>
              <div className="nt-footer-note" style={{ color: "var(--muted-ink)" }}>{pool.latest_candle_at ? `last candle ${String(pool.latest_candle_at).slice(0, 16)}` : "no candles yet"} · coverage {pool.latest_coverage_score ?? "--"}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "1 / 7" }}>
        <SectionTitle endpoint="GET /api/backfill/queue + /api/backfill/schedules" title="Backfill Queue"
          right={<span className="nt-tag" style={{ color: "var(--teal)" }}>{queueStats.completed ?? 0} done · {queueStats.failed ?? 0} fail</span>} />
        <div className="nt-grid-2">
          {schedules.length === 0 && <div className="nt-box"><div className="mono" style={{ color: "var(--muted)" }}>No backfill schedules registered.</div></div>}
          {schedules.map((s) => (
            <div className="nt-box" key={s.schedule_id}>
              <div className="nt-eyebrow">{s.schedule_id}</div>
              <div className="mono" style={{ marginTop: "6px", fontSize: "10px" }}>{s.cadence_cron} · {s.endpoint} · {s.symbol}/{s.interval}</div>
              <span className="nt-tag" style={{ color: s.enabled ? "var(--teal)" : "var(--muted)", marginTop: "4px" }}>{s.enabled ? "enabled" : "disabled"}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="nt-card cream" style={{ gridColumn: "7 / 10" }}>
        <SectionTitle endpoint="POST /api/live/record-l2" title="WS Collector" dark />
        <div className="nt-alert warn" style={{ marginBottom: "12px" }}>OFF by default · demand-driven L2 enables verified-execution tier</div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button className="nt-btn orange" onClick={() => toggleL2(true)}>Enable L2 · {symbol}</button>
          <button className="nt-btn ghost" style={{ color: "var(--ink)", borderColor: "#9d9483" }} onClick={() => toggleL2(false)}>Disable</button>
        </div>
        <div className="nt-footer-note">{l2Status}</div>
      </section>

      <section className="nt-card cream" style={{ gridColumn: "10 / 13" }}>
        <SectionTitle endpoint="GET /api/xstocks/catalog" title="xStocks" dark right={<span className="nt-tag" style={{ color: "var(--orange-deep)" }}>{xstocks.length}</span>} />
        <div className="nt-list">
          {xstocks.length === 0 && <div className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}><div className="mono" style={{ color: "var(--ink)" }}>Catalog unavailable.</div></div>}
          {xstocks.map((row) => (
            <div key={row.symbol} className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}>
              <div className="mono" style={{ color: "var(--ink)", fontWeight: 700, display: "flex", gap: "7px", alignItems: "center" }}><TokenIcon symbol={row.symbol} kind="equity" underlying={row.underlying} size={20} />{row.symbol} <span style={{ fontWeight: 400, color: "var(--muted-ink)" }}>· {row.underlying}</span></div>
              <div className="mono" style={{ color: "var(--muted-ink)", fontSize: "10px", marginTop: "4px" }}>×{row.xstock_multiplier} · tick {row.tick_size} · cap ${Number(row.position_cap_usdt ?? 0).toLocaleString()}{row.bot_enabled ? " · bot ✓" : ""}</div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
