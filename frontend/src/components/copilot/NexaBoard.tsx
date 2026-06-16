"use client";

import { Fragment, useRef, useState, useLayoutEffect, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { TokenIcon } from "@/components/netrunners/TokenIcon";

// The center "trading setup" board: agent activity becomes a flowchart of sleek widgets connected by
// dotted lines. Widgets are draggable (by the header); "expand" opens a detail MODAL with the full
// payload. Bodies + modal render only what the agent actually produced (never fabricated).

export type WidgetKind =
  | "data" | "scan" | "strategy" | "backtest" | "optimise" | "multiasset" | "news" | "position" | "truth" | "think" | "basket" | "bot" | "factors" | "screen" | "regime" | "refine"
  | "dex_pool" | "quote" | "bybit_dex" | "onchain_truth" | "dune_panel"
  | "lp_compare" | "lp_pool" | "il_curve" | "funding_carry" | "gmx_market" | "lp_backtest"
  | "intake" | "objective" | "reasoning" | "mode_router" | "hold_vs_trade_vs_lp"
  | "venue_route" | "glv_vault" | "market_briefing" | "lp_screen" | "lp_range_opt" | "sentiment_gauge" | "onchain_context"
  | "knowledge_lib" | "knowledge_cite" | "firm_debate" | "lp_position";

export interface LegPatch { allocation?: number; bot?: string; locked?: boolean }

export interface BoardWidget {
  id: string;
  kind: WidgetKind;
  title: string;
  tool?: string;
  rationale?: string;
  state: "running" | "done" | "error";
  data?: Record<string, unknown>;
  x: number;
  y: number;
}

function widgetClass(w: BoardWidget, extra = ""): string {
  return `nx-widget nx-kind-${w.kind} ${w.kind === "basket" ? "nx-w-basket" : ""} ${w.state} ${extra}`.trim();
}

export const KIND_META: Record<WidgetKind, { label: string; icon: ReactNode }> = {
  think: { label: "Reasoning", icon: <path d="M12 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 12 3Zm-3 16h6m-5 2h4" /> },
  data: { label: "Data", icon: <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /> },
  scan: { label: "Market Scan", icon: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></> },
  strategy: { label: "Strategy", icon: <path d="M4 18 9 9l4 5 7-11M4 18h16" /> },
  backtest: { label: "Backtest", icon: <path d="M4 19V5m0 14h16M8 16l3-4 3 2 5-7" /> },
  optimise: { label: "Optimiser", icon: <path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l3 3m6 6 3 3m0-12-3 3M9 15l-3 3" /> },
  multiasset: { label: "Multiasset", icon: <><circle cx="7" cy="7" r="3" /><circle cx="17" cy="7" r="3" /><circle cx="12" cy="17" r="3" /></> },
  news: { label: "News", icon: <path d="M5 4h11v16H6a2 2 0 0 1-2-2V6m12-2h2a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2M8 8h6M8 12h6M8 16h4" /> },
  position: { label: "Position", icon: <path d="M3 12h4l3-8 4 16 3-8h4" /> },
  truth: { label: "Truth Card", icon: <path d="M12 3 4 6v6c0 4.5 3.4 7.8 8 9 4.6-1.2 8-4.5 8-9V6l-8-3Zm-2 9 2 2 4-4" /> },
  basket: { label: "Basket · editable", icon: <path d="M3 6h18l-2 13H5L3 6Zm3 0 2-3h8l2 3M9 11v4m6-4v4" /> },
  bot: { label: "Bot · Bot-OS", icon: <><rect x="5" y="8" width="14" height="11" rx="2" /><path d="M12 8V4m-4 4V6m8 2V6M9 13h.01M15 13h.01M9 16h6" /></> },
  factors: { label: "Factor Analysis", icon: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></> },
  screen: { label: "Top Picks", icon: <path d="M3 17l5-5 4 3 8-9M12 3h9v9" /> },
  regime: { label: "Regime Report", icon: <path d="M3 12h3l3-7 4 14 3-9 2 2h3" /> },
  refine: { label: "Self-Improve", icon: <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v4h-4" /></> },
  dex_pool: { label: "DEX Pool", icon: <><circle cx="7" cy="12" r="3" /><circle cx="17" cy="12" r="3" /><path d="M10 12h4M7 9V5m10 4V5M7 15v4m10-4v4" /></> },
  quote: { label: "AMM Quote", icon: <path d="M4 7h16M4 12h10M4 17h16m-4-7 4 2-4 2" /> },
  bybit_dex: { label: "CEX vs DEX", icon: <path d="M4 17 9 7l4 6 3-4 4 8M4 20h16" /> },
  onchain_truth: { label: "On-chain Truth", icon: <path d="M12 3 4 7v5c0 4.5 3.4 7.5 8 9 4.6-1.5 8-4.5 8-9V7l-8-4Zm-3 9 2 2 4-5" /> },
  dune_panel: { label: "Dune · on-chain", icon: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="7" cy="6" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="17" cy="18" r="1.4" /></> },
  lp_compare: { label: "LP Pools · pick", icon: <><circle cx="7" cy="9" r="3" /><circle cx="15" cy="9" r="3" /><path d="M3 18h18M9 15l2 3 2-3" /></> },
  lp_pool: { label: "LP Pool", icon: <><circle cx="8" cy="12" r="4" /><circle cx="16" cy="12" r="4" /></> },
  il_curve: { label: "IL & Range", icon: <path d="M3 17c4 0 5-10 9-10s5 10 9 10M3 21h18" /> },
  funding_carry: { label: "Yield & Carry", icon: <path d="M12 3v18m0-18c-3 0-5 1.5-5 3.5S9 10 12 10s5 1.5 5 3.5-2 3.5-5 3.5m-5-3h10" /> },
  gmx_market: { label: "GMX Market", icon: <><path d="M4 18 9 9l4 5 7-11" /><path d="M4 20h16" /><circle cx="9" cy="9" r="1.3" /></> },
  lp_backtest: { label: "LP Backtest", icon: <path d="M4 19V5m0 14h16M8 15c3 0 4-7 7-7s2 4 5 4" /> },
  intake: { label: "Discovery", icon: <><path d="M8 10h8M8 14h5" /><rect x="3" y="4" width="18" height="16" rx="2" /></> },
  objective: { label: "Objective", icon: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3" /></> },
  reasoning: { label: "Reasoning", icon: <path d="M12 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 12 3Zm-3 16h6m-5 2h4" /> },
  mode_router: { label: "Expression", icon: <><path d="M4 7h6l4 10h6" /><path d="M4 17h6M14 7h6" /><circle cx="12" cy="12" r="1.5" /></> },
  hold_vs_trade_vs_lp: { label: "Hold · Trade · LP", icon: <><rect x="3" y="9" width="5" height="11" /><rect x="10" y="5" width="5" height="15" /><rect x="17" y="12" width="4" height="8" /></> },
  venue_route: { label: "Venue Route", icon: <><circle cx="5" cy="12" r="2" /><circle cx="19" cy="12" r="2" /><path d="M7 12h10m-3-3 3 3-3 3" /></> },
  glv_vault: { label: "GLV Vault", icon: <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 8 5l-8 4Z" /></> },
  market_briefing: { label: "Market Briefing", icon: <><circle cx="12" cy="12" r="9" /><path d="M12 12 12 3M12 12l6 4" /><circle cx="12" cy="12" r="1.6" /></> },
  lp_screen: { label: "LP Screener", icon: <><path d="M3 6h18M3 12h18M3 18h18" /><path d="M7 3v18" /><circle cx="15" cy="9" r="1.4" /></> },
  lp_range_opt: { label: "Range Optimizer", icon: <><path d="M3 18c4 0 6-9 9-9s5 9 9 9" /><path d="M12 3v4" /><circle cx="12" cy="9" r="1.5" /></> },
  sentiment_gauge: { label: "Sentiment", icon: <><path d="M4 14a8 8 0 0 1 16 0" /><path d="M12 14l4-3" /><circle cx="12" cy="14" r="1.4" /></> },
  onchain_context: { label: "On-chain Context", icon: <><path d="M12 3 4 7v5c0 4.5 3.4 7.5 8 9 4.6-1.5 8-4.5 8-9V7l-8-4Z" /><path d="M9 12l2 2 4-5" /></> },
  knowledge_lib: { label: "Knowledge Library", icon: <><path d="M4 5h6v15H4zM10 5h6v15h-6z" /><path d="M16 6l4 1-3 14-4-1" /></> },
  knowledge_cite: { label: "Knowledge", icon: <><path d="M6 4h9l3 3v13H6z" /><path d="M9 10h6M9 14h4" /></> },
  firm_debate: { label: "Trading Firm", icon: <><circle cx="7" cy="8" r="2.5" /><circle cx="17" cy="8" r="2.5" /><path d="M4 19c0-3 2-5 5-5m6 0c3 0 5 2 5 5M12 11v5" /></> },
  lp_position: { label: "LP Positions", icon: <><path d="M3 12h4l3 7 4-14 3 7h4" /><circle cx="12" cy="5" r="1.4" /></> },
};

// Short column labels for the factor heatmap (keyed by the factor names the engine emits).
const FACTOR_LABEL: Record<string, string> = {
  momentum: "Mom", trend: "Trend", rsi_health: "RSI", liquidity: "Liq", low_vol: "Calm", risk_adj: "R-Adj", carry: "Carry", sentiment: "Sent",
};
// Color a 0..1 factor cell with the DUA// landing palette.
function heatStyle(v: number | null): CSSProperties {
  if (v === null) return { background: "transparent", color: "var(--ink-3)" };
  const alpha = v >= 0.5 ? Math.max(0.08, (v - 0.5) * 1.35) : Math.max(0.08, (0.5 - v) * 1.15);
  const bg = v >= 0.5 ? `rgba(70,224,255,${alpha.toFixed(2)})` : `rgba(255,90,31,${alpha.toFixed(2)})`;
  return { background: bg, color: v > 0.78 || v < 0.18 ? "#fff" : "var(--ink-1)" };
}

const SYM_COLORS = ["#ff5a1f", "#ffce3a", "#46e0ff", "#ededed", "#8c8c8c", "#c04a20", "#b59a2d"];
function baseSym(s: unknown): string { return String(s).replace(/USDT$/, "").replace(/PERP$/, ""); }
function lpVenueShort(v: unknown): string { const s = String(v); return s === "uniswap" ? "Uniswap" : s === "gmx_gm" ? "GMX GM" : s === "gmx_glv" ? "GMX GLV" : s; }
function fmtPrice(v: unknown): string { const n = num(v); if (n === null) return "—"; return n >= 100 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${Number(n.toPrecision(4))}`; }
function legMetricSummary(l: Record<string, unknown>): string {
  const m = obj(l.metrics);
  if (m.total_return != null || m.sharpe != null || m.max_drawdown != null) {
    return `${pct(m.total_return)} · S ${fix(m.sharpe)} · DD ${pct(m.max_drawdown)}`;
  }
  if (l.net_apr_pct != null || l.gross_apr_pct != null) {
    return `${l.net_apr_pct != null ? "net" : "gross"} ${fix(l.net_apr_pct ?? l.gross_apr_pct, 1)}% APR`;
  }
  if (l.blocked) return String(l.reason ?? "blocked");
  return "";
}

// The editable basket table: symbol monogram · per-leg Bot-OS strategy (dropdown) · live price ·
// allocation % (edit → auto-rebalance the UNLOCKED legs) · lock toggle.
export function BasketBody({ w, onEdit }: { w: BoardWidget; onEdit?: (id: string, symbol: string, patch: LegPatch) => void }) {
  const data = obj(w.data);
  const legs = arr(data.legs);
  const botTypes = (Array.isArray(data.bot_types) ? (data.bot_types as string[]) : []).filter(Boolean);
  if (!legs.length) return <div className="nx-w-rationale">{w.rationale ?? "Composing basket…"}</div>;
  return (
    <table className="nx-basket"><tbody>
      {legs.map((l, i) => {
        const alloc = Math.round((Number(l.allocation) || 0) * 100);
        const locked = !!l.locked;
        return (
          <tr key={i}>
            <td className="nx-basket-sym"><AssetIcon symbol={String(l.symbol)} kind={legAssetKind(l)} /></td>
            <td className="nx-basket-bot">
              {botTypes.length && onEdit
                ? <select value={String(l.bot ?? "")} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => onEdit(w.id, String(l.symbol), { bot: e.target.value })}>{botTypes.map((bt) => <option key={bt} value={bt}>{bt}</option>)}</select>
                : <span className="nx-basket-botchip">{String(l.bot ?? "—")}</span>}
              {legMetricSummary(l) ? <span className="nx-basket-metric">{legMetricSummary(l)}</span> : null}
            </td>
            <td className="nx-basket-px">{fmtPrice(l.price)}</td>
            <td className="nx-basket-al">
              <input type="number" min={0} max={100} value={alloc} disabled={!onEdit || locked}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => onEdit?.(w.id, String(l.symbol), { allocation: Number(e.target.value) / 100 })} />
              <span>%</span>
            </td>
            <td className="nx-basket-lock">
              <button className={locked ? "on" : ""} disabled={!onEdit} onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onEdit?.(w.id, String(l.symbol), { locked: !locked })} title={locked ? "Unlock allocation" : "Lock allocation"} aria-label={locked ? "Unlock allocation" : "Lock allocation"}>
                <LockGlyph locked={locked} />
              </button>
            </td>
          </tr>
        );
      })}
    </tbody></table>
  );
}

// The DISCOVERY pop-up form. Renders the agent's question schema as inputs; on submit it builds a
// concise natural-language answer string and hands it back via onSubmit (the page sends it as a chat
// message → the agent parses it into a DiscoveryProfile and calls reason_portfolio).
interface IntakeQ { key: string; label: string; type: "number" | "select" | "slider" | "text"; options?: string[]; min?: number; max?: number; default?: number }
export function IntakeBody({ w, onSubmit }: { w: BoardWidget; onSubmit?: (text: string) => void }) {
  const data = obj(w.data);
  const qs = (Array.isArray(data.questions) ? data.questions : []) as IntakeQ[];
  const initialValues = obj(data.initial_values);
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const q of qs) {
      const v = initialValues[q.key];
      if (v !== undefined && v !== null && String(v) !== "") out[q.key] = String(v);
    }
    return out;
  });
  if (!qs.length) return <div className="nx-w-rationale">{w.rationale ?? "Loading questions…"}</div>;
  const set = (k: string, v: string) => setVals((p) => ({ ...p, [k]: v }));
  const submit = () => {
    const parts = qs.map((q) => { const v = vals[q.key] ?? (q.type === "slider" ? String(q.default ?? q.min ?? "") : ""); return v ? `${q.label.replace(/\?$/, "")}: ${v}` : null; }).filter(Boolean);
    onSubmit?.(`My answers — ${parts.join("; ")}. Now synthesize my objective and reason the best expression (hold/leverage/LP) for sensible candidate assets.`);
  };
  return (
    <div className="nx-intake" onPointerDown={(e) => e.stopPropagation()}>
      {w.rationale ? <div className="nx-w-rationale" style={{ marginBottom: 10 }}>{w.rationale}</div> : null}
      {qs.map((q) => (
        <div key={q.key} style={{ marginBottom: 10 }}>
          <div className="nx-intake-label">{q.label}</div>
          {q.type === "number" ? (
            <input className="nx-intake-input" type="number" value={vals[q.key] ?? ""} onChange={(e) => set(q.key, e.target.value)} placeholder="e.g. 5000" />
          ) : q.type === "text" ? (
            <input className="nx-intake-input" type="text" value={vals[q.key] ?? ""} onChange={(e) => set(q.key, e.target.value)} />
          ) : q.type === "slider" ? (
            <div className="nx-intake-slider">
              <input type="range" min={q.min ?? 5} max={q.max ?? 50} value={vals[q.key] ?? String(q.default ?? 15)} onChange={(e) => set(q.key, e.target.value)} />
              <span className="nx-chip ghost">{vals[q.key] ?? String(q.default ?? 15)}%</span>
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(q.options ?? []).map((o) => (
                <button key={o} className={`nx-ask-opt ${vals[q.key] === o ? "on" : ""}`} style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => set(q.key, o)}>{o}</button>
              ))}
            </div>
          )}
        </div>
      ))}
      <button className="nx-intake-go" onClick={submit}>Continue →</button>
    </div>
  );
}

function LockGlyph({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      {locked ? <path d="M8 10V7a4 4 0 0 1 8 0v3" /> : <path d="M8 10V7a4 4 0 0 1 7.2-2.4" />}
      <path d="M12 14v2" />
    </svg>
  );
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
function num(v: unknown): number | null { const n = Number(v); return Number.isFinite(n) ? n : null; }
function pct(v: unknown): string { const n = num(v); return n === null ? "—" : `${(n * 100).toFixed(2)}%`; }
function fix(v: unknown, d = 2): string { const n = num(v); return n === null ? "—" : n.toFixed(d); }
function money(v: unknown): string { const n = num(v); return n === null ? "—" : `$${Math.round(n).toLocaleString()}`; }
function avg(xs: number[]): number | null { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null; }
function sum(xs: number[]): number { return xs.reduce((s, x) => s + x, 0); }
function metricFromExperiment(e: Record<string, unknown>, key: string): number | null { return num(e[key] ?? obj(e.metrics)[key]); }
function bestModeExperiment(exps: Array<Record<string, unknown>>, preferred: string): Record<string, unknown> {
  return exps.find((e) => String(e.mode) === preferred) ?? exps.slice().sort((a, b) => (metricFromExperiment(b, "total_return") ?? -Infinity) - (metricFromExperiment(a, "total_return") ?? -Infinity))[0] ?? {};
}

function Metric({ l, v }: { l: string; v: ReactNode }) {
  return <div className="nx-w-metric"><div className="l">{l}</div><div className="v">{v}</div></div>;
}

function signedPctClass(v: unknown): string {
  const n = num(v);
  if (n === null) return "flat";
  return n >= 0 ? "up" : "down";
}

function MarketMovesTable({ movers, laggards }: { movers: Array<Record<string, unknown>>; laggards: Array<Record<string, unknown>> }) {
  const rows: Array<Record<string, unknown> & { side: string }> = [
    ...movers.slice(0, 6).map((m) => ({ ...m, side: "Mover" })),
    ...laggards.slice(0, 6).map((m) => ({ ...m, side: "Laggard" })),
  ];
  if (!rows.length) return null;
  return (
    <div className="nx-mb-moves-table-wrap">
      <table className="nx-md-table nx-mb-moves-table">
        <thead>
          <tr><th>Side</th><th>Asset</th><th>24h move</th></tr>
        </thead>
        <tbody>
          {rows.map((m, i) => {
          const symbol = String(m.symbol ?? "—");
          const p = num(m.pct24h) ?? 0;
          return (
            <tr className={`nx-mb-move-row ${signedPctClass(p)}`} key={`${String(m.side)}-${symbol}-${i}`}>
              <td><span className={`nx-mb-side ${String(m.side).toLowerCase()}`}>{String(m.side)}</span></td>
              <td><AssetIcon symbol={symbol} /></td>
              <td><b>{p >= 0 ? "+" : ""}{fix(p, 2)}%</b></td>
            </tr>
          );
        })}
        </tbody>
      </table>
    </div>
  );
}

function MarketStatTiles({ gmx }: { gmx: Record<string, unknown> }) {
  if (!gmx.market) return null;
  const stats = [
    ["Market", String(gmx.market)],
    ["Utilization", `${Math.round(num(gmx.utilizationPct) ?? 0)}%`],
    ["OI skew", `${Math.round(num(gmx.oiSkewPct) ?? 0)}%`],
    ["Funding", `~${Math.round(num(gmx.fundingAnnualPct) ?? 0)}%/yr`],
  ];
  return (
    <div className="nx-mb-gmx-card">
      <div className="nx-mb-card-head">
        <span>GMX perp context</span>
        <b>Arbitrum</b>
      </div>
      <div className="nx-mb-stat-grid">
        {stats.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <b>{value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function MarketGuidance({ text }: { text: unknown }) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  return (
    <div className="nx-mb-guidance">
      <div className="nx-mb-guidance-icon">!</div>
      <div>
        <b>LP range guidance</b>
        <p>{t}</p>
      </div>
    </div>
  );
}

function StockSessionCard({ stocks }: { stocks: Record<string, unknown> }) {
  if (!stocks.session) return null;
  const session = String(stocks.session);
  const closed = /closed/i.test(session);
  return (
    <div className={`nx-mb-stock ${closed ? "closed" : "open"}`}>
      <div className="nx-mb-stock-top">
        <span>Stocks</span>
        <b>{session}</b>
      </div>
      <p>{String(stocks.note ?? "Tokenized stock sleeve status unavailable.")}</p>
      <div className="nx-mb-stock-footer">{closed ? "Defer stock actions until quotes refresh." : "Stock sleeve can refresh quotes now."}</div>
    </div>
  );
}

function SourceFreshness({ sources }: { sources: Array<Record<string, unknown>> }) {
  if (!sources.length) return null;
  return (
    <div className="nx-mb-sources">
      {sources.map((s, i) => {
        const status = String(s.status ?? "unknown");
        const asOf = String(s.as_of ?? "");
        return (
          <div className={`nx-mb-source ${status === "ok" ? "ok" : "stale"}`} key={`${String(s.name)}-${i}`}>
            <span>{String(s.name ?? "source")}</span>
            <b>{status}</b>
            <em>{asOf ? asOf.slice(11, 19) : "—"}</em>
          </div>
        );
      })}
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${36 - ((v - min) / span) * 32}`);
  return <svg className="nx-spark" viewBox="0 0 100 40" preserveAspectRatio="none"><path d={`M ${pts.join(" L ")}`} /></svg>;
}

// Interactive equity curve — hover to read the value + return at any point along the run.
function EquityChart({ values }: { values: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const W = 100, H = 44, base = values[0] || 1;
  const xy = values.map((v, i) => [(i / (values.length - 1)) * W, H - ((v - min) / span) * (H - 4) - 2] as const);
  const onMove = (e: ReactMouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    setHover(Math.max(0, Math.min(values.length - 1, Math.round(x * (values.length - 1)))));
  };
  const hv = hover != null ? values[hover] : null;
  return (
    <div className="nx-eq">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="nx-eq-svg" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <path d={`M ${xy[0][0]},${H} L ${xy.map((p) => p.join(",")).join(" L ")} L ${xy[xy.length - 1][0]},${H} Z`} className="nx-eq-fill" />
        <path d={`M ${xy.map((p) => p.join(",")).join(" L ")}`} className="nx-eq-line" />
        {hover != null ? <><line x1={xy[hover][0]} x2={xy[hover][0]} y1={0} y2={H} className="nx-eq-cursor" /><circle cx={xy[hover][0]} cy={xy[hover][1]} r={1.8} className="nx-eq-pt" /></> : null}
      </svg>
      <div className={`nx-eq-tip ${hv == null ? "muted" : ""}`}>{hv == null ? "hover the curve" : `${(((hv - base) / base) * 100).toFixed(2)}% · equity ${hv.toFixed(2)}`}</div>
    </div>
  );
}

// Compact inline body — key numbers per kind.
export function WidgetBody({ w }: { w: BoardWidget }) {
  const d = obj(w.data);
  if (w.state === "running") return <div className="nx-w-rationale">{w.rationale ?? "Working…"}</div>;
  // An errored step (no bars, no regime data, backtest unavailable) has no real metrics — show the
  // reason, never a fabricated 0.00% / -100%.
  if (w.state === "error") return <div className="nx-w-rationale">{w.rationale ?? "Unavailable for this leg/window."}</div>;

  if (w.kind === "backtest" || w.kind === "multiasset") {
    const m = obj(d.metrics ?? d);
    const curve = (Array.isArray(d.equity_curve) ? (d.equity_curve as unknown[]) : []).map(num).filter((x): x is number => x !== null);
    // Hold-only sleeves (e.g. the Robinhood stock sleeve) carry per-leg data, not aggregate metrics —
    // so the generic Return/Sharpe grid renders all "—". Show per-asset price tiles from the legs instead.
    const legs = arr(d.legs);
    const isHoldSleeve = w.kind === "multiasset" && obj(d.metrics).total_return == null && legs.length > 0;
    if (isHoldSleeve) {
      return (
        <>
          {w.rationale ? <div className="nx-w-rationale" style={{ marginBottom: 10 }}>{w.rationale}</div> : null}
          <div className="nx-w-metrics">
            {legs.slice(0, 4).map((l, i) => {
              const price = num(l.priceUsd ?? l.price ?? l.price_usd);
              const day = num(l.changePct);
              return <Metric key={i} l={String(l.token ?? l.symbol ?? `leg ${i + 1}`)}
                v={<span>{price != null ? `$${price.toFixed(2)}` : "—"}{day != null ? <em style={{ fontStyle: "normal", fontSize: 11, marginLeft: 5, color: day >= 0 ? "var(--cyan, #1f9d55)" : "var(--accent, #e0533b)" }}>{day >= 0 ? "+" : ""}{day.toFixed(1)}%</em> : null}</span>} />;
            })}
          </div>
          {legs.length > 4 ? <div className="nx-w-rationale" style={{ marginTop: 8, color: "var(--ink-3)" }}>+{legs.length - 4} more in expanded view</div> : null}
        </>
      );
    }
    return (
      <>
        {w.rationale ? <div className="nx-w-rationale" style={{ marginBottom: 10 }}>{w.rationale}</div> : null}
        <div className="nx-w-metrics">
          <Metric l="Return" v={pct(m.total_return)} />
          <Metric l="Sharpe" v={fix(m.sharpe)} />
          <Metric l="Max DD" v={pct(m.max_drawdown)} />
          <Metric l="Rebalances" v={num(d.rebalances) ?? num(m.bars) ?? "—"} />
        </div>
        {curve.length > 1 ? <Spark values={curve} /> : null}
      </>
    );
  }
  if (w.kind === "optimise") {
    const tested = arr(d.tested ?? obj(d.optimization).tested);
    const vals = tested.map((t) => num(t.sharpe) ?? 0);
    const mx = Math.max(1e-6, ...vals.map(Math.abs));
    return (
      <>
        <div className="nx-w-rationale">{w.rationale ?? `Tested ${tested.length || "—"} thresholds.`}</div>
        {vals.length ? <div className="nx-bars">{vals.map((v, i) => <i key={i} style={{ height: `${Math.max(8, (Math.abs(v) / mx) * 100)}%` }} />)}</div> : null}
        {d.chosen != null ? <div style={{ marginTop: 10 }}><span className="nx-chip">chosen {String(d.chosen)}</span></div> : null}
      </>
    );
  }
  if (w.kind === "bot") {
    const m = obj(d.metrics);
    const curve = (Array.isArray(d.equity_curve) ? (d.equity_curve as unknown[]) : []).map(num).filter((x): x is number => x !== null);
    return (
      <>
        <span className="nx-chip ghost">{String(d.bot ?? "bot")}</span>
        <div className="nx-w-metrics" style={{ marginTop: 10 }}>
          <Metric l="Return" v={pct(m.total_return)} /><Metric l="Sharpe" v={fix(m.sharpe)} />
          <Metric l="Max DD" v={pct(m.max_drawdown)} /><Metric l="Tier" v={<span style={{ fontSize: 12 }}>{String(d.result_tier ?? "—")}</span>} />
        </div>
        {curve.length > 1 ? <Spark values={curve} /> : null}
      </>
    );
  }
  if (w.kind === "strategy") {
    const action = String(d.action ?? "");
    const legs = arr(d.legs);
    return (
      <>
        {action ? <span className={`nx-chip ${action.includes("long") || action === "inverse_vol" || action === "momentum" || action === "equal" ? "" : "ghost"}`}>{action}{d.confidence != null ? ` · ${(num(d.confidence)! * 100).toFixed(0)}%` : ""}</span> : null}
        <div className="nx-w-rationale" style={{ marginTop: action ? 10 : 0 }}>{String(d.rationale ?? w.rationale ?? "Forming a view…")}</div>
        {legs.length ? <div className="nx-w-rationale" style={{ marginTop: 8, color: "var(--ink-2)" }}>{legs.length} legs</div> : null}
      </>
    );
  }
  if (w.kind === "scan") {
    const results = arr(d.results);
    if (results.length) return <div>{results.slice(0, 5).map((r, i) => <span className="nx-news-li" key={i}>{String(r.symbol)} · {fix(r.pct24h, 1)}%</span>)}</div>;
    return <div className="nx-w-rationale">{w.rationale ?? "Screened the live universe."}</div>;
  }
  if (w.kind === "data") {
    const legs = arr(d.legs);
    if (legs.length) return <div>{legs.slice(0, 6).map((l, i) => <span className="nx-news-li" key={i}>{String(l.symbol)}<span style={{ color: "var(--ink-3)" }}> · {num(l.bars) ?? 0} bars</span></span>)}</div>;
    return <div className="nx-w-rationale">{w.rationale ?? "Market data loaded."}</div>;
  }
  if (w.kind === "dex_pool") {
    return (
      <>
        <span className="nx-chip">{String(d.token0_symbol ?? d.base ?? "TOKEN0")}/{String(d.token1_symbol ?? d.quote ?? "TOKEN1")}</span>
        <div className="nx-w-metrics" style={{ marginTop: 10 }}>
          <Metric l="Close" v={fmtPrice(d.latest_close ?? d.close)} />
          <Metric l="Liquidity" v={money(d.latest_liquidity ?? d.liquidity)} />
          <Metric l="Coverage" v={d.latest_coverage_score != null ? fix(d.latest_coverage_score, 2) : "—"} />
          <Metric l="Chain" v={String(d.chain_id ?? "—")} />
        </div>
      </>
    );
  }
  if (w.kind === "quote") {
    return (
      <>
        <div className="nx-w-metrics">
          <Metric l="In" v={fix(d.amountIn, 4)} />
          <Metric l="Out" v={fix(d.expectedOut, 4)} />
          <Metric l="Min" v={fix(d.minOut, 4)} />
          <Metric l="Slip" v={`${fix(d.slippageBps, 0)}bps`} />
        </div>
        <div className="nx-w-rationale" style={{ marginTop: 8 }}>{String(d.source ?? obj(d.truth).execution_fidelity ?? "modeled AMM quote")}</div>
      </>
    );
  }
  if (w.kind === "bybit_dex") {
    return (
      <div className="nx-w-metrics">
        <Metric l="Bybit" v={fmtPrice(obj(d.bybit).close)} />
        <Metric l="DEX" v={fmtPrice(obj(d.dex).close)} />
        <Metric l="Divergence" v={d.divergenceBps != null ? `${fix(d.divergenceBps, 1)}bps` : "—"} />
        <Metric l="Source" v={String(obj(d.truth).data_source ?? "blended")} />
      </div>
    );
  }
  if (w.kind === "onchain_truth") {
    const truth = Object.keys(obj(d.truth)).length ? obj(d.truth) : d;
    return (
      <div className="nx-w-metrics">
        <Metric l="Tier" v={String(truth.result_tier ?? "LOCAL ONLY")} />
        <Metric l="Source" v={String(truth.data_source ?? "dex")} />
        <Metric l="Fidelity" v={String(truth.execution_fidelity ?? "amm_mid_only")} />
        <Metric l="Real $" v={truth.can_execute_real_money === true ? "yes" : "no"} />
      </div>
    );
  }
  if (w.kind === "news") {
    const items = arr(d.items);
    if (items.length) return <div>{items.slice(0, 4).map((n, i) => <span className="nx-news-li" key={i}>{n.link ? <a href={String(n.link)} target="_blank" rel="noopener noreferrer">{String(n.title).slice(0, 64)}</a> : String(n.title).slice(0, 64)}<span style={{ color: "var(--ink-3)" }}> — {String(n.source ?? "")}</span></span>)}</div>;
    return <div className="nx-w-rationale">{w.rationale ?? "Pulled recent headlines."}</div>;
  }
  if (w.kind === "market_briefing") {
    // The "Context Inspector": exactly what the agent was given at turn start (3 sleeves + sources).
    const c = obj(d.crypto); const lp = obj(d.lp); const stocks = obj(d.stocks);
    const fg = obj(c.fearGreed);
    const movers = arr(c.movers); const pools = arr(lp.topPools); const gmx = obj(lp.gmx);
    const sources = arr(d.sources);
    const regime = String(c.regime ?? "");
    const regimeClass = regime === "RISK-ON" ? "" : "ghost";
    return (
      <>
        {c.regime != null ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8, alignItems: "center" }}>
            <span className={`nx-chip ${regimeClass}`}>{regime}</span>
            <span className="nx-chip ghost">breadth {num(c.breadthPctUp) ?? "—"}%</span>
            {c.btc24h != null ? <span className="nx-chip ghost">BTC {pct((num(c.btc24h) ?? 0) / 100)}</span> : null}
            {c.eth24h != null ? <span className="nx-chip ghost">ETH {pct((num(c.eth24h) ?? 0) / 100)}</span> : null}
            {fg.value != null ? <span className="nx-chip">F&G {num(fg.value)} · {String(fg.classification ?? "")}</span> : null}
          </div>
        ) : null}
        {movers.length ? <div className="nx-w-rationale" style={{ marginBottom: 6 }}>Movers: {movers.map((m) => `${String(m.symbol)} ${pct((num(m.pct24h) ?? 0) / 100)}`).join(", ")}</div> : null}
        {pools.length ? <div className="nx-w-rationale" style={{ marginBottom: 6 }}>LP: {pools.slice(0, 2).map((p) => `${String(p.pair)} ${num(p.feeTierPct)}% ~${num(p.feeAprPct)}% APR`).join(" · ")}{gmx.market ? ` · GMX util ${Math.round(num(gmx.utilizationPct) ?? 0)}%` : ""}</div> : null}
        {stocks.session ? <div className="nx-w-rationale" style={{ marginBottom: 6 }}>Stocks: session {String(stocks.session)}</div> : null}
        {sources.length ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
            {sources.map((s, i) => <span key={i} className={`nx-chip ${String(s.status) === "ok" ? "ghost" : ""}`} style={{ fontSize: 10, opacity: String(s.status) === "ok" ? 1 : 0.55 }}>{String(s.name)}{String(s.status) === "ok" ? "" : " ·n/a"}</span>)}
          </div>
        ) : null}
      </>
    );
  }
  if (w.kind === "lp_position") {
    const positions = arr(d.positions); const totals = obj(d.totals);
    if (!positions.length) return <div className="nx-w-rationale">{w.rationale ?? "No open positions."}</div>;
    return (
      <>
        {totals.netVsHodlUsd != null ? <div style={{ marginBottom: 6 }}><span className={`nx-chip ${(num(totals.netVsHodlUsd) ?? 0) >= 0 ? "" : "ghost"}`}>net vs HODL {(num(totals.netVsHodlUsd) ?? 0) >= 0 ? "+" : ""}{money(totals.netVsHodlUsd)}</span> <span className="nx-chip ghost">value {money(totals.currentValueUsd)}</span></div> : null}
        {positions.slice(0, 4).map((p, i) => (
          <div key={i} className="nx-w-rationale" style={{ fontSize: 11, marginBottom: 4 }}>
            <b>{String(p.pair)} {num(p.feeTierPct)}%</b> <span className={`nx-chip ${p.inRange ? "" : "ghost"}`} style={{ fontSize: 9, padding: "1px 5px" }}>{p.inRange ? "in range" : "OUT"}</span>
            <span style={{ color: "var(--ink-3)" }}> · val {money(p.currentValueUsd)} · IL {fix(p.ilPct, 1)}% · vs HODL {(num(p.netVsHodlPct) ?? 0) >= 0 ? "+" : ""}{fix(p.netVsHodlPct, 1)}%</span>
          </div>
        ))}
      </>
    );
  }
  if (w.kind === "firm_debate") {
    const an = obj(d.analysts); const deb = obj(d.debate); const risk = obj(d.risk);
    const Row = ({ role, txt }: { role: string; txt: unknown }) => txt ? <div className="nx-w-rationale" style={{ fontSize: 11, marginBottom: 4 }}><b>{role}:</b> {String(txt).slice(0, 140)}</div> : null;
    return (
      <>
        <div style={{ marginBottom: 6 }}><span className="nx-chip">{String(d.action ?? "")}{d.confidence != null ? ` · ${Math.round((num(d.confidence) ?? 0) * 100)}%` : ""}</span></div>
        <Row role="Technical" txt={an.technical} />
        <Row role="Sentiment" txt={an.sentiment} />
        <Row role="On-chain" txt={an.onchain} />
        <Row role="Bull" txt={deb.bull} />
        <Row role="Bear" txt={deb.bear} />
        {risk.state ? <div className="nx-w-rationale" style={{ fontSize: 11, color: risk.allowed ? "var(--ink-3)" : "var(--danger, #e66)" }}><b>Risk:</b> {String(risk.note ?? risk.state)}</div> : null}
      </>
    );
  }
  if (w.kind === "knowledge_lib") {
    const docs = arr(d.docs); const last = obj(d.last);
    return (
      <>
        {last.title ? <div className="nx-w-rationale" style={{ marginBottom: 6 }}>{last.status === "ready" ? `Ingested “${String(last.title)}” · ${num(last.chunks) ?? 0} chunks` : `Failed: ${String(last.error ?? "")}`}</div> : null}
        {docs.length ? <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>{docs.slice(0, 6).map((doc, i) => (
          <div key={i} className="nx-w-rationale" style={{ fontSize: 11 }}>
            {doc.global ? "🌐 " : ""}{String(doc.title).slice(0, 48)} <span style={{ color: "var(--ink-3)" }}>· {String(doc.kind)} · {num(doc.chunk_count) ?? 0} chunks</span>
          </div>
        ))}</div> : <div className="nx-w-rationale">Library is empty — add a book or article.</div>}
      </>
    );
  }
  if (w.kind === "knowledge_cite") {
    const hits = arr(d.hits);
    if (!hits.length) return <div className="nx-w-rationale">{w.rationale ?? "No relevant passages."}</div>;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {hits.slice(0, 3).map((h, i) => (
          <div key={i} className="nx-w-rationale" style={{ fontSize: 11 }}>
            <b>{String(h.citation).slice(0, 60)}</b> <span style={{ color: "var(--ink-3)" }}>· {Math.round((num(h.similarity) ?? 0) * 100)}%</span>
            <div style={{ color: "var(--ink-2)", marginTop: 2 }}>{String(h.text).slice(0, 160)}…</div>
          </div>
        ))}
      </div>
    );
  }
  if (w.kind === "onchain_context") {
    const pool = obj(d.pool); const gmx = obj(d.gmx); const sent = obj(d.sentiment);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {pool.pair ? <div className="nx-w-rationale">LP: {String(pool.pair)}{pool.feeTierPct != null ? ` ${num(pool.feeTierPct)}%` : ""} · fee APR ~{num(pool.feeAprPct)}% · TVL {money(pool.tvlUsd)}</div> : null}
        {gmx.market ? <div className="nx-w-rationale">GMX OI skew {num(gmx.oiSkewPct)}% · funding {num(gmx.fundingAnnualPct)}%/yr{gmx.borrowAnnualPct != null ? ` · borrow ${num(gmx.borrowAnnualPct)}%/yr` : ""} · util {num(gmx.utilizationPct)}%</div> : null}
        {sent.label ? <div className="nx-w-rationale" style={{ color: "var(--ink-3)" }}>Sentiment: {String(sent.label)} ({num(sent.score)})</div> : null}
      </div>
    );
  }
  if (w.kind === "sentiment_gauge") {
    const comps = arr(d.components); const fg = obj(d.fearGreed);
    const score = num(d.score) ?? 0;
    const tone = score > 0.15 ? "" : "ghost";
    return (
      <>
        <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`nx-chip ${tone}`}>{String(d.label ?? "")} {score >= 0 ? "+" : ""}{score}</span>
          {fg.value != null ? <span className="nx-chip ghost">F&G {num(fg.value)}</span> : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {comps.map((c, i) => (
            <div key={i} className="nx-w-rationale" style={{ fontSize: 11, opacity: String(c.status) === "ok" ? 1 : 0.5 }}>
              {String(c.source)}: {String(c.status) === "ok" ? `${num(c.score)} — ${String(c.detail)}` : "unavailable"}
            </div>
          ))}
        </div>
      </>
    );
  }
  if (w.kind === "lp_screen") {
    const ranked = arr(d.ranked);
    if (!ranked.length) return <div className="nx-w-rationale">{w.rationale ?? "Screening pools…"}</div>;
    return (
      <table className="nx-md-table"><thead><tr><th></th><th>Pool</th><th>Net APR</th><th>Gross</th><th>TVL</th></tr></thead>
        <tbody>{ranked.slice(0, 6).map((p, i) => (
          <tr key={i} style={{ fontWeight: i === 0 ? 700 : 400 }}>
            <td>{i === 0 ? "★" : i + 1}</td>
            <td>{String(p.pair ?? "")}{p.feeTierPct != null ? ` ${num(p.feeTierPct)}%` : ""}</td>
            <td>{p.netAprPct != null ? `${num(p.netAprPct)}%` : "—"}</td>
            <td style={{ color: "var(--ink-3)" }}>{num(p.grossFeeAprPct) ?? "—"}%</td>
            <td>{money(p.tvlUsd)}</td>
          </tr>
        ))}</tbody>
      </table>
    );
  }
  if (w.kind === "lp_range_opt") {
    const curve = arr(d.curve); const best = obj(d.best);
    if (!curve.length) return <div className="nx-w-rationale">{w.rationale ?? "Optimizing range…"}</div>;
    const nets = curve.map((p) => num(p.netAprPct) ?? 0);
    return (
      <>
        <EquityChart values={nets} />
        <div className="nx-w-rationale" style={{ marginTop: 6 }}>
          Best: ±{num(best.bandHalfWidthPct) ?? "—"}% band · net {num(best.netAprPct) ?? "—"}% APR · {num(best.timeInRangePct) ?? "—"}% in-range
        </div>
      </>
    );
  }
  if (w.kind === "dune_panel") {
    const status = String(d.status ?? "");
    // Not-ok panels (Dune unconfigured / no query id / error) show the honest reason, never fake rows.
    if (status && status !== "ok") return <div className="nx-w-rationale">{String(d.reason ?? w.rationale ?? "Dune query unavailable.")}</div>;
    const cols = (Array.isArray(d.columns) ? d.columns : []).map(String);
    const rows = arr(d.rows);
    if (!rows.length) return <div className="nx-w-rationale">{w.rationale ?? "Querying Dune…"}</div>;
    const sourceLabel = d.source === "gmx_api_fallback" ? "GMX API fallback" : "Dune";
    return (
      <>
        <DuneTable columns={cols} rows={rows} maxCols={3} maxRows={4} />
        <div className="nx-w-rationale" style={{ marginTop: 8, color: "var(--ink-3)" }}>
          {sourceLabel} · {num(d.row_count) ?? rows.length} rows · {d.cached ? "cached" : d.source === "gmx_api_fallback" ? "live GMX" : "fresh"}{d.query_id != null ? ` · q${String(d.query_id)}` : " · no Dune query id"}
        </div>
        {d.reason ? <div className="nx-w-rationale" style={{ marginTop: 4, color: "var(--ink-3)" }}>{String(d.reason)}</div> : null}
      </>
    );
  }
  if (w.kind === "objective") {
    const wt = obj(d.weights); const hc = obj(d.hardConstraints);
    return (
      <>
        <div className="nx-w-rationale" style={{ marginBottom: 8 }}>{String(d.statement ?? w.rationale ?? "")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <span className="nx-chip ghost">maxDD ≤ {num(hc.maxDrawdownPct) ?? "—"}%</span>
          <span className="nx-chip ghost">lev ≤ {num(hc.maxLeverage) ?? "—"}×</span>
          {d.preferMarketNeutral ? <span className="nx-chip">market-neutral</span> : null}
          {Object.entries(wt).filter(([, v]) => num(v)).sort((a, b) => (num(b[1]) ?? 0) - (num(a[1]) ?? 0)).slice(0, 2).map(([k, v]) => <span className="nx-chip" key={k}>{k} {Math.round((num(v) ?? 0) * 100)}%</span>)}
        </div>
      </>
    );
  }
  if (w.kind === "mode_router") {
    const exps = arr(d.experiments); const rec = String(d.recommended ?? "");
    if (!exps.length) return <div className="nx-w-rationale">{w.rationale ?? "Backtesting expressions…"}</div>;
    return (
      <>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          {exps.map((e, i) => <span key={i} className={`nx-chip ${String(e.mode) === rec ? "" : "ghost"}`}>{String(e.mode)}{String(e.mode) === rec ? " ★" : ""}: {pct(e.total_return)}</span>)}
        </div>
        <div className="nx-w-rationale">{String(d.rationale ?? "")}</div>
      </>
    );
  }
  if (w.kind === "hold_vs_trade_vs_lp") {
    // Consolidated multi-asset payload (data.assets[]) OR single-asset fallback (data.experiments).
    const assets = arr(d.assets);
    const rows = (assets.length
      ? assets
      : [{ symbol: d.symbol, recommended: d.recommended, experiments: d.experiments, detail: "", venue: "" }]) as Array<Record<string, unknown>>;
    const MODE_COL: Record<string, string> = { hold: "#46e0ff", leverage: "#ff5a1f", lp: "#ffce3a" };
    const MODE_LBL: Record<string, string> = { hold: "Hold", leverage: "Leverage", lp: "LP" };
    const visible = rows.slice(0, 3);
    return (
      <div className="nx-hvl">
        {visible.map((a, ai) => {
          const exps = arr(a.experiments);
          if (!exps.length) return null;
          const rec = String(a.recommended ?? "");
          const sym = String(a.symbol ?? "");
          const best = bestModeExperiment(exps, rec);
          const ret = metricFromExperiment(best, "total_return");
          const dd = metricFromExperiment(best, "max_drawdown");
          return (
            <div className="nx-pick-row" key={ai} title={String(a.detail ?? a.rationale ?? "")}>
              <span className="nx-pick-sym"><AssetIcon symbol={sym} kind={legAssetKind({ symbol: sym, sleeve: rec === "lp" ? "lp" : undefined, venue: String(a.venue ?? "") })} /></span>
              <span className="nx-pick-bar"><i style={{ width: `${Math.min(100, Math.max(8, Math.round(Math.abs(ret ?? 0) * 100)))}%`, background: MODE_COL[rec] ?? "#ff5a1f" }} /></span>
              <span className="nx-pick-score">{MODE_LBL[rec] ?? rec} · {pct(ret)}{dd != null ? ` / DD ${pct(dd)}` : ""}</span>
            </div>
          );
        })}
        {rows.length > visible.length ? <div className="nx-w-rationale" style={{ marginTop: 6, color: "var(--ink-3)" }}>+{rows.length - visible.length} more assets in expanded view</div> : null}
      </div>
    );
  }
  if (w.kind === "reasoning") {
    const rejected = arr(d.rejected);
    return (
      <>
        <span className="nx-chip">→ {String(d.recommended ?? "")}{d.objectiveFit != null ? ` · fit ${Math.round((num(d.objectiveFit) ?? 0) * 100)}` : ""}</span>
        <div className="nx-w-rationale" style={{ marginTop: 8 }}>{String(d.rationale ?? "")}</div>
        {rejected.length ? <div className="nx-w-rationale" style={{ marginTop: 6, color: "var(--ink-3)" }}>rejected: {rejected.map((r) => `${String(r.mode)}`).join(", ")}</div> : null}
        {d.source === "fallback" ? <div className="nx-w-rationale" style={{ marginTop: 4, color: "var(--ink-3)", fontSize: 11 }}>heuristic fallback (no model configured)</div> : null}
      </>
    );
  }
  if (w.kind === "lp_compare") {
    const cands = arr(d.candidates);
    if (!cands.length) return <div className="nx-w-rationale">{w.rationale ?? "Comparing pools…"}</div>;
    return (
      <div>
        {cands.slice(0, 5).map((c, i) => {
          const s = num(c.score) ?? 0; const isPick = i === 0;
          return (
            <div className="nx-pick-row" key={i} title={String(c.rationale ?? "")}>
              <span className="nx-pick-sym" style={{ fontWeight: isPick ? 700 : 500 }}>{isPick ? "★ " : ""}{lpVenueShort(c.venue)}{c.feeTierPct != null ? ` ${num(c.feeTierPct)}%` : ""}</span>
              <span className="nx-pick-bar"><i style={{ width: `${Math.round(s * 100)}%` }} /></span>
              <span className="nx-pick-score">{num(c.feeAprPct) ? `${fix(c.feeAprPct, 1)}%` : Math.round(s * 100)}</span>
            </div>
          );
        })}
      </div>
    );
  }
  if (w.kind === "lp_pool") {
    return (
      <div className="nx-w-metrics">
        <Metric l="Venue" v={lpVenueShort(d.venue)} />
        <Metric l="Fee APR" v={num(d.feeAprPct) ? `${fix(d.feeAprPct, 1)}%` : "—"} />
        <Metric l="TVL" v={money(d.tvlUsd)} />
        <Metric l="IL risk" v={String(d.ilRisk ?? "—")} />
      </div>
    );
  }
  if (w.kind === "il_curve") {
    const band = obj(d.band);
    const curve = arr(d.ilCurve).map((p) => num(p.il) ?? 0);
    return (
      <>
        <div className="nx-w-metrics">
          <Metric l="Band" v={`${fix(band.lowerPct, 1)}% / +${fix(band.upperPct, 1)}%`} />
          <Metric l="In-range" v={num(d.timeInRangePct) != null ? `${fix(d.timeInRangePct, 0)}%` : "—"} />
          <Metric l="Cap.eff" v={num(d.capitalEfficiency) != null ? `${fix(d.capitalEfficiency, 1)}×` : "—"} />
          <Metric l="Vol/yr" v={num(d.realizedVolAnnualPct) != null ? `${fix(d.realizedVolAnnualPct, 0)}%` : "—"} />
        </div>
        {curve.length > 1 ? <Spark values={curve} /> : null}
      </>
    );
  }
  if (w.kind === "venue_route") {
    return (
      <>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <span className="nx-chip">{lpVenueShort(d.venue) || String(d.venue ?? "")}</span>
          <span className="nx-chip ghost">{String(d.mode ?? "")}</span>
          {d.leverage != null ? <span className="nx-chip ghost">{String(d.leverage)}×</span> : null}
        </div>
        <div className="nx-w-rationale">{String(d.why ?? w.rationale ?? "")}</div>
        {d.liquidity_usd != null ? <div className="nx-w-rationale" style={{ marginTop: 6, color: "var(--ink-3)" }}>liquidity {money(d.liquidity_usd)}</div> : null}
      </>
    );
  }
  if (w.kind === "glv_vault") {
    const mkts = arr(d.markets);
    return (
      <>
        <div className="nx-w-metrics">
          <Metric l="Vault TVL" v={money(d.totalUsd)} />
          <Metric l="GM pools" v={mkts.length || "—"} />
          <Metric l="Pair" v={`${String(d.longSymbol ?? "")}/${String(d.shortSymbol ?? "")}`} />
          <Metric l="Listed" v={d.listingDate ? String(d.listingDate).slice(0, 10) : "—"} />
        </div>
        {mkts.length ? <div className="nx-w-rationale" style={{ marginTop: 8, color: "var(--ink-3)" }}>top: {mkts.slice(0, 3).map((m) => `${money(m.balanceUsd)} (${fix(m.sharePct, 0)}%)`).join(" · ")}</div> : null}
      </>
    );
  }
  if (w.kind === "gmx_market") {
    return (
      <>
        <div className="nx-w-metrics">
          <Metric l="Index px" v={fmtPrice(d.indexPriceUsd)} />
          <Metric l="Funding≈" v={num(d.fundingAnnualPct) != null ? `${fix(d.fundingAnnualPct, 1)}%/yr` : "—"} />
          <Metric l="OI L/S" v={`${money(d.oiLongUsd)}/${money(d.oiShortUsd)}`} />
          <Metric l="Liquidity" v={money(d.availableLiquidityUsd)} />
        </div>
        <div className="nx-w-rationale" style={{ marginTop: 8, color: "var(--ink-3)" }}>{String(d.name ?? "")}{d.listingDate ? ` · listed ${String(d.listingDate).slice(0, 10)}` : ""}</div>
      </>
    );
  }
  if (w.kind === "lp_backtest") {
    const m = obj(d.metrics);
    const curve = (Array.isArray(d.equity_curve) ? (d.equity_curve as unknown[]) : []).map(num).filter((x): x is number => x !== null);
    if (d.error) return <div className="nx-w-rationale">{String(d.error)}</div>;
    return (
      <>
        <div className="nx-w-metrics">
          <Metric l="Return" v={pct(m.total_return)} />
          <Metric l="Fee APR" v={num(d.fee_apr_pct) != null ? `${fix(d.fee_apr_pct, 1)}%` : "—"} />
          <Metric l="IL drag" v={num(d.il_drag_pct) != null ? `${fix(d.il_drag_pct, 1)}%` : "—"} />
          <Metric l="In-range" v={num(d.time_in_range_pct) != null ? `${fix(d.time_in_range_pct, 0)}%` : "—"} />
        </div>
        {curve.length > 1 ? <Spark values={curve} /> : null}
        <div className="nx-w-rationale" style={{ marginTop: 6, color: "var(--ink-3)" }}>{num(d.rebalances) ?? 0} rebalances · Sharpe {fix(m.sharpe)} · {String(obj(d.truth).result_tier ?? "LOCAL_SIM")}</div>
      </>
    );
  }
  if (w.kind === "funding_carry") {
    const ny = obj(d.netYield); const carry = obj(d.carry);
    return (
      <>
        <div className="nx-w-metrics">
          <Metric l="Net APR" v={num(ny.netAprPct) != null ? `${fix(ny.netAprPct, 1)}%` : "—"} />
          <Metric l="Gross fees" v={num(ny.grossFeeAprPct) != null ? `${fix(ny.grossFeeAprPct, 1)}%` : "—"} />
          <Metric l="IL drag" v={num(ny.ilDragAprPct) != null ? `${fix(ny.ilDragAprPct, 1)}%` : "—"} />
          <Metric l="Funding" v={num(carry.fundingRateAnnualPct) != null ? `${fix(carry.fundingRateAnnualPct, 1)}%` : "—"} />
        </div>
        <div className="nx-w-rationale" style={{ marginTop: 8 }}>{String(carry.hedgeNote ?? w.rationale ?? "")}</div>
      </>
    );
  }
  if (w.kind === "factors") {
    const tokens = arr(d.tokens);
    if (!tokens.length) return <div className="nx-w-rationale">{w.rationale ?? "Scoring factors…"}</div>;
    return (
      <div>
        {tokens.slice(0, 5).map((t, i) => {
          const c = num(t.composite) ?? 0;
          return (
            <div className="nx-pick-row" key={i}>
              <span className="nx-pick-sym"><AssetIcon symbol={String(t.symbol)} /></span>
              <span className="nx-pick-bar"><i style={{ width: `${Math.round(c * 100)}%` }} /></span>
              <span className="nx-pick-score">{Math.round(c * 100)}</span>
            </div>
          );
        })}
      </div>
    );
  }
  if (w.kind === "screen") {
    const picks = arr(d.picks);
    const stockRows = arr(d["x" + "stocks"]);
    if (!picks.length) return <div className="nx-w-rationale">{w.rationale ?? "Ranking picks…"}</div>;
    return (
      <div>
        {picks.slice(0, 5).map((p, i) => {
          const c = num(p.composite) ?? 0;
          return (
            <div className="nx-pick-row" key={i}>
              <span className="nx-pick-rank">{num(p.rank) ?? i + 1}</span>
              <span className="nx-pick-sym"><AssetIcon symbol={String(p.symbol)} /></span>
              <span className="nx-pick-bar"><i style={{ width: `${Math.round(c * 100)}%` }} /></span>
              <span className="nx-pick-score">{Math.round(c * 100)}</span>
            </div>
          );
        })}
        {stockRows.length ? <div className="nx-w-rationale" style={{ marginTop: 8, color: "var(--ink-2)" }}>Stocks: {stockRows.slice(0, 4).map((x) => baseSym(x.symbol)).join(", ")}</div> : null}
      </div>
    );
  }

  if (w.kind === "refine") {
    const m = obj(d.metrics);
    return (
      <>
        <div className="nx-w-rationale">{w.rationale ?? "Improving the basket…"}</div>
        {Object.keys(m).length ? <div className="nx-w-metrics" style={{ marginTop: 10 }}>
          <Metric l="Recent" v={pct(m.total_return)} /><Metric l="Sharpe" v={fix(m.sharpe)} />
        </div> : null}
      </>
    );
  }
  if (w.kind === "regime") {
    const bull = obj(d.bull); const bear = obj(d.bear);
    const ba = obj(bull.aggregate); const ra = obj(bear.aggregate);
    const seasons = arr(d.seasons);
    const perToken = arr(d.per_token);
    const bullAvg = (() => {
      const v = num(ba.avg_return);
      if (v !== null && Math.abs(v) > 1e-9) return v;
      return avg(perToken.map((p) => num(p.bull_avg)).filter((x): x is number => x !== null));
    })();
    const bearAvg = (() => {
      const v = num(ra.avg_return);
      if (v !== null && Math.abs(v) > 1e-9) return v;
      return avg(perToken.map((p) => num(p.bear_avg)).filter((x): x is number => x !== null));
    })();
    const bullCount = num(ba.n) || sum(perToken.map((p) => num(p.bull_count) ?? 0));
    const bearCount = num(ra.n) || sum(perToken.map((p) => num(p.bear_count) ?? 0));
    const worstDd = num(bear.worst_drawdown) ?? avg(perToken.map((p) => num(p.bear_worst_drawdown)).filter((x): x is number => x !== null));
    return (
      <>
        <div className="nx-w-metrics">
          <Metric l={`Bull avg (${bullCount})`} v={pct(bullAvg)} />
          <Metric l={`Bear avg (${bearCount})`} v={pct(bearAvg)} />
          <Metric l="Bull win%" v={ba.win_rate != null ? `${Math.round((num(ba.win_rate) ?? 0) * 100)}%` : "—"} />
          <Metric l="Worst DD" v={pct(worstDd)} />
        </div>
        <div className="nx-w-rationale" style={{ marginTop: 8 }}>{seasons.length} seasons{d.span ? ` · ${String(d.span)}` : ""}</div>
      </>
    );
  }

  // truth / risk / position → scalar chips
  const chips = Object.entries(d).filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean").slice(0, 6);
  if (chips.length) return <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{chips.map(([k, v]) => <span className="nx-chip ghost" key={k}>{k}: {String(v)}</span>)}</div>;
  return <div className="nx-w-rationale">{w.rationale ?? "Done."}</div>;
}

