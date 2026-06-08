"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { copilotGet } from "@/lib/copilot/api";
import { netrunnersGet, fmtUsd, fmtPct } from "@/lib/netrunners/api";
import { AssetIcon } from "@/components/copilot/NexaBoard";

// Portfolio aggregates already-authed endpoints client-side: positions (copilot, carries run_id →
// AI/You attribution), LP (dex), and GMX live orders. Attribution: run_id present ⇒ AI, else the user.

type LinkedWallet = { wallet_address: string; chain_id: number; chain_name?: string };
type AgentWallet = {
  address: string; ethBalanceRh: string; ethBalanceArb: string;
  tokens?: { robinhood?: { mockUsdG?: string }; arbitrumSepolia?: { dUSDC?: string; dWETH?: string } };
} | null;

type Position = {
  id: string; run_id: string | null; symbol: string; category?: string; side: "long" | "short";
  entry_price: number; last_mark: number | null; realized_return: number | null;
  state: "open" | "closing" | "closed"; close_reason: string | null;
  opened_at: string; closed_at?: string | null;
};
type LpPos = {
  position_id?: string; token0_symbol?: string; token1_symbol?: string; fee_bps?: number;
  status?: string; inRange?: boolean; currentValueUsd?: number; ilPct?: number; netVsHodlPct?: number;
  chain_id?: number;
};
type GmxOrder = {
  symbol?: string; direction?: string; size_usd?: number; leverage?: number; status?: string;
  strategy_id?: string | null; bot_type?: string | null; chain_id?: number; submitted_at?: string;
};

const ARB_ONE = 42161, ARB_SEPOLIA = 421614;
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function decidedBy(runId: string | null | undefined): "ai" | "user" {
  return runId ? "ai" : "user";
}
function DecidedBadge({ by }: { by: "ai" | "user" }) {
  return <span className={`nx-pf-by ${by}`}>{by === "ai" ? "◆ AI" : "● You"}</span>;
}

// Unrealized (open) or realized (closed) return as a signed fraction.
function positionReturn(p: Position): number | null {
  if (p.state === "closed") return p.realized_return;
  if (p.last_mark == null || !p.entry_price) return null;
  const raw = (p.last_mark - p.entry_price) / p.entry_price;
  return p.side === "short" ? -raw : raw;
}

