"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { SectionTitle, SemiGauge } from "@/components/netrunners/Visuals";
import { TokenIcon } from "@/components/netrunners/TokenIcon";
import { MultiEquityChart, type EquitySeries, type ChartFill } from "@/components/netrunners/MultiEquityChart";
import { fmtNum, fmtPct, fmtUsd, netrunnersGet, netrunnersPost, getCandlesEnsured, subscribeStream, type PaperRuntimeResult } from "@/lib/netrunners/api";

const SERIES_COLORS = ["#16e0b0", "#f97316", "#a78bfa", "#f472b6", "#60a5fa", "#fbbf24", "#34d399", "#fb7185", "#c084fc", "#38bdf8"];

type PriceRow = { symbol: string; last_close: number; fresh: boolean; age_ms: number };
type Session = { session_id: string; strategy_id: string; symbol: string; status: string; starting_equity?: string; final_equity?: string; live_return?: number; live_fills?: number; bars_seen?: number; start_bar_ms?: number };
type Concurrency = { active?: number; max_active?: number; queued_peak?: number; total?: number; rejected_owner?: number; rejected_busy?: number; heavy_concurrency?: number; owner_concurrency?: number };
type Realtime = { ok?: boolean; stats?: { linear?: Record<string, unknown>; spot?: Record<string, unknown> } };