// Render a Dune result as a compact table (a generic on-chain data grid). Numbers are right-aligned
// and lightly formatted; everything renders straight from the adapter payload — no fabricated cells.
function duneCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(Number(v.toPrecision(6)));
  const s = String(v);
  return s.length > 22 ? s.slice(0, 10) + "…" + s.slice(-6) : s; // truncate hashes/addresses in the middle
}
function DuneTable({ columns, rows, maxCols, maxRows }: { columns: string[]; rows: Array<Record<string, unknown>>; maxCols?: number; maxRows?: number }) {
  const cols = (columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : [])).slice(0, maxCols ?? 8);
  const body = rows.slice(0, maxRows ?? 40);
  if (!cols.length || !body.length) return null;
  return (
    <table className="nx-md-table">
      <thead><tr>{cols.map((c) => <th key={c} title={c}>{c.length > 14 ? c.slice(0, 13) + "…" : c}</th>)}</tr></thead>
      <tbody>{body.map((r, i) => <tr key={i}>{cols.map((c) => { const v = r[c]; return <td key={c} style={typeof v === "number" ? { textAlign: "right", fontVariantNumeric: "tabular-nums" } : undefined}>{duneCell(v)}</td>; })}</tr>)}</tbody>
    </table>
  );
}

// The factor heatmap: rows = tokens, columns = each factor (0..1, color-scaled) + the composite. This
// is the "show your work" view of the multi-factor screen.
function FactorHeatmap({ rows, factorKeys, ranked }: { rows: Array<Record<string, unknown>>; factorKeys: string[]; ranked?: boolean }) {
  if (!rows.length) return null;
  return (
    <table className="nx-md-table nx-heat-table">
      <thead>
        <tr>
          {ranked ? <th>#</th> : null}
          <th>Token</th>
          {factorKeys.map((k) => <th key={k} title={k}>{FACTOR_LABEL[k] ?? k}</th>)}
          <th>Score</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const f = obj(r.factors);
          const comp = num(r.composite);
          return (
            <tr key={i}>
              {ranked ? <td>{num(r.rank) ?? i + 1}</td> : null}
              <td><AssetIcon symbol={String(r.symbol)} /></td>
              {factorKeys.map((k) => { const v = num(f[k]); return <td key={k} className="nx-heat" style={heatStyle(v)}>{v === null ? "—" : Math.round(v * 100)}</td>; })}
              <td className="nx-heat" style={{ ...heatStyle(comp), fontWeight: 700 }}>{comp === null ? "—" : Math.round(comp * 100)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Tokenized-equity sleeve: a neat per-stock card grid (price · day move · 1Y/Sharpe/maxDD) built from
// the live StockLeg shape, replacing the run-on rationale blob the agent emits.
function StockSleeveCards({ legs, note }: { legs: Array<Record<string, unknown>>; note?: string }) {
  if (!legs.length) return <p className="nx-md-reco">Stock sleeve unavailable — no live quotes.</p>;
  return (
    <div className="nx-stk">
      <div className="nx-md-h">Tokenized equities · Robinhood Chain testnet · hold-only</div>
      <div className="nx-stk-grid">
        {legs.map((l, i) => {
          const sym = String(l.symbol ?? "");
          const token = String(l.token ?? (sym ? "d" + sym : "—"));
          const price = num(l.priceUsd ?? l.price ?? l.price_usd);
          const day = num(l.changePct);
          const m = obj(l.metrics);
          const ret = num(m.total_return);
          const sharpe = num(m.sharpe);
          const dd = num(m.max_drawdown);
          const viaChainlink = String(l.priceSource ?? "") === "chainlink_aggv3_standin";
          const priceStale = l.priceStale === true;
          return (
            <div className="nx-stk-card" key={i}>
              <div className="nx-stk-top">
                <span className="nx-stk-logo"><TokenIcon symbol={sym} kind="equity" size={26} pair={false} /></span>
                <div className="nx-stk-id">
                  <span className="nx-stk-tok">{token}</span>
                  <span className="nx-stk-name">{sym} · spot 1×</span>
                </div>
                <div className="nx-stk-px">
                  <span className="nx-stk-price">{price != null ? "$" + price.toFixed(2) : "—"}</span>
                  {day != null ? <span className={`nx-stk-day ${day >= 0 ? "up" : "down"}`}>{day >= 0 ? "+" : ""}{day.toFixed(1)}%</span> : null}
                </div>
              </div>
              {price != null ? (
                <div className="nx-stk-src" title={viaChainlink ? "Live price from the on-chain Chainlink AggregatorV3-compatible vault oracle" : "On-chain feed unavailable — fell back to Yahoo"}>
                  <span className={`nx-stk-srcdot ${viaChainlink ? "on" : "off"}`} />
                  {viaChainlink ? "Chainlink feed" : "Yahoo fallback"}{priceStale ? " · stale" : ""}
                </div>
              ) : null}
              <div className="nx-stk-metrics">
                <div><span>1Y</span><b className={ret != null ? (ret >= 0 ? "up" : "down") : ""}>{ret != null ? (ret >= 0 ? "+" : "") + (ret * 100).toFixed(1) + "%" : "—"}</b></div>
                <div><span>Sharpe</span><b>{sharpe != null ? sharpe.toFixed(2) : "—"}</b></div>
                <div><span>Max DD</span><b>{dd != null ? (dd * 100).toFixed(1) + "%" : "—"}</b></div>
              </div>
            </div>
          );
        })}
      </div>
      {note ? <p className="nx-stk-note">{note}</p> : null}
    </div>
  );
}

// Full detail for the expand MODAL — tables + every available field.
export function WidgetDetail({ w }: { w: BoardWidget }) {
  const d = obj(w.data);
  const sections: ReactNode[] = [];
  // Tokenized-equity sleeve gets a purpose-built metric grid instead of the run-on rationale blob.
  const isStockSleeve = w.kind === "multiasset" && String(d.sleeve ?? "").toLowerCase() === "stock";
  if (isStockSleeve) {
    sections.push(<StockSleeveCards key="stock-cards" legs={arr(d.legs)} note={d.note ? String(d.note) : undefined} />);
  } else if (w.rationale) {
    sections.push(<p className="nx-md-reco" key="r">{w.rationale}</p>);
  }

  // Factor analysis widget → the full heatmap across every scored candidate.
  const factorKeys = (Array.isArray(d.factor_keys) ? d.factor_keys : []).map(String);
  const tokens = arr(d.tokens);
  if (tokens.length && factorKeys.length) {
    sections.push(<div key="fh"><div className="nx-md-h">Factor scores (0–100, vs peers)</div><FactorHeatmap rows={tokens} factorKeys={factorKeys} /></div>);
  }

  // Top-picks (screen) widget -> ranked crypto heatmap + the per-pick rationale + the stock block.
  const picks = arr(d.picks);
  if (picks.length && factorKeys.length) {
    sections.push(<div key="ph"><div className="nx-md-h">Top crypto picks</div><FactorHeatmap rows={picks} factorKeys={factorKeys} ranked /></div>);
    sections.push(
      <div key="pr"><div className="nx-md-h">Why these</div>{picks.map((p, i) => (
        <div className="nx-md-news" key={i}>
          <b>#{num(p.rank) ?? i + 1} {baseSym(p.symbol)}</b> <span className="nx-md-news-src">· {fix(p.composite ? num(p.composite)! * 100 : null, 0)} score · 24h {fix(p.pct24h, 1)}% · RSI {p.rsi != null ? String(p.rsi) : "—"}{p.news_score != null ? ` · news ${fix(p.news_score, 2)}` : ""}</span>
          <div style={{ color: "var(--ink-2)", marginTop: 2 }}>{String(p.rationale ?? "")}</div>
        </div>
      ))}</div>,
    );
    const stockRows = arr(d["x" + "stocks"]);
    if (stockRows.length) sections.push(<div key="stocks"><div className="nx-md-h">Best stocks</div><FactorHeatmap rows={stockRows} factorKeys={factorKeys.filter((k) => k !== "carry")} ranked /></div>);
  }

  // Market data widget -> show the data coverage contract, not a generic basket table.
  if (w.kind === "data") {
    const dataLegs = arr(d.legs);
    if (dataLegs.length) sections.push(
      <div key="md"><div className="nx-md-h">Loaded market data</div>
        <table className="nx-md-table"><thead><tr><th>Symbol</th><th>Bars</th><th>Interval</th><th>Category</th><th>Source</th></tr></thead>
          <tbody>{dataLegs.map((l, i) => <tr key={i}>
            <td><AssetIcon symbol={String(l.symbol)} kind={legAssetKind(l)} /></td>
            <td>{num(l.bars) ?? "—"}</td>
            <td>{String(l.interval ?? d.interval ?? "—")}m</td>
            <td>{String(l.category ?? "—")}</td>
            <td>{String(l.source ?? l.venue ?? "Lab/Bybit")}</td>
          </tr>)}</tbody>
        </table>
      </div>,
    );
  }

  // Consolidated hold / leverage / LP reasoning -> compact outside, full visual comparison inside.
  if (w.kind === "hold_vs_trade_vs_lp") {
    const assets = arr(d.assets);
    const rows = (assets.length
      ? assets
      : [{ symbol: d.symbol, recommended: d.recommended, experiments: d.experiments, detail: "", rationale: d.rationale, rejected: d.rejected }]) as Array<Record<string, unknown>>;
    const MODE_COL: Record<string, string> = { hold: "#46e0ff", leverage: "#ff5a1f", lp: "#ffce3a" };
    const MODE_LBL: Record<string, string> = { hold: "Hold", leverage: "Leverage", lp: "LP" };
    sections.push(
      <div key="hvl"><div className="nx-md-h">Per-asset expression decision</div>
        <div className="nx-hvl">
          {rows.map((a, ai) => {
            const exps = arr(a.experiments);
            const rec = String(a.recommended ?? "");
            const maxAbs = Math.max(0.0001, ...exps.map((e) => Math.abs(metricFromExperiment(e, "total_return") ?? 0)));
            return (
              <div className="nx-hvl-asset" key={ai}>
                <div className="nx-hvl-head">
                  <AssetIcon symbol={String(a.symbol ?? "")} kind={legAssetKind({ symbol: String(a.symbol ?? ""), sleeve: rec === "lp" ? "lp" : undefined, venue: String(a.venue ?? "") })} />
                  <span className="nx-hvl-pick" style={{ background: MODE_COL[rec] ?? "#ff5a1f" }}>{MODE_LBL[rec] ?? rec}</span>
                  {a.detail ? <span className="nx-hvl-detail">{String(a.detail)}</span> : null}
                </div>
                <div className="nx-hvl-bars">
                  {exps.map((e, i) => {
                    const v = metricFromExperiment(e, "total_return") ?? 0;
                    const mode = String(e.mode);
                    const win = mode === rec;
                    return (
                      <div className={`nx-hvl-bar${win ? " win" : ""}`} key={i}>
                        <span className="nx-hvl-bar-lbl">{MODE_LBL[mode] ?? mode}{win ? " ★" : ""}</span>
                        <div className="nx-hvl-bar-track">
                          <div className="nx-hvl-bar-fill" style={{ width: `${Math.round((Math.abs(v) / maxAbs) * 100)}%`, background: v < 0 ? "#ff5a1f" : (MODE_COL[mode] ?? "#46e0ff"), opacity: win ? 1 : 0.45 }} />
                        </div>
                        <span className="nx-hvl-bar-val">{pct(v)}</span>
                      </div>
                    );
                  })}
                </div>
                <table className="nx-md-table nx-hvl-tbl"><thead><tr><th>Mode</th><th>Return</th><th>Sharpe</th><th>Max DD</th><th>Note</th></tr></thead>
                  <tbody>{exps.map((e, i) => {
                    const mode = String(e.mode);
                    return <tr key={i} style={{ fontWeight: mode === rec ? 700 : 400 }}><td>{MODE_LBL[mode] ?? mode}{mode === rec ? " ★" : ""}</td><td>{pct(metricFromExperiment(e, "total_return"))}</td><td>{fix(metricFromExperiment(e, "sharpe"))}</td><td>{pct(metricFromExperiment(e, "max_drawdown"))}</td><td>{String(e.note ?? "")}</td></tr>;
                  })}</tbody>
                </table>
                {a.rationale ? <div className="nx-md-news" style={{ marginTop: 6 }}>{String(a.rationale)}</div> : null}
              </div>
            );
          })}
        </div>
      </div>,
    );
  }

  // Regime report → bull/bear aggregates + every detected season (basket vs the market clock) + per-token.
  const seasons = arr(d.seasons);
  if (w.kind === "regime") {
    if (d.market) sections.push(<p className="nx-md-reco" key="rclock">Regime clock: <b>{String(d.market)}</b>{d.span ? ` · ${String(d.span)}` : ""}</p>);
    const perToken = arr(d.per_token);
    if (perToken.length) sections.push(
      <div key="rpt"><div className="nx-md-h">Per-token seasons (each asset&apos;s own cycles)</div>
        <table className="nx-md-table"><thead><tr><th>Token</th><th>Bull seasons</th><th>Bull avg</th><th>Bear seasons</th><th>Bear avg</th><th>Span</th></tr></thead>
          <tbody>{perToken.map((p, i) => <tr key={i}><td><b>{baseSym(p.symbol)}</b></td><td>{num(p.bull_count) ?? 0}</td><td>{pct(p.bull_avg)}</td><td>{num(p.bear_count) ?? 0}</td><td>{pct(p.bear_avg)}</td><td>{String(p.span ?? "—")}</td></tr>)}</tbody></table></div>,
    );
  }
  if (w.kind === "regime" && seasons.length) {
    const bull = obj(d.bull); const bear = obj(d.bear); const ba = obj(bull.aggregate); const ra = obj(bear.aggregate);
    sections.push(
      <div key="ragg"><div className="nx-md-h">Across all bull/bear seasons{d.span ? ` · ${String(d.span)}` : ""}</div>
        <table className="nx-md-table"><thead><tr><th>Regime</th><th>Seasons</th><th>Avg return</th><th>Compounded</th><th>Win-rate</th><th>Worst DD</th></tr></thead>
          <tbody>
            <tr><td><b>Bull</b></td><td>{num(ba.n) ?? 0}</td><td>{pct(ba.avg_return)}</td><td>{pct(ba.compounded_return)}</td><td>{ba.win_rate != null ? `${Math.round((num(ba.win_rate) ?? 0) * 100)}%` : "—"}</td><td>{pct(bull.worst_drawdown)}</td></tr>
            <tr><td><b>Bear</b></td><td>{num(ra.n) ?? 0}</td><td>{pct(ra.avg_return)}</td><td>{pct(ra.compounded_return)}</td><td>{ra.win_rate != null ? `${Math.round((num(ra.win_rate) ?? 0) * 100)}%` : "—"}</td><td>{pct(bear.worst_drawdown)}</td></tr>
          </tbody>
        </table>
      </div>,
    );
    sections.push(
      <div key="rseasons"><div className="nx-md-h">Every season (basket vs BTC market)</div>
        <table className="nx-md-table"><thead><tr><th>Season</th><th>Regime</th><th>Days</th><th>BTC</th><th>Basket</th><th>Sharpe</th><th>Max DD</th><th>Legs</th></tr></thead>
          <tbody>{seasons.map((s, i) => (
            <tr key={i}>
              <td>{String(s.label ?? "")}</td>
              <td><span className={`nx-chip ${s.type === "bull" ? "" : "ghost"}`} style={{ fontSize: 10, padding: "2px 7px" }}>{String(s.type)}</span></td>
              <td>{num(s.days) ?? "—"}</td>
              <td>{pct(s.market_return)}</td>
              <td>{s.error ? "—" : pct(s.basket_return)}</td>
              <td>{s.error ? "—" : fix(s.sharpe)}</td>
              <td>{s.error ? "—" : pct(s.max_drawdown)}</td>
              <td>{s.error ? <span style={{ color: "var(--ink-3)" }}>{String(s.error)}</span> : (num(s.n_legs) ?? "—")}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>,
    );
  }

  // Market Briefing → the full cross-sleeve context the agent received at turn start + source provenance.
  if (w.kind === "market_briefing") {
    const c = obj(d.crypto); const lp = obj(d.lp); const stocks = obj(d.stocks);
    const fg = obj(c.fearGreed); const gmx = obj(lp.gmx);
    const movers = arr(c.movers); const laggards = arr(c.laggards); const pools = arr(lp.topPools);
    const sources = arr(d.sources);
    sections.push(<p className="nx-md-reco" key="mb-as">Live context injected at turn start · as of {String(d.as_of ?? "").slice(0, 19).replace("T", " ")} UTC</p>);
    if (c.regime != null) sections.push(
      <div key="mb-c"><div className="nx-md-h">Crypto</div>
        <div className="nx-md-kv">
          <div><span>Regime</span><b>{String(c.regime)}</b></div>
          <div><span>Breadth</span><b>{num(c.breadthPctUp) ?? "—"}% up ({num(c.advancers) ?? 0}/{(num(c.advancers) ?? 0) + (num(c.decliners) ?? 0)})</b></div>
          <div><span>Vol regime</span><b>{String(c.volRegime ?? "—")}</b></div>
          <div><span>BTC 24h</span><b>{pct((num(c.btc24h) ?? 0) / 100)}</b></div>
          <div><span>ETH 24h</span><b>{pct((num(c.eth24h) ?? 0) / 100)}</b></div>
          {c.btcFunding != null ? <div><span>BTC funding</span><b>{fix((num(c.btcFunding) ?? 0) * 100, 3)}%/8h</b></div> : null}
          {fg.value != null ? <div><span>Fear &amp; Greed</span><b>{num(fg.value)} · {String(fg.classification ?? "")}{fg.previous != null ? ` (${String(fg.trend)} from ${num(fg.previous)})` : ""}</b></div> : null}
        </div>
        <MarketMovesTable movers={movers} laggards={laggards} />
      </div>,
    );
    if (pools.length || gmx.market) sections.push(
      <div key="mb-lp"><div className="nx-md-h">LP / on-chain yield</div>
        {pools.length ? <table className="nx-md-table"><thead><tr><th>Pool</th><th>Fee tier</th><th>Fee APR</th><th>TVL</th><th>IL hint</th></tr></thead>
          <tbody>{pools.map((p, i) => <tr key={i}><td><b>{String(p.pair)}</b></td><td>{num(p.feeTierPct)}%</td><td>{num(p.feeAprPct)}%</td><td>{money(p.tvlUsd)}</td><td>{String(p.ilRiskHint ?? "")}</td></tr>)}</tbody></table> : null}
        <MarketStatTiles gmx={gmx} />
        <MarketGuidance text={lp.note} />
      </div>,
    );
    if (stocks.session) sections.push(<div key="mb-s"><div className="nx-md-h">Stocks</div><StockSessionCard stocks={stocks} /></div>);
    if (sources.length) sections.push(
      <div key="mb-src"><div className="nx-md-h">Sources / freshness</div><SourceFreshness sources={sources} /></div>,
    );
  }

  // LP screener → full ranked cross-venue table by net fee-minus-IL APR + per-pool rationale.
  if (w.kind === "lp_screen") {
    const ranked = arr(d.ranked);
    if (ranked.length) sections.push(
      <div key="lps"><div className="nx-md-h">LP opportunities — ranked by net APR ({String(d.symbol ?? "")})</div>
        <table className="nx-md-table"><thead><tr><th></th><th>Venue / Pool</th><th>Net APR</th><th>Gross fee APR</th><th>Opt. band</th><th>TVL</th><th>IL</th><th>Price</th></tr></thead>
          <tbody>{ranked.map((p, i) => (
            <tr key={i} style={{ fontWeight: i === 0 ? 700 : 400 }}>
              <td>{i === 0 ? "★" : i + 1}</td>
              <td><b>{lpVenueShort(p.venue)}</b> {String(p.pair ?? "")}{p.feeTierPct != null ? ` ${num(p.feeTierPct)}%` : ""}</td>
              <td>{p.netAprPct != null ? `${num(p.netAprPct)}%` : "—"}</td>
              <td>{num(p.grossFeeAprPct) ?? "—"}%</td>
              <td>{p.optimalBandHalfPct != null ? `±${num(p.optimalBandHalfPct)}%` : "—"}</td>
              <td>{money(p.tvlUsd)}</td>
              <td><span className={`nx-chip ${p.ilRisk === "low" ? "" : "ghost"}`} style={{ fontSize: 10, padding: "2px 6px" }}>{String(p.ilRisk ?? "—")}</span></td>
              <td style={{ color: "var(--ink-3)", fontSize: 11 }}>{String(p.priceSource ?? "")}</td>
            </tr>
          ))}</tbody>
        </table>
        <div className="nx-w-rationale" style={{ marginTop: 6, color: "var(--ink-3)", fontSize: 11 }}>Net APR = bounded concentrated fees − annualized IL − costs at each pool&apos;s optimal band (LOCAL_SIM, upper-ish estimate).</div>
      </div>,
    );
    const warns = (Array.isArray(d.warnings) ? d.warnings : []).map(String);
    if (warns.length) sections.push(<div key="lpsw"><div className="nx-md-h">Notes</div><ul className="nx-md-warn">{warns.map((x, i) => <li key={i}>{x}</li>)}</ul></div>);
  }

  // Range optimizer → the net-APR-vs-band-width curve + the full sweep table.
  if (w.kind === "lp_range_opt") {
    const curve = arr(d.curve); const best = obj(d.best);
    if (curve.length) {
      sections.push(<div key="lroc"><div className="nx-md-h">Net APR vs band width</div><EquityChart values={curve.map((p) => num(p.netAprPct) ?? 0)} /></div>);
      sections.push(
        <div key="lrot"><div className="nx-md-h">Band sweep ({String(d.involvement ?? "")})</div>
          <table className="nx-md-table"><thead><tr><th>Band ±</th><th>Net APR</th><th>Fee APR</th><th>IL/yr</th><th>In-range</th><th>Rebalances</th></tr></thead>
            <tbody>{curve.map((p, i) => (
              <tr key={i} style={{ fontWeight: num(p.bandHalfWidthPct) === num(best.bandHalfWidthPct) ? 700 : 400 }}>
                <td>±{num(p.bandHalfWidthPct) ?? "—"}%</td><td>{num(p.netAprPct) ?? "—"}%</td><td>{num(p.feeAprPct) ?? "—"}%</td>
                <td>{num(p.ilAnnualPct) ?? "—"}%</td><td>{num(p.timeInRangePct) ?? "—"}%</td><td>{num(p.rebalances) ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>,
      );
    }
  }

  // Wallet LP positions → full per-position breakdown (fees vs IL vs HODL, range, suggestion).
  if (w.kind === "lp_position") {
    const positions = arr(d.positions); const totals = obj(d.totals);
    if (totals.currentValueUsd != null) sections.push(<p className="nx-md-reco" key="lpp-t">Portfolio: value {money(totals.currentValueUsd)} · <b>net vs HODL {(num(totals.netVsHodlUsd) ?? 0) >= 0 ? "+" : ""}{money(totals.netVsHodlUsd)}</b></p>);
    if (positions.length) sections.push(
      <div key="lpp"><div className="nx-md-h">Positions ({String(d.wallet ?? "").slice(0, 10)}…)</div>
        <table className="nx-md-table"><thead><tr><th>Pair</th><th>Range</th><th>Value</th><th>Fees</th><th>IL</th><th>vs HODL</th></tr></thead>
          <tbody>{positions.map((p, i) => (
            <tr key={i}>
              <td><b>{String(p.pair)}</b> {num(p.feeTierPct)}%</td>
              <td>{p.inRange ? "in range" : "OUT"}</td>
              <td>{money(p.currentValueUsd)}</td>
              <td>{p.collectedFeesUsd != null ? money(p.collectedFeesUsd) : "n/a"}</td>
              <td>{money(p.ilUsd)}</td>
              <td>{(num(p.netVsHodlPct) ?? 0) >= 0 ? "+" : ""}{fix(p.netVsHodlPct, 1)}%</td>
            </tr>
          ))}</tbody>
        </table>
        {positions.map((p, i) => <div className="nx-md-news" key={"s" + i} style={{ marginTop: 4 }}>{String(p.pair)}: {String(p.suggestion ?? "")}</div>)}
      </div>,
    );
    const warns = (Array.isArray(d.warnings) ? d.warnings : []).map(String);
    if (warns.length) sections.push(<div key="lppw"><div className="nx-md-h">Notes</div><ul className="nx-md-warn">{warns.map((x, i) => <li key={i}>{x}</li>)}</ul></div>);
  }

  // Dune panel → the full on-chain table + provenance (source query id, freshness, params).
  if (w.kind === "dune_panel") {
    const status = String(d.status ?? "ok");
    if (status !== "ok") {
      sections.push(<p className="nx-md-reco" key="dune-x">{String(d.reason ?? "Dune query unavailable.")}</p>);
    } else {
      const cols = (Array.isArray(d.columns) ? d.columns : []).map(String);
      const rows = arr(d.rows);
      const sourceLabel = d.source === "gmx_api_fallback" ? "GMX API fallback" : "Dune";
      const prov = [d.query_id != null ? `query ${String(d.query_id)}` : "no Dune query id", d.cached ? "cached result" : d.source === "gmx_api_fallback" ? "live GMX read" : "fresh execution", d.as_of ? `as of ${String(d.as_of).slice(0, 19).replace("T", " ")}` : null, `${num(d.row_count) ?? rows.length} rows`].filter(Boolean).join(" · ");
      sections.push(<p className="nx-md-reco" key="dune-src">On-chain via {sourceLabel} · {prov}</p>);
      if (d.reason) sections.push(<p className="nx-md-reco" key="dune-reason">{String(d.reason)}</p>);
      const params = obj(d.params);
      if (Object.keys(params).length) sections.push(<div key="dune-p"><div className="nx-md-h">Parameters</div><div className="nx-md-kv">{Object.entries(params).map(([k, v]) => <div key={k}><span>{k}</span><b>{String(v)}</b></div>)}</div></div>);
      if (rows.length) sections.push(<div key="dune-t"><div className="nx-md-h">Result</div><div style={{ overflowX: "auto" }}><DuneTable columns={cols} rows={rows} maxCols={10} maxRows={60} /></div></div>);
    }
  }

  // LP pool comparison → the full ranked cross-venue table with the pick flagged + per-row rationale.
  if (w.kind === "lp_compare") {
    const cands = arr(d.candidates);
    if (cands.length) sections.push(
      <div key="lpc"><div className="nx-md-h">Liquidity pools — ranked ({String(d.symbol ?? "")})</div>
        <table className="nx-md-table"><thead><tr><th></th><th>Venue / Pool</th><th>Fee tier</th><th>TVL</th><th>Vol/TVL</th><th>Fee APR</th><th>IL</th><th>Score</th></tr></thead>
          <tbody>{cands.map((c, i) => (
            <tr key={i}>
              <td>{i === 0 ? "★" : i + 1}</td>
              <td><b>{lpVenueShort(c.venue)}</b> {String(c.pair ?? "")}</td>
              <td>{c.feeTierPct != null ? `${num(c.feeTierPct)}%` : "—"}</td>
              <td>{money(c.tvlUsd)}</td>
              <td>{c.volTvl != null ? `${fix(c.volTvl, 2)}x` : "—"}</td>
              <td>{num(c.feeAprPct) ? `${fix(c.feeAprPct, 1)}%` : "—"}</td>
              <td><span className={`nx-chip ${c.ilRisk === "low" ? "" : "ghost"}`} style={{ fontSize: 10, padding: "2px 6px" }}>{String(c.ilRisk ?? "—")}</span></td>
              <td><b>{Math.round((num(c.score) ?? 0) * 100)}</b></td>
            </tr>
          ))}</tbody>
        </table>
        {arr(d.candidates).length && obj(d.pick) ? <div className="nx-md-news" style={{ marginTop: 8 }}><b>Why {lpVenueShort(obj(d.pick).venue)}{obj(d.pick).feeTierPct != null ? ` ${num(obj(d.pick).feeTierPct)}%` : ""}:</b> {String(obj(d.pick).rationale ?? "")}</div> : null}
      </div>,
    );
    const warns = (Array.isArray(d.warnings) ? d.warnings : []).map(String);
    if (warns.length) sections.push(<div key="lpw"><div className="nx-md-h">Notes</div><ul className="nx-md-warn">{warns.map((x, i) => <li key={i}>{x}</li>)}</ul></div>);
  }

  // IL/range → the full IL-vs-price curve as a sparkline-scale chart + band/time-in-range detail.
  if (w.kind === "il_curve") {
    const pts = arr(d.ilCurve);
    if (pts.length) {
      const ils = pts.map((p) => (num(p.il) ?? 0) * 100);
      sections.push(<div key="ilc"><div className="nx-md-h">Impermanent loss vs price move (%)</div><EquityChart values={ils} /><div className="nx-w-rationale" style={{ marginTop: 6 }}>{String(d.breakevenNote ?? "")}</div></div>);
    }
  }

  const curve = (Array.isArray(d.equity_curve) ? (d.equity_curve as unknown[]) : []).map(num).filter((x): x is number => x !== null);
  if (curve.length > 1) sections.push(<div key="eq"><div className="nx-md-h">Equity curve</div><EquityChart values={curve} /></div>);

  const m = obj(d.metrics);
  if (Object.keys(m).length) sections.push(
    <div className="nx-md-metrics" key="m">
      <Metric l="Return" v={pct(m.total_return)} /><Metric l="Sharpe" v={fix(m.sharpe)} />
      <Metric l="Max DD" v={pct(m.max_drawdown)} /><Metric l="Bars" v={num(m.bars) ?? num(d.rebalances) ?? "—"} />
      {d.rebalances != null ? <Metric l="Rebalances" v={String(d.rebalances)} /> : null}
    </div>,
  );

  const scen = arr(d.scenarios);
  if (scen.length) sections.push(
    <div key="s"><div className="nx-md-h">Scenarios</div><table className="nx-md-table"><thead><tr><th>Scenario</th><th>Return</th><th>Sharpe</th><th>Max DD</th><th>Rebal.</th></tr></thead>
      <tbody>{scen.map((s, i) => {
        const sm = obj(s.metrics);
        return <tr key={i}>
          <td>{String(s.name)}</td>
          <td>{s.error ? "—" : pct(s.total_return ?? sm.total_return)}</td>
          <td>{s.error ? "—" : fix(s.sharpe ?? sm.sharpe)}</td>
          <td>{s.error ? "—" : pct(s.max_drawdown ?? sm.max_drawdown)}</td>
          <td>{s.error ? String(s.error) : (num(s.rebalances) ?? "—")}</td>
        </tr>;
      })}</tbody></table></div>,
  );

  const legs = arr(d.legs);
  if (legs.length && w.kind === "data") sections.push(
    <div key="dl"><div className="nx-md-h">Market data coverage</div><table className="nx-md-table"><thead><tr><th>Symbol</th><th>Bars</th><th>Interval</th><th>Category</th><th>Source</th></tr></thead>
      <tbody>{legs.map((l, i) => <tr key={i}>
        <td><AssetIcon symbol={String(l.symbol)} kind={legAssetKind(l)} /></td>
        <td>{num(l.bars) ?? "—"}</td>
        <td>{String(l.interval ?? d.interval ?? "—")}</td>
        <td>{String(l.category ?? "—")}</td>
        <td>{String(l.source ?? d.source ?? "—")}</td>
      </tr>)}</tbody></table></div>,
  );
  if (legs.length && w.kind !== "data" && !isStockSleeve) {
    // Equal-weight is the implicit allocation for a sleeve preview that hasn't committed weights yet.
    const anyWeight = legs.some((l) => num(l.allocation ?? l.weight ?? l.target_weight) != null);
    sections.push(
      <div key="l"><div className="nx-md-h">Basket legs</div><table className="nx-md-table"><thead><tr><th>Symbol</th><th>Allocation</th><th>Sleeve</th><th>Mode</th><th>Venue</th><th>Price</th><th>Lev.</th></tr></thead>
        <tbody>{legs.map((l, i) => {
          const weight = num(l.allocation ?? l.weight ?? l.target_weight) ?? (anyWeight ? null : 1 / legs.length);
          const sleeve = l.sleeve ?? l.asset_class ?? d.sleeve;
          const mode = l.mode ?? l.bot ?? l.recommended ?? l.rec ?? l.category ?? (String(sleeve ?? "").toLowerCase() === "stock" ? "hold" : undefined);
          return <tr key={i}>
            <td><AssetIcon symbol={String(l.symbol)} kind={legAssetKind(l)} /></td>
            <td>{weight != null ? `${(weight * 100).toFixed(1)}%` : "—"}</td>
            <td>{sleeve != null ? String(sleeve) : "—"}</td>
            <td>{mode != null ? String(mode) : "—"}</td>
            <td>{String(l.venue ?? d.venue ?? "—")}</td>
            <td>{fmtPrice(l.price ?? l.price_usd ?? l.priceUsd)}</td>
            <td>{String(l.leverage ?? "1")}×</td>
          </tr>;
        })}</tbody></table></div>,
    );
  }

  const tested = arr(d.tested ?? obj(d.optimization).tested);
  if (tested.length) sections.push(
    <div key="o"><div className="nx-md-h">Optimiser sweep</div><table className="nx-md-table"><thead><tr><th>Threshold</th><th>Sharpe</th><th>Return</th></tr></thead>
      <tbody>{tested.map((t, i) => <tr key={i}><td>{String(t.rebalance_threshold)}{(num(t.rebalance_threshold) === num(d.chosen ?? obj(d.optimization).chosen)) ? " ✓" : ""}</td><td>{fix(t.sharpe)}</td><td>{pct(t.total_return)}</td></tr>)}</tbody></table></div>,
  );

  const results = arr(d.results);
  if (results.length) sections.push(
    <div key="sc"><div className="nx-md-h">Top tokens</div><table className="nx-md-table"><thead><tr><th>Symbol</th><th>24h</th><th>Turnover</th><th>Regime</th></tr></thead>
      <tbody>{results.slice(0, 15).map((r, i) => <tr key={i}><td><AssetIcon symbol={String(r.symbol)} /></td><td>{fix(r.pct24h, 2)}%</td><td>{money(r.turnover24h)}</td><td>{String(r.regime ?? "—")}</td></tr>)}</tbody></table></div>,
  );

  const items = arr(d.items);
  if (items.length) sections.push(
    <div key="n"><div className="nx-md-h">Headlines</div>{items.map((n, i) => <div className="nx-md-news" key={i}>{n.link ? <a href={String(n.link)} target="_blank" rel="noopener noreferrer">{String(n.title)}</a> : String(n.title)}<span className="nx-md-news-src"> — {String(n.source ?? "")}{n.published ? ` · ${String(n.published).slice(0, 16)}` : ""}</span></div>)}</div>,
  );

  const gates = obj(d.risk_gates);
  const hiddenKeys = ["rationale", "action", "weighting", "chosen", "recommendation", ...(isStockSleeve ? ["note", "sleeve", "venue", "chainId", "preference_note"] : [])];
  const gateRows = Object.entries(Object.keys(gates).length ? gates : d).filter(([k, v]) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean") && !hiddenKeys.includes(k));
  if (gateRows.length) sections.push(
    <div key="g"><div className="nx-md-h">{Object.keys(gates).length ? "Risk gates" : "Details"}</div><div className="nx-md-kv">{gateRows.map(([k, v]) => <div key={k}><span>{k}</span><b>{String(v)}</b></div>)}</div></div>,
  );

  const warnings = (Array.isArray(d.warnings) ? d.warnings : []).map(String);
  if (warnings.length) sections.push(<div key="w"><div className="nx-md-h">Warnings</div><ul className="nx-md-warn">{warnings.map((x, i) => <li key={i}>{x}</li>)}</ul></div>);

  const truth = obj(d.truth);
  if (Object.keys(truth).length) {
    sections.push(<div key="truth"><div className="nx-md-h">Truth metadata</div><div className="nx-md-kv">{Object.entries(truth).map(([k, v]) => <div key={k}><span>{k}</span><b>{typeof v === "object" ? JSON.stringify(v) : String(v)}</b></div>)}</div></div>);
  }

  if (!sections.length) sections.push(<p className="nx-w-rationale" key="e">No additional detail.</p>);
  return <>{sections}</>;
}

function Widget({ w, onMove, onOpen, onEditAllocation, onIntakeSubmit }: { w: BoardWidget; onMove: (id: string, x: number, y: number) => void; onOpen: (w: BoardWidget) => void; onEditAllocation?: (id: string, symbol: string, patch: LegPatch) => void; onIntakeSubmit?: (text: string) => void }) {
  const drag = useRef<{ ox: number; oy: number; px: number; py: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const meta = KIND_META[w.kind];

  const onDown = (e: ReactPointerEvent) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { ox: w.x, oy: w.y, px: e.clientX, py: e.clientY, moved: false }; setDragging(true); };
  const onMoveP = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    if (Math.abs(e.clientX - drag.current.px) + Math.abs(e.clientY - drag.current.py) > 3) drag.current.moved = true;
    onMove(w.id, Math.max(8, drag.current.ox + (e.clientX - drag.current.px)), Math.max(8, drag.current.oy + (e.clientY - drag.current.py)));
  };
  const onUp = (e: ReactPointerEvent) => { drag.current = null; setDragging(false); (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); };

  return (
    <div className={widgetClass(w, dragging ? "dragging" : "")} style={{ left: w.x, top: w.y }} data-id={w.id}>
      <div className="nx-w-head" onPointerDown={onDown} onPointerMove={onMoveP} onPointerUp={onUp}>
        <span className="nx-w-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{meta.icon}</svg></span>
        <div style={{ minWidth: 0 }}><div className="nx-w-title">{w.title}</div><div className="nx-w-kind">{meta.label}</div></div>
        <span className={`nx-w-dot ${w.state}`} />
      </div>
      <div className="nx-w-body">{w.kind === "basket" ? <BasketBody w={w} onEdit={onEditAllocation} /> : w.kind === "intake" ? <IntakeBody w={w} onSubmit={onIntakeSubmit} /> : <WidgetBody w={w} />}</div>
      <div className="nx-w-foot" onClick={() => onOpen(w)}>
        <span>{w.state}</span><span>expand ⤢</span>
      </div>
    </div>
  );
}

// ---- Asset icon: symbol + a small asset-class pictogram, not just a plain monogram ----
export type AssetClass = "token" | "stock" | "lp";
function classOf(symbol: string, hint?: AssetClass): AssetClass {
  if (hint) return hint;
  const s = symbol.toUpperCase();
  if (s.startsWith("D") && /^(DTSLA|DAMZN|DNFLX|DPLTR|DAMD|DNVDA)$/.test(s)) return "stock";
  if (/TSLA|AMZN|NFLX|PLTR|AMD|NVDA|AAPL|MSFT|GOOG/.test(s)) return "stock";
  if (s.includes("/") || s.includes("-LP") || /LP$/.test(s)) return "lp";
  return "token";
}
export function AssetIcon({ symbol, kind, sub }: { symbol: string; kind?: AssetClass; sub?: string }) {
  const cls = classOf(symbol, kind);
  const raw = symbol.toUpperCase().replace(/\s+LP$/i, "");
  const lpParts = raw.includes("/") ? raw.split("/").map((p) => p.replace(/[^A-Z0-9]/g, "")).filter(Boolean) : [];
  const base = raw.replace(/USDT?$/i, "");
  const stockUnderlying = cls === "stock" && /^D[A-Z]{2,6}$/.test(base) ? base.slice(1) : undefined;
  return (
    <span className={`nx-asset nx-asset-${cls}`} title={`${base} · ${cls}`}>
      <span className="nx-asset-real" aria-hidden>
        {cls === "lp" && lpParts.length >= 2
          ? <TokenIcon base={lpParts[0]} quote={lpParts[1]} size={20} />
          : <TokenIcon symbol={base} kind={cls === "stock" ? "equity" : "crypto"} underlying={stockUnderlying} size={20} pair={cls !== "stock"} />}
      </span>
      <span className="nx-asset-sym">{base}</span>
      {sub ? <span className="nx-asset-sub">{sub}</span> : null}
    </span>
  );
}

// Infer a basket leg's asset class from its sleeve/venue/asset_class hints (falls back to auto-detect).
function legAssetKind(l: Record<string, unknown>): AssetClass | undefined {
  const sleeve = String(l.sleeve ?? "").toLowerCase();
  const ac = String(l.asset_class ?? "").toLowerCase();
  const venue = String(l.venue ?? "").toLowerCase();
  const mode = String(l.mode ?? "").toLowerCase();
  const cat = String(l.category ?? "").toLowerCase();
  if (sleeve === "lp" || mode === "lp" || cat === "lp" || venue.includes("uniswap") || venue.includes("amm")) return "lp";
  if (sleeve === "stock" || ac.includes("equity") || ac.includes("stock") || venue.includes("robinhood")) return "stock";
  if (sleeve === "crypto" || sleeve === "gmx_trading" || venue === "gmx") return "token";
  return undefined;
}

// ---- Phase boundary system: widgets are grouped into stages that flow horizontally ----
export const PHASE_DEFS = [
  { key: "context", label: "Memory · Findings" },
  { key: "discovery", label: "Discovery · Reasoning" },
  { key: "backtest", label: "Backtest · Validation" },
  { key: "trade", label: "Trade · Execute" },
] as const;
export function phaseOf(kind: WidgetKind): number {
  if (["news", "sentiment_gauge", "market_briefing", "knowledge_lib", "knowledge_cite", "data", "scan", "onchain_context", "regime"].includes(kind)) return 0;
  if (["intake", "objective", "reasoning", "mode_router", "hold_vs_trade_vs_lp", "screen", "factors", "lp_compare", "lp_pool", "il_curve", "funding_carry", "gmx_market", "glv_vault", "dune_panel", "venue_route", "lp_screen", "lp_range_opt"].includes(kind)) return 1;
  if (["backtest", "multiasset", "optimise", "lp_backtest", "refine", "strategy", "bot", "truth", "onchain_truth", "firm_debate", "quote", "bybit_dex", "dex_pool"].includes(kind)) return 2;
  if (["basket", "position", "lp_position", "think"].includes(kind)) return 3;
  return 1;
}

// Static flow card (no free-drag; the board's motion is the horizontal phase flow). Click foot to expand.
function BoardCard({ w, onOpen, onEditAllocation, onIntakeSubmit, offset, onMove, focused }: { w: BoardWidget; onOpen: (w: BoardWidget) => void; onEditAllocation?: (id: string, symbol: string, patch: LegPatch) => void; onIntakeSubmit?: (text: string) => void; offset?: { x: number; y: number }; onMove?: (id: string, x: number, y: number) => void; focused?: boolean }) {
  const meta = KIND_META[w.kind];
  const drag = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    if (!onMove) return;
    drag.current = { px: e.clientX, py: e.clientY, ox: offset?.x ?? 0, oy: offset?.y ?? 0, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current || !onMove) return;
    const dx = e.clientX - drag.current.px, dy = e.clientY - drag.current.py;
    if (!drag.current.moved && Math.abs(dx) + Math.abs(dy) < 3) return; // ignore micro-jitter so clicks still work
    drag.current.moved = true;
    onMove(w.id, drag.current.ox + dx, drag.current.oy + dy);
  };
  const onPointerUp = (e: ReactPointerEvent) => { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); drag.current = null; };
  const style: CSSProperties | undefined = offset ? {
    transform: `translate(${offset.x}px, ${offset.y}px)`,
    marginRight: Math.max(0, offset.x),
    marginBottom: Math.max(0, offset.y),
  } : undefined;
  return (
    <div className={widgetClass(w, `nx-flow${offset ? " nx-moved" : ""}${focused ? " nx-focused" : ""}`)} data-id={w.id} style={style}>
      <div className="nx-w-head nx-drag" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <span className="nx-w-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{meta.icon}</svg></span>
        <div style={{ minWidth: 0 }}><div className="nx-w-title">{w.title}</div><div className="nx-w-kind">{meta.label}</div></div>
        <span className={`nx-w-dot ${w.state}`} />
      </div>
      <div className="nx-w-body">{w.kind === "basket" ? <BasketBody w={w} onEdit={onEditAllocation} /> : w.kind === "intake" ? <IntakeBody w={w} onSubmit={onIntakeSubmit} /> : <WidgetBody w={w} />}</div>
      <div className="nx-w-foot" onClick={() => onOpen(w)}><span>{w.state}</span><span>expand ⤢</span></div>
    </div>
  );
}

// Connector overlay — measures real card positions and draws clean orthogonal links between consecutive
// widgets WITHIN each phase (the analysis sub-flow). Re-measures on layout/resize/drag (via `tick`), so
// the lines are always correct and follow a card when it's dragged. Phase→phase flow uses the arrows.
function ConnectorLayer({ scrollRef, tick }: { scrollRef: { current: HTMLDivElement | null }; tick: number }) {
  const [paths, setPaths] = useState<Array<{ d: string; key: string }>>([]);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const measure = () => {
      const rr = root.getBoundingClientRect();
      const ox = root.scrollLeft, oy = root.scrollTop;
      const segs: Array<{ d: string; key: string }> = [];
      for (const ph of Array.from(root.querySelectorAll<HTMLElement>(".nx-phase"))) {
        const cards = Array.from(ph.querySelectorAll<HTMLElement>("[data-id]"));
        for (let i = 0; i < cards.length - 1; i++) {
          const a = cards[i].getBoundingClientRect(), b = cards[i + 1].getBoundingClientRect();
          const aCx = a.left + a.width / 2 - rr.left + ox, aCy = a.top + a.height / 2 - rr.top + oy;
          const bCx = b.left + b.width / 2 - rr.left + ox, bCy = b.top + b.height / 2 - rr.top + oy;
          let d: string;
          if (Math.abs(bCx - aCx) > Math.abs(bCy - aCy)) { // horizontal hop: a.right → b.left
            const ax = a.right - rr.left + ox, bx = b.left - rr.left + ox, mx = (ax + bx) / 2;
            d = `M${ax},${aCy} C${mx},${aCy} ${mx},${bCy} ${bx},${bCy}`;
          } else { // vertical hop: a.bottom → b.top
            const ay = a.bottom - rr.top + oy, by = b.top - rr.top + oy, my = (ay + by) / 2;
            d = `M${aCx},${ay} C${aCx},${my} ${bCx},${my} ${bCx},${by}`;
          }
          segs.push({ d, key: `${cards[i].dataset.id}->${cards[i + 1].dataset.id}` });
        }
      }
      setSize({ w: root.scrollWidth, h: root.scrollHeight });
      setPaths(segs);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    root.querySelectorAll(".nx-phase").forEach((p) => ro.observe(p));
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [scrollRef, tick]);
  if (!paths.length) return null;
  return (
    <svg className="nx-connectors" width={size.w} height={size.h} aria-hidden>
      <defs><marker id="nx-arrowhead" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--ink-3)" /></marker></defs>
      {paths.map((p) => <path key={p.key} d={p.d} fill="none" stroke="var(--ink-3)" strokeWidth={1.4} strokeDasharray="2 4" markerEnd="url(#nx-arrowhead)" opacity={0.55} />)}
    </svg>
  );
}

export default function NexaBoard({ widgets, focusWidgetId, onEditAllocation, onIntakeSubmit }: { widgets: BoardWidget[]; onMove?: (id: string, x: number, y: number) => void; focusWidgetId?: string | null; onEditAllocation?: (id: string, symbol: string, patch: LegPatch) => void; onIntakeSubmit?: (text: string) => void }) {
  const [open, setOpen] = useState<BoardWidget | null>(null);
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const didInitScroll = useRef(false);
  const panRef = useRef<{ x: number; y: number; left: number; top: number; active: boolean } | null>(null);
  const meta = open ? KIND_META[open.kind] : null;
  const onMove = (id: string, x: number, y: number) => { setOffsets((o) => ({ ...o, [id]: { x, y } })); setTick((t) => t + 1); };
  // Group widgets into phases, preserving arrival order; only render phases that have content.
  const active = PHASE_DEFS
    .map((d, i) => ({ ...d, i, items: widgets.filter((w) => phaseOf(w.kind) === i) }))
    .filter((p) => p.items.length > 0);
  // Re-measure connectors whenever the widget set changes (a phase fills in, etc.).
  const wkey = widgets.map((w) => `${w.id}:${w.state}`).join(",");
  useLayoutEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      const root = scrollRef.current;
      if (root && active.length && !didInitScroll.current) {
        root.scrollTop = 280;
        didInitScroll.current = true;
      }
      setTick((t) => t + 1);
    });
    return () => window.cancelAnimationFrame(raf);
  }, [wkey, active.length]);
  useLayoutEffect(() => {
    if (!focusWidgetId) return;
    const root = scrollRef.current;
    if (!root) return;
    const safe = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(focusWidgetId) : focusWidgetId.replace(/"/g, '\\"');
    const el = root.querySelector<HTMLElement>(`[data-id="${safe}"]`);
    if (!el) return;
    const rr = root.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    root.scrollTo({
      left: root.scrollLeft + er.left - rr.left - rr.width / 2 + er.width / 2,
      top: root.scrollTop + er.top - rr.top - rr.height / 2 + er.height / 2,
      behavior: "smooth",
    });
    setFocusedId(focusWidgetId);
    const t = window.setTimeout(() => setFocusedId((cur) => (cur === focusWidgetId ? null : cur)), 2600);
    return () => window.clearTimeout(t);
  }, [focusWidgetId, wkey]);
  const onBoardPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest(".nx-widget,.nx-modal,.nx-fab,.nx-save,button,input,select,textarea,a")) return;
    const root = scrollRef.current;
    if (!root) return;
    panRef.current = { x: e.clientX, y: e.clientY, left: root.scrollLeft, top: root.scrollTop, active: true };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onBoardPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const root = scrollRef.current;
    const pan = panRef.current;
    if (!root || !pan?.active) return;
    root.scrollLeft = pan.left - (e.clientX - pan.x);
    root.scrollTop = pan.top - (e.clientY - pan.y);
    setTick((t) => t + 1);
  };
  const onBoardPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    panRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onBoardPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    panRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onBoardWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest(".nx-modal,.nx-fab,.nx-save,button,input,select,textarea,a")) return;
    const root = scrollRef.current;
    if (!root) return;
    e.preventDefault();
    root.scrollLeft += e.deltaX + (e.shiftKey ? e.deltaY : 0);
    root.scrollTop += e.deltaY;
    setTick((t) => t + 1);
  };
  return (
    <div
      className="nx-board-scroll nx-flow-scroll"
      ref={scrollRef}
      onScroll={() => setTick((t) => t + 1)}
      onWheel={onBoardWheel}
      onPointerDown={onBoardPointerDown}
      onPointerMove={onBoardPointerMove}
      onPointerUp={onBoardPointerUp}
      onPointerCancel={onBoardPointerCancel}
      onLostPointerCapture={onBoardPointerCancel}
    >
      <ConnectorLayer scrollRef={scrollRef} tick={tick} />
      <div className="nx-phase-row">
        {active.length === 0 ? <div className="nx-flow-empty">Ask the Copilot to build a setup — the stages will appear here as boxes, left to right.</div> : null}
        {active.map((p, idx) => (
          <Fragment key={p.key}>
            <div className={`nx-phase nx-phase-${p.key}`}>
              <div className="nx-phase-head"><span className="nx-phase-idx">{p.i + 1}</span><span className="nx-phase-label">{p.label}</span><span className="nx-phase-count">{p.items.length}</span></div>
              {/* Square-ish grid: ~√n rows, columns fill rightward, so the box grows in both directions. */}
              <div className="nx-phase-widgets" style={{ gridTemplateRows: `repeat(${Math.max(1, Math.min(3, Math.ceil(Math.sqrt(p.items.length))))}, max-content)` }}>
                {p.items.map((w) => <BoardCard key={w.id} w={w} onOpen={setOpen} onEditAllocation={onEditAllocation} onIntakeSubmit={onIntakeSubmit} offset={offsets[w.id]} onMove={onMove} focused={focusedId === w.id} />)}
              </div>
            </div>
            {idx < active.length - 1 ? <div className="nx-phase-arrow" aria-hidden>→</div> : null}
          </Fragment>
        ))}
      </div>
      {open && meta && typeof document !== "undefined" ? createPortal(
        // Portal to <body> so the fixed modal escapes the .nx-board stacking context (z-index:3) that
        // otherwise traps it under the Nexa Analyze / Save floating buttons. The `nexa` wrapper with
        // display:contents carries the theme CSS variables without adding any box/layout.
        <div className="nexa" style={{ display: "contents" }}>
          <div className="nx-modal-back" onClick={() => setOpen(null)}>
            <div className="nx-modal" onClick={(e) => e.stopPropagation()}>
              <div className="nx-modal-head">
                <span className="nx-w-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{meta.icon}</svg></span>
                <div><div className="nx-modal-title">{open.title}</div><div className="nx-w-kind">{meta.label} · {open.state}</div></div>
                <button className="nx-modal-x" onClick={() => setOpen(null)} aria-label="Close">✕</button>
              </div>
              <div className="nx-modal-body"><WidgetDetail w={open} /></div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