function Signed({ frac, className = "" }: { frac: number | null; className?: string }) {
  if (frac == null) return <span className={className}>—</span>;
  const up = frac >= 0;
  return <span className={`${className} ${up ? "up" : "down"}`}>{up ? "+" : ""}{(frac * 100).toFixed(2)}%</span>;
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / span) * 28 - 1}`).join(" ");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg className="nx-pf-spark" viewBox="0 0 100 30" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={up ? "var(--cyan)" : "var(--accent)"} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function relTime(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type ActivityItem = { ts: string; kind: string; text: string; by: "ai" | "user"; tone?: "up" | "down" | "" };

export default function PortfolioPanel({ wallets, agentWallet }: { wallets: LinkedWallet[]; agentWallet: AgentWallet }) {
  const [loading, setLoading] = useState(true);
  const [positions, setPositions] = useState<Position[]>([]);
  const [lp, setLp] = useState<LpPos[]>([]);
  const [gmx, setGmx] = useState<GmxOrder[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const lpWallets = [...wallets.map((w) => ({ addr: w.wallet_address, chain: ARB_ONE })), agentWallet ? { addr: agentWallet.address, chain: ARB_SEPOLIA } : null].filter(Boolean) as Array<{ addr: string; chain: number }>;
    const [pos, gmxResp, ...lpResps] = await Promise.all([
      copilotGet<{ positions: Position[] }>("/positions").catch(() => null),
      netrunnersGet<{ orders: GmxOrder[] }>("/api/gmx/live/sessions").catch(() => null),
      ...lpWallets.map((w) => netrunnersGet<{ positions: LpPos[] }>(`/api/dex/lp/positions?wallet=${encodeURIComponent(w.addr)}&chainId=${w.chain}`).catch(() => null)),
    ]);
    setPositions(pos?.positions ?? []);
    setGmx(gmxResp?.orders ?? []);
    setLp(lpResps.flatMap((r) => r?.positions ?? []));
    setLoading(false);
  }, [wallets, agentWallet]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => {
    const closed = positions.filter((p) => p.state === "closed" && p.realized_return != null);
    const open = positions.filter((p) => p.state !== "closed");
    const wins = closed.filter((p) => (p.realized_return ?? 0) > 0).length;
    const t = agentWallet?.tokens;
    const stable = (num(t?.arbitrumSepolia?.dUSDC) ?? 0) + (num(t?.robinhood?.mockUsdG) ?? 0);
    const lpValue = lp.reduce((s, p) => s + (num(p.currentValueUsd) ?? 0), 0);
    const avgClosed = closed.length ? closed.reduce((s, p) => s + (p.realized_return ?? 0), 0) / closed.length : null;
    return {
      value: stable + lpValue,
      openCount: open.length,
      closedCount: closed.length,
      winRate: closed.length ? wins / closed.length : null,
      avgClosed,
      lpCount: lp.length,
      aiCount: positions.filter((p) => decidedBy(p.run_id) === "ai").length,
    };
  }, [positions, lp, agentWallet]);

  const equityCurve = useMemo(() => {
    const closed = positions.filter((p) => p.state === "closed" && p.realized_return != null)
      .sort((a, b) => new Date(a.closed_at ?? a.opened_at).getTime() - new Date(b.closed_at ?? b.opened_at).getTime());
    let eq = 1; const out = [1];
    for (const p of closed) { eq *= 1 + (p.realized_return ?? 0); out.push(eq); }
    return out;
  }, [positions]);

  const activity = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = [];
    for (const p of positions) {
      items.push({ ts: p.opened_at, kind: "open", by: decidedBy(p.run_id), text: `Opened ${p.side} ${p.symbol}` });
      if (p.state === "closed" && p.closed_at) {
        const ret = p.realized_return ?? 0;
        items.push({ ts: p.closed_at, kind: "close", by: decidedBy(p.run_id), tone: ret >= 0 ? "up" : "down", text: `Closed ${p.symbol} · ${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(1)}%${p.close_reason ? ` (${p.close_reason})` : ""}` });
      }
    }
    for (const o of gmx) {
      if (o.submitted_at) items.push({ ts: o.submitted_at, kind: "gmx", by: o.strategy_id || o.bot_type ? "ai" : "user", text: `GMX ${o.direction ?? ""} ${o.symbol ?? ""} ${o.size_usd ? "$" + Math.round(o.size_usd) : ""} ${o.leverage ? o.leverage + "×" : ""}`.trim() });
    }
    return items.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, 24);
  }, [positions, gmx]);

  if (loading) return <div className="nx-pf"><div className="nx-pf-loading">Loading portfolio…</div></div>;

  const empty = !positions.length && !lp.length && !gmx.length;

  return (
    <div className="nx-pf">
      {/* KPI strip */}
      <div className="nx-pf-kpis">
        <div className="nx-pf-kpi"><span>Portfolio value</span><b>{fmtUsd(totals.value)}</b></div>
        <div className="nx-pf-kpi"><span>Win rate</span><b>{totals.winRate == null ? "—" : fmtPct(totals.winRate)}</b></div>
        <div className="nx-pf-kpi"><span>Avg closed P/L</span><b><Signed frac={totals.avgClosed} /></b></div>
        <div className="nx-pf-kpi"><span>Open positions</span><b>{totals.openCount}</b></div>
        <div className="nx-pf-kpi"><span>LP positions</span><b>{totals.lpCount}</b></div>
        <div className="nx-pf-kpi"><span>AI-decided</span><b>{totals.aiCount}<em> / {positions.length}</em></b></div>
        {equityCurve.length > 2 ? <div className="nx-pf-kpi nx-pf-kpi-spark"><span>Equity (closed)</span><Spark values={equityCurve} /></div> : null}
      </div>

      {empty ? (
        <div className="nx-pf-empty-all">
          <h3>No activity yet</h3>
          <p>Once you open a managed position, provide LP, or execute on testnet, your trades — and whether you or Nexa decided them — show up here.</p>
        </div>
      ) : null}

      {/* Positions */}
      <section className="nx-pf-card">
        <div className="nx-md-h">Trades · profit / loss</div>
        {positions.length ? (
          <table className="nx-md-table nx-pf-table">
            <thead><tr><th>Asset</th><th>Side</th><th>Entry</th><th>Mark</th><th>P/L</th><th>State</th><th>Decided by</th></tr></thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.id}>
                  <td><AssetIcon symbol={p.symbol} /></td>
                  <td><span className={`nx-pf-side ${p.side}`}>{p.side}</span></td>
                  <td>{p.entry_price ? `$${p.entry_price.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : "—"}</td>
                  <td>{p.last_mark != null ? `$${p.last_mark.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : "—"}</td>
                  <td><Signed frac={positionReturn(p)} className="nx-pf-pl" /></td>
                  <td><span className={`nx-chip ${p.state === "closed" ? "ghost" : ""}`}>{p.state}{p.close_reason ? ` · ${p.close_reason}` : ""}</span></td>
                  <td><DecidedBadge by={decidedBy(p.run_id)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="nx-pf-empty">No trades yet.</div>}
      </section>

      {/* LP */}
      <section className="nx-pf-card">
        <div className="nx-md-h">Liquidity positions</div>
        {lp.length ? (
          <div className="nx-pf-lp-grid">
            {lp.map((p, i) => {
              const pair = `${p.token0_symbol ?? "?"}/${p.token1_symbol ?? "?"}`;
              return (
                <div className="nx-pf-lp-card" key={p.position_id ?? i}>
                  <div className="nx-pf-lp-top">
                    <b>{pair}</b>
                    {p.fee_bps != null ? <span className="nx-chip ghost">{(p.fee_bps / 100).toFixed(2)}%</span> : null}
                    <span className={`nx-chip ${p.inRange === false ? "ghost" : ""}`}>{p.inRange === false ? "out of range" : p.status ?? "open"}</span>
                  </div>
                  <div className="nx-pf-lp-metrics">
                    <div><span>Value</span><b>{p.currentValueUsd != null ? fmtUsd(p.currentValueUsd) : "—"}</b></div>
                    <div><span>IL</span><b><Signed frac={num(p.ilPct)} /></b></div>
                    <div><span>vs HODL</span><b><Signed frac={num(p.netVsHodlPct)} /></b></div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : <div className="nx-pf-empty">No LP positions found for your linked wallets.</div>}
      </section>

      {/* GMX */}
      <section className="nx-pf-card">
        <div className="nx-md-h">GMX trades</div>
        {gmx.length ? (
          <table className="nx-md-table nx-pf-table">
            <thead><tr><th>Asset</th><th>Direction</th><th>Size</th><th>Lev.</th><th>Status</th><th>Network</th><th>Decided by</th></tr></thead>
            <tbody>
              {gmx.map((o, i) => (
                <tr key={i}>
                  <td><AssetIcon symbol={o.symbol ?? "—"} /></td>
                  <td><span className={`nx-pf-side ${String(o.direction).toLowerCase().includes("short") ? "short" : "long"}`}>{o.direction ?? "—"}</span></td>
                  <td>{o.size_usd != null ? fmtUsd(o.size_usd) : "—"}</td>
                  <td>{o.leverage != null ? `${o.leverage}×` : "—"}</td>
                  <td><span className="nx-chip ghost">{o.status ?? "—"}</span></td>
                  <td><span className="nx-chip ghost">{o.chain_id === ARB_ONE ? "mainnet" : "testnet"}</span></td>
                  <td><DecidedBadge by={o.strategy_id || o.bot_type ? "ai" : "user"} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="nx-pf-empty">No GMX trades yet.</div>}
      </section>

      {/* Activity */}
      <section className="nx-pf-card">
        <div className="nx-md-h">Recent activity</div>
        {activity.length ? (
          <div className="nx-pf-feed">
            {activity.map((a, i) => (
              <div className="nx-pf-feed-row" key={i}>
                <span className={`nx-pf-feed-dot ${a.tone ?? ""}`} />
                <span className="nx-pf-feed-text">{a.text}</span>
                <DecidedBadge by={a.by} />
                <span className="nx-pf-feed-time">{relTime(a.ts)}</span>
              </div>
            ))}
          </div>
        ) : <div className="nx-pf-empty">No recent activity.</div>}
      </section>
    </div>
  );
}