export default function DashboardPage() {
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [concurrency, setConcurrency] = useState<Concurrency | null>(null);
  const [realtime, setRealtime] = useState<Realtime | null>(null);
  const livePrices = useRef<Record<string, PriceRow>>({});
  const [acctSeries, setAcctSeries] = useState<EquitySeries[]>([]);
  const [acctStatus, setAcctStatus] = useState("loading account equity …");
  const acctRan = useRef(false);

  async function load() {
    const [p, s, c, rt] = await Promise.all([
      netrunnersGet<{ prices?: PriceRow[] }>("/api/live/prices"),
      netrunnersGet<{ sessions?: Session[] }>("/api/live-paper/sessions"),
      netrunnersGet<Concurrency>("/api/concurrency/stats"),
      netrunnersGet<Realtime>("/api/realtime/status"),
    ]);
    if (p?.prices) {
      for (const row of p.prices) livePrices.current[row.symbol] = row;
      setPrices(Object.values(livePrices.current));
    }
    setSessions(s?.sessions ?? []);
    setConcurrency(c);
    setRealtime(rt);
    if (!acctRan.current) { acctRan.current = true; void runAccountEquity(s?.sessions ?? []); }
  }

  // Build ONE equity line per token the account trades. For each unique session symbol we run
  // a real backtest of that session's strategy on real candles (POST /api/paper/runtime/run) and
  // plot its equity curve + buy/sell fills. Sequential to respect the per-owner concurrency cap.
  async function runAccountEquity(sess: Session[]) {
    // unique tokens (most-recent session's strategy per symbol), newest first, cap 10
    const bySymbol = new Map<string, Session>();
    for (const s of [...sess].sort((a, b) => Number(b.start_bar_ms ?? 0) - Number(a.start_bar_ms ?? 0))) {
      if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, s);
    }
    const tokens = [...bySymbol.values()].slice(0, 10);
    if (tokens.length === 0) { setAcctStatus("no sessions yet — start live paper trading"); return; }

    const out: EquitySeries[] = [];
    let idx = 0;
    for (const t of tokens) {
      const symbol = t.symbol;
      const category = symbol.endsWith("XUSDT") ? "spot" : "linear";
      const interval = category === "spot" ? "D" : "60";
      setAcctStatus(`running ${idx + 1}/${tokens.length} · ${t.strategy_id} · ${symbol} (auto-backfill if needed) …`);
      const bars = await getCandlesEnsured(symbol, category, interval, 120);
      if (bars.length >= 30) {
        const payload = {
          symbol, strategy_id: t.strategy_id, strategy_params: {}, starting_equity: "10000", bars,
          fee_bps_taker: "5.5", fee_bps_maker: "1.0", slippage_bps_one_way: "2.0", interval_minutes: interval === "D" ? 1440 : 60,
          risk: { max_position_fraction: "1.0", max_total_exposure_fraction: "3.0" },
        };
        const r = await netrunnersPost<PaperRuntimeResult, typeof payload>("/api/paper/runtime/run", payload);
        if (r && !r.error && r.equity_curve) {
          out.push({
            symbol, strategy: t.strategy_id, equity: r.equity_curve.map(Number),
            fills: (r.fills ?? []) as ChartFill[], bars: bars.map((b) => ({ ts: b.ts })),
            color: SERIES_COLORS[idx % SERIES_COLORS.length], start: 10000,
          });
          setAcctSeries([...out]); // progressive render as each token completes
        }
      }
      idx += 1;
    }
    setAcctStatus(out.length ? `${out.length} tokens · ${out.reduce((n, s) => n + s.fills.length, 0)} trades` : "no candle data for account tokens");
  }

  useEffect(() => {
    void load();
    const interval = setInterval(load, 10_000);
    // live price ticks via SSE
    const close = subscribeStream({
      topics: "prices", symbols: "BTCUSDT,ETHUSDT,SOLUSDT",
      onMessage: (_type, data) => {
        const d = data as { symbol?: string; close?: string | number; price?: string | number };
        if (d?.symbol && (d.close ?? d.price) != null) {
          const prev = livePrices.current[d.symbol];
          livePrices.current[d.symbol] = { symbol: d.symbol, last_close: Number(d.close ?? d.price), fresh: true, age_ms: prev?.age_ms ?? 0 };
          setPrices(Object.values(livePrices.current));
        }
      },
    });
    return () => { clearInterval(interval); close(); };
  }, []);

  const netEquity = useMemo(
    () => sessions.reduce((sum, s) => sum + Number(s.final_equity ?? s.starting_equity ?? 0), 0),
    [sessions],
  );
  const liveReturnBlend = useMemo(() => {
    const open = sessions.filter((s) => typeof s.live_return === "number");
    return open.length ? open.reduce((sum, s) => sum + (s.live_return ?? 0), 0) / open.length : 0;
  }, [sessions]);
  const runningCount = sessions.filter((s) => s.status === "running").length;
  const freshFeeds = prices.filter((p) => p.fresh).length;
  const load01 = concurrency ? Math.min(100, ((concurrency.active ?? 0) / (concurrency.heavy_concurrency || 4)) * 100) : 0;
  const linStats = realtime?.stats?.linear ?? {};

  const QUICK = [
    ["Run Backtest", "/netrunners/strategy-lab"],
    ["Start Live Paper", "/netrunners/live-paper"],
    ["Open Bot Cockpit", "/netrunners/bot-os"],
    ["Portfolio Run", "/netrunners/portfolio"],
    ["Optimizer Sweep", "/netrunners/optimizer"],
    ["Marketplace", "/netrunners/leaderboard"],
  ] as const;

  return (
    <>
      <section className="nt-card navy nt-grid-bg nt-kpi nt-fade-in" style={{ gridColumn: "1 / 4", animationDelay: "40ms" }}>
        <div>
          <div className="lab">Net Equity · live-paper</div>
          <div className="val">{netEquity > 0 ? fmtUsd(netEquity) : "$0"}</div>
          <div className="nt-tag" style={{ marginTop: "10px", color: liveReturnBlend >= 0 ? "var(--teal)" : "var(--red)" }}>
            <span className="nt-dot" style={{ background: liveReturnBlend >= 0 ? "var(--teal)" : "var(--red)" }} />
            {fmtPct(liveReturnBlend)} session blend
          </div>
        </div>
        <svg className="nt-ring" viewBox="0 0 46 46" aria-hidden="true">
          <circle cx="23" cy="23" r="19" fill="none" stroke="#2a3060" strokeWidth="5" />
          <circle cx="23" cy="23" r="19" fill="none" stroke="var(--teal)" strokeWidth="5" strokeLinecap="round" strokeDasharray="119" strokeDashoffset={String(119 - Math.min(119, runningCount * 30))} transform="rotate(-90 23 23)" />
        </svg>
      </section>

      <section className="nt-card cream nt-kpi nt-fade-in" style={{ gridColumn: "4 / 7", animationDelay: "80ms" }}>
        <div>
          <div className="lab" style={{ color: "var(--muted-ink)" }}>Live-Paper Sessions</div>
          <div className="val" style={{ color: "var(--orange-deep)" }}>{String(sessions.length).padStart(2, "0")}</div>
          <div className="nt-eyebrow dk" style={{ marginTop: "7px" }}>{runningCount} running · {sessions.length - runningCount} stopped</div>
        </div>
      </section>

      <section className="nt-card paper nt-kpi nt-fade-in" style={{ gridColumn: "7 / 10", animationDelay: "120ms" }}>
        <div>
          <div className="lab" style={{ color: "var(--muted-ink)" }}>Fresh Feeds</div>
          <div className="val" style={{ color: "var(--ink)" }}>{freshFeeds}/{prices.length}</div>
          <div className="nt-eyebrow dk" style={{ marginTop: "7px" }}>&lt; 1 min staleness</div>
        </div>
      </section>

      <section className="nt-card orange nt-kpi nt-fade-in" style={{ gridColumn: "10 / 13", animationDelay: "160ms" }}>
        <div>
          <div className="lab" style={{ opacity: 0.9 }}>WS Collector</div>
          <div className="val">{linStats.connected ? "LIVE" : "IDLE"}</div>
          <div className="nt-eyebrow" style={{ color: "rgba(255,255,255,0.82)", marginTop: "7px" }}>{Number(linStats.klines ?? 0)} klines · {Number(linStats.symbols ?? 0)} sym</div>
        </div>
      </section>

      <section className="nt-tape nt-fade-in" style={{ animationDelay: "200ms" }}>
        <span className="tlab">RT FEED ▸</span>
        <div style={{ overflow: "hidden", flex: 1 }}>
          <div className="nt-stream">
            {prices.length === 0 ? <span style={{ color: "var(--muted)" }}>no live prices — subscribe a symbol via Data Ops</span> :
              [...prices, ...prices].map((row, index) => (
                <span key={`${row.symbol}-${index}`} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <TokenIcon symbol={row.symbol} size={15} pair={false} />
                  <span style={{ color: "var(--muted)", marginRight: "4px" }}>{row.symbol}</span>
                  <b>{fmtNum(row.last_close)}</b>
                  <span style={{ marginLeft: "8px", color: row.fresh ? "var(--teal)" : "var(--orange)" }}>{row.fresh ? "● fresh" : `▲ ${Math.round(row.age_ms / 1000)}s`}</span>
                </span>
              ))}
          </div>
        </div>
      </section>

      <section className="nt-card navy nt-grid-bg nt-fade-in" style={{ gridColumn: "1 / 8", animationDelay: "240ms" }}>
        <SectionTitle endpoint="POST /api/paper/runtime/run" title="Account Equity · per token"
          right={<span className="nt-tag" style={{ color: "var(--muted)" }}>{acctSeries.length} tokens</span>} />
        <div className="nt-box ink" style={{ padding: "8px 6px" }}>
          {acctSeries.length > 0 ? (
            <MultiEquityChart series={acctSeries} height={250} />
          ) : (
            <div className="mono" style={{ color: "var(--muted)", padding: "90px 0", textAlign: "center" }}>{acctStatus}</div>
          )}
        </div>
        <div className="nt-footer-note">one line per coin/xStock · click a token to focus its buy/sell markers · hover for trade detail · {acctStatus}</div>
      </section>

      <section className="nt-card navy nt-grid-bg nt-fade-in" style={{ gridColumn: "8 / 11", animationDelay: "280ms" }}>
        <SectionTitle endpoint="GET /api/concurrency/stats" title="System Load" />
        <SemiGauge value={load01} max={100} label={load01 > 75 ? "BUSY" : load01 > 33 ? "ACTIVE" : "IDLE"} color={load01 > 75 ? "var(--red)" : load01 > 33 ? "var(--orange)" : "var(--teal)"} />
        <div className="nt-footer-note">active {concurrency?.active ?? 0}/{concurrency?.heavy_concurrency ?? 4} · queued_peak {concurrency?.queued_peak ?? 0} · GIL ⇒ 1 proc ≈ 1 core</div>
      </section>

      <section className="nt-card cream nt-fade-in" style={{ gridColumn: "11 / 13", animationDelay: "320ms" }}>
        <SectionTitle endpoint="GET /api/concurrency/stats" title="Concurrency" dark />
        <div className="nt-grid-2">
          <div className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}><div className="nt-eyebrow dk">Active</div><div className="mono" style={{ marginTop: "6px", fontSize: "20px", fontWeight: 700 }}>{concurrency?.active ?? 0}/{concurrency?.heavy_concurrency ?? 0}</div></div>
          <div className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}><div className="nt-eyebrow dk">Queued Peak</div><div className="mono" style={{ marginTop: "6px", fontSize: "20px", fontWeight: 700 }}>{concurrency?.queued_peak ?? 0}</div></div>
          <div className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}><div className="nt-eyebrow dk">Total Jobs</div><div className="mono" style={{ marginTop: "6px", fontSize: "20px", fontWeight: 700 }}>{concurrency?.total ?? 0}</div></div>
          <div className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}><div className="nt-eyebrow dk">Rejected</div><div className="mono" style={{ marginTop: "6px", fontSize: "20px", fontWeight: 700 }}>{(concurrency?.rejected_owner ?? 0) + (concurrency?.rejected_busy ?? 0)}</div></div>
        </div>
      </section>

      <section className="nt-card navy nt-fade-in" style={{ gridColumn: "1 / 8", animationDelay: "360ms" }}>
        <SectionTitle endpoint="GET /api/live-paper/sessions" title="Live-Paper Sessions"
          right={<Link href="/netrunners/live-paper" className="nt-tag" style={{ color: "var(--orange)" }}>top 5 · all →</Link>} />
        <div className="nt-list">
          {sessions.length === 0 ? (
            <div className="nt-box"><div className="mono" style={{ color: "var(--muted)" }}>No sessions. Start one in Live Paper to stream forward returns here.</div></div>
          ) : [...sessions].sort((a, b) => Number(b.start_bar_ms ?? 0) - Number(a.start_bar_ms ?? 0)).slice(0, 5).map((session) => (
            <div className="nt-list-row" key={session.session_id}>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <TokenIcon symbol={session.symbol} size={22} />
                <div>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: "13px", letterSpacing: ".04em" }}>{session.strategy_id}</div>
                  <div style={{ color: "var(--muted)" }}>{session.symbol}</div>
                </div>
              </div>
              <div style={{ color: (session.live_return ?? 0) >= 0 ? "var(--teal)" : "var(--red)", fontWeight: 700 }}>{fmtPct(session.live_return)}</div>
              <div>{session.live_fills ?? 0} fills</div>
              <div><div className="nt-progress"><i style={{ width: `${Math.min(100, (session.bars_seen ?? 0) / 6)}%` }} /></div></div>
              <span className="nt-tag" style={{ color: session.status === "running" ? "var(--teal)" : "var(--orange)" }}>{String(session.status ?? "running").toUpperCase()}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="nt-card navy nt-fade-in" style={{ gridColumn: "8 / 11", animationDelay: "400ms" }}>
        <SectionTitle endpoint="GET /api/realtime/status" title="Realtime Status" />
        <div className="nt-grid-2">
          {[
            ["linear", linStats.connected ? "connected" : "idle"],
            ["klines", String(linStats.klines ?? 0)],
            ["barcloses", String(linStats.barcloses ?? 0)],
            ["l2_snapshots", String(linStats.l2_snapshots ?? 0)],
          ].map(([label, value]) => (
            <div key={label} className="nt-box">
              <div className="nt-eyebrow">{label}</div>
              <div className="mono" style={{ marginTop: "6px", fontSize: "13px", color: "var(--white)" }}>{value}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="nt-card cream nt-fade-in" style={{ gridColumn: "11 / 13", animationDelay: "440ms" }}>
        <SectionTitle endpoint="determinism pins" title="Passport Pin" dark />
        <div className="nt-eyebrow dk">engine / data / seed / compiler</div>
        <div className="mono" style={{ marginTop: "8px", fontSize: "11px", lineHeight: 1.8 }}>
          engine v4.1-persisted{"\n"}data rt-ws-v1{"\n"}seed 42{"\n"}compiler 2026.05
        </div>
      </section>

      <section className="nt-card navy nt-fade-in" style={{ gridColumn: "1 / 13", animationDelay: "520ms" }}>
        <SectionTitle endpoint="navigation" title="Quick Launch" />
        <div className="nt-grid-3" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
          {QUICK.map(([label, href], idx) => (
            <Link key={label} href={href} className={`nt-btn ${idx === 0 || idx === 1 ? "orange" : "ghost"}`} style={{ textAlign: "center", textDecoration: "none" }}>{label}</Link>
          ))}
        </div>
      </section>
    </>
  );
}
