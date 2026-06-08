"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { EquityChart, type ChartBar } from "@/components/netrunners/EquityChart";
import { fmtPct, fmtUsd, type PaperRuntimeResult } from "@/lib/netrunners/api";

type Props = {
  result: PaperRuntimeResult;
  title: string;
  startEquity: number;
  onClose: () => void;
};

type TabId = "overview" | "trades" | "execution";
const TABS: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "trades", label: "Trades" },
  { id: "execution", label: "Execution" },
];

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function tsLabel(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return ts;
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Copilot palette: cyan = positive, accent (orange) = negative, gold = neutral metric.
const CYAN = "var(--cyan, #46e0ff)";
const ACCENT = "var(--accent, #ff5a1f)";
const GOLD = "var(--gold, #ffce3a)";
// Theme the shared EquityChart (teal/red vars) into the copilot cyan/orange palette.
const CHART_THEME = { "--teal": "#46e0ff", "--red": "#ff5a1f" } as CSSProperties;

/** Detailed, tabbed backtest report for the copilot Quants Lab. Pure-real data from the
 *  /api/paper/runtime/run result — surfaces the full fills + trade_pnls + execution metadata
 *  the lab result card only teases. Built from the copilot's own nexa modal/table classes. */
export function BacktestReportModal({ result, title, startEquity, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("overview");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const perf = result.performance ?? {};
  const fills = useMemo(() => result.fills ?? [], [result.fills]);
  const events = result.events ?? [];
  const equity = useMemo(() => (result.equity_curve ?? []).map(num), [result.equity_curve]);
  const pnls = useMemo(() => (result.trade_pnls ?? []).map(num), [result.trade_pnls]);
  const finalEquity = result.final_equity ? num(result.final_equity) : equity[equity.length - 1];
  const bars = useMemo<ChartBar[]>(() => fills.map((f) => ({ ts: Date.parse(f.ts) })).filter((b) => !Number.isNaN(b.ts)), [fills]);

  const stats = useMemo(() => {
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p < 0);
    const totalFees = fills.reduce((acc, f) => acc + num(f.fee), 0);
    const makers = fills.filter((f) => f.is_maker).length;
    return {
      trades: pnls.length,
      winRate: pnls.length ? wins.length / pnls.length : 0,
      avgWin: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
      avgLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
      bestTrade: pnls.length ? Math.max(...pnls) : 0,
      worstTrade: pnls.length ? Math.min(...pnls) : 0,
      totalFees,
      makers,
      takers: fills.length - makers,
    };
  }, [pnls, fills]);

  const fillModel = result.fill_model as Record<string, unknown> | undefined;
  const venue = result.venue as Record<string, unknown> | undefined;
  const truthCard = result.truth_card as Record<string, unknown> | undefined;
  const positive = finalEquity !== undefined && finalEquity >= startEquity;

  return (
    <div className="nx-modal-back" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="nx-modal nx-report">
        <div className="nx-modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="nx-md-h" style={{ marginBottom: 4 }}>Backtest report</div>
            <div className="nx-modal-title" style={{ overflowWrap: "anywhere" }}>{title}</div>
            <div className="nx-report-sub">{fills.length} fills · {events.length} events</div>
          </div>
          <span className="nx-report-pill" style={{ color: positive ? CYAN : ACCENT, borderColor: "currentcolor" }}>{result.status ?? "completed"}</span>
          <button className="nx-modal-x" type="button" onClick={onClose}>✕</button>
        </div>

        <div className="nx-modal-body">
          <div className="nx-quants-tabs nx-report-tabs">
            {TABS.map((t) => (
              <button key={t.id} type="button" className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {tab === "overview" && (
            <>
              <div className="nx-report-chart" style={CHART_THEME}>
                <EquityChart equity={equity} fills={fills} bars={bars} startEquity={startEquity} height={240} />
              </div>
              <div className="nx-report-kpis">
                <Kpi label="final_equity" value={finalEquity !== undefined ? fmtUsd(finalEquity) : "--"} color={GOLD} />
                <Kpi label="total_return" value={fmtPct(perf.total_return)} color={(perf.total_return ?? 0) >= 0 ? CYAN : ACCENT} />
                <Kpi label="sharpe" value={perf.sharpe?.toFixed(2) ?? "--"} />
                <Kpi label="sortino" value={perf.sortino?.toFixed(2) ?? "--"} />
                <Kpi label="calmar" value={perf.calmar?.toFixed(2) ?? "--"} />
                <Kpi label="max_drawdown" value={fmtPct(perf.max_drawdown)} color={ACCENT} />
                <Kpi label="trades" value={String(stats.trades)} />
                <Kpi label="win_rate" value={stats.trades ? fmtPct(stats.winRate) : "--"} color={stats.winRate >= 0.5 ? CYAN : undefined} />
                <Kpi label="avg_win" value={stats.avgWin ? fmtUsd(stats.avgWin) : "--"} color={CYAN} />
                <Kpi label="avg_loss" value={stats.avgLoss ? fmtUsd(stats.avgLoss) : "--"} color={ACCENT} />
                <Kpi label="best / worst" value={`${stats.bestTrade ? fmtUsd(stats.bestTrade) : "--"} / ${stats.worstTrade ? fmtUsd(stats.worstTrade) : "--"}`} />
                <Kpi label="total_fees" value={fmtUsd(stats.totalFees)} color={ACCENT} />
                <Kpi label="maker / taker" value={`${stats.makers} / ${stats.takers}`} />
              </div>
            </>
          )}

          {tab === "trades" && (
            fills.length === 0 ? (
              <div className="nx-report-empty">No fills in this run.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="nx-md-table">
                  <thead>
                    <tr>{["#", "time", "side", "qty", "price", "fee", "type", "pnl"].map((h) => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {fills.map((f, i) => {
                      const buy = f.side === "buy";
                      const pnl = pnls[i];
                      return (
                        <tr key={i}>
                          <td style={{ color: "var(--ink-3)" }}>{i + 1}</td>
                          <td style={{ color: "var(--ink-3)", whiteSpace: "nowrap" }}>{tsLabel(f.ts)}</td>
                          <td style={{ color: buy ? CYAN : ACCENT, fontWeight: 700 }}>{buy ? "▲ BUY" : "▼ SELL"}</td>
                          <td>{f.qty}</td>
                          <td>{f.price}</td>
                          <td style={{ color: "var(--ink-3)" }}>{f.fee}</td>
                          <td style={{ color: "var(--ink-3)" }}>{f.is_maker ? "maker" : "taker"}</td>
                          <td style={{ color: pnl === undefined ? "var(--ink-3)" : pnl >= 0 ? CYAN : ACCENT }}>{pnl === undefined ? "—" : fmtUsd(pnl)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}

          {tab === "execution" && (
            <div className="nx-report-exec-grid">
              <CodeCard title="fill_model" data={fillModel} empty="No fill-model metadata." />
              <CodeCard title="venue" data={venue} empty="No venue metadata." />
              <CodeCard title="truth_card" data={truthCard} empty="No truth-card metadata." />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="nx-report-kpi">
      <span>{label}</span>
      <b style={color ? { color } : undefined}>{value}</b>
    </div>
  );
}

function CodeCard({ title, data, empty }: { title: string; data: Record<string, unknown> | undefined; empty: string }) {
  const hasData = data && Object.keys(data).length > 0;
  return (
    <div className="nx-report-exec">
      <div className="nx-md-h">{title}</div>
      {hasData ? (
        <div className="nx-md-kv nx-report-kv">
          {Object.entries(data!).map(([k, v]) => (
            <div key={k}><span>{k}</span><b>{typeof v === "object" ? JSON.stringify(v) : String(v)}</b></div>
          ))}
        </div>
      ) : (
        <div className="nx-report-empty" style={{ textAlign: "left", padding: "4px 0" }}>{empty}</div>
      )}
    </div>
  );
}
