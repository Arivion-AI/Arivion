"use client";

import { useMemo, useRef, useState } from "react";
import { TokenIcon } from "./TokenIcon";

export type ChartFill = { ts: string; side: string; qty: string; price: string; fee?: string; is_maker?: boolean };

export type EquitySeries = {
  symbol: string;
  strategy: string;
  equity: number[];
  fills: ChartFill[];
  bars: { ts: number }[];
  color: string;
  start: number;
};

const W = 600;
const PAD = 8;
const fmt = (n: number, d = 2) => new Intl.NumberFormat("en-US", { maximumFractionDigits: d }).format(n);

/** Multi-token account-equity chart: one line per coin/xStock the account trades.
 *  Click a legend chip to focus a token (bold + buy/sell trade markers). Hover for a
 *  per-token equity + trade-detail box. All real data from POST /api/paper/runtime/run. */
export function MultiEquityChart({ series, height = 250 }: { series: EquitySeries[]; height?: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(0);
  const [hover, setHover] = useState<{ frac: number; px: number } | null>(null);

  const { lo, hi } = useMemo(() => {
    let mn = Infinity, mx = -Infinity;
    for (const s of series) for (const v of s.equity) { if (v < mn) mn = v; if (v > mx) mx = v; }
    if (!isFinite(mn)) { mn = 0; mx = 1; }
    return { lo: mn, hi: mx };
  }, [series]);
  const span = hi - lo || 1;
  const usable = height - PAD * 2;
  const yOf = (v: number) => PAD + (1 - (v - lo) / span) * usable;

  const lines = useMemo(() => series.map((s) => {
    const n = s.equity.length;
    const pts = s.equity.map((v, i) => ({ x: n > 1 ? (i / (n - 1)) * W : 0, y: yOf(v) }));
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
    return { pts, d };
  }), [series, lo, hi, height]); // eslint-disable-line react-hooks/exhaustive-deps

  const focused = series[focus];
  const focusedLine = lines[focus];

  // Focused-series trade markers mapped to bar index.
  const markers = useMemo(() => {
    if (!focused || !focusedLine) return [] as Array<{ x: number; y: number; buy: boolean }>;
    const barMs = focused.bars.map((b) => b.ts);
    const n = focused.equity.length;
    return focused.fills.map((f) => {
      const t = Date.parse(f.ts);
      let lo2 = 0, hi2 = barMs.length - 1, idx = 0;
      while (lo2 <= hi2) { const mid = (lo2 + hi2) >> 1; if (barMs[mid] <= t) { idx = mid; lo2 = mid + 1; } else hi2 = mid - 1; }
      const i = Math.min(idx, n - 1);
      return { x: focusedLine.pts[i]?.x ?? 0, y: focusedLine.pts[i]?.y ?? 0, buy: f.side === "buy" };
    });
  }, [focused, focusedLine]);

  function onMove(e: React.MouseEvent) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover({ frac, px: e.clientX - rect.left });
  }

  // Hover detail for the focused series.
  const hoverInfo = useMemo(() => {
    if (!hover || !focused) return null;
    const n = focused.equity.length;
    const i = Math.round(hover.frac * (n - 1));
    const eq = focused.equity[i];
    const ts = focused.bars[i]?.ts;
    const barMs = ts ?? 0;
    const trades = focused.fills.filter((f) => {
      const t = Date.parse(f.ts);
      const next = focused.bars[i + 1]?.ts ?? Infinity;
      return ts !== undefined && t >= barMs && t < next;
    });
    const all = series.map((s) => {
      const j = Math.round(hover.frac * (s.equity.length - 1));
      return { symbol: s.symbol, color: s.color, ret: ((s.equity[j] - s.start) / s.start) * 100 };
    });
    return { i, eq, ts, trades, all };
  }, [hover, focused, series]);

  const crossX = hover ? hover.frac * W : 0;

  return (
    <div>
      <div ref={wrapRef} style={{ position: "relative", width: "100%" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none" style={{ display: "block" }}>
          {/* baseline (starting equity, all start equal) */}
          <line x1="0" y1={yOf(focused?.start ?? lo)} x2={W} y2={yOf(focused?.start ?? lo)} stroke="var(--navy-line)" strokeWidth="1" strokeDasharray="4 5" />
          {lines.map((ln, i) => (
            <path key={i} d={ln.d} fill="none" stroke={series[i].color} strokeWidth={i === focus ? 2.4 : 1.1} opacity={i === focus ? 1 : 0.35} />
          ))}
          {markers.map((m, i) => {
            const tri = m.buy ? `${m.x},${m.y + 6} ${m.x - 4},${m.y + 12} ${m.x + 4},${m.y + 12}` : `${m.x},${m.y - 6} ${m.x - 4},${m.y - 12} ${m.x + 4},${m.y - 12}`;
            return <polygon key={i} points={tri} fill={m.buy ? "var(--teal)" : "var(--red)"} opacity={0.9} />;
          })}
          {hover && (
            <>
              <line x1={crossX} y1="0" x2={crossX} y2={height} stroke="var(--orange)" strokeWidth="1" opacity="0.5" />
              {hoverInfo && focusedLine?.pts[hoverInfo.i] && <circle cx={focusedLine.pts[hoverInfo.i].x} cy={focusedLine.pts[hoverInfo.i].y} r="3.5" fill="var(--orange)" stroke="#fff" strokeWidth="1" />}
            </>
          )}
        </svg>

        {hover && hoverInfo && hoverInfo.eq !== undefined && (
          <div className="mono" style={{
            position: "absolute", left: `clamp(8px, ${hover.frac * 100}%, calc(100% - 196px))`, top: 6, width: 188, pointerEvents: "none",
            background: "var(--navy-2, #1b214b)", border: "1px solid var(--navy-line, #2a3060)", borderRadius: 8, padding: "8px 10px",
            fontSize: 10, color: "var(--white)", boxShadow: "0 6px 20px rgba(0,0,0,.35)", zIndex: 5,
          }}>
            <div style={{ color: "var(--muted)", fontSize: 9 }}>
              {focused.symbol} · {focused.strategy}{hoverInfo.ts ? " · " + new Date(hoverInfo.ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
            </div>
            <div style={{ marginTop: 3, fontSize: 13, fontWeight: 700, color: hoverInfo.eq >= focused.start ? "var(--teal)" : "var(--red)" }}>${fmt(hoverInfo.eq)}</div>
            {hoverInfo.trades.length > 0 && (
              <div style={{ marginTop: 5, borderTop: "1px solid var(--navy-line,#2a3060)", paddingTop: 4 }}>
                {hoverInfo.trades.slice(0, 3).map((f, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", color: f.side === "buy" ? "var(--teal)" : "var(--red)" }}>
                    <span>{f.side === "buy" ? "▲ BUY" : "▼ SELL"}{f.is_maker ? "·m" : ""}</span>
                    <span style={{ color: "var(--white)" }}>{fmt(Number(f.qty), 4)}@{fmt(Number(f.price))}</span>
                  </div>
                ))}
                {hoverInfo.trades.length > 3 && <div style={{ color: "var(--muted)" }}>+{hoverInfo.trades.length - 3} more</div>}
              </div>
            )}
            <div style={{ marginTop: 5, borderTop: "1px solid var(--navy-line,#2a3060)", paddingTop: 4, maxHeight: 78, overflow: "hidden" }}>
              {hoverInfo.all.sort((a, b) => b.ret - a.ret).slice(0, 5).map((s) => (
                <div key={s.symbol} style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: s.color }}>● {s.symbol.replace("USDT", "")}</span>
                  <span style={{ color: s.ret >= 0 ? "var(--teal)" : "var(--red)" }}>{s.ret >= 0 ? "+" : ""}{s.ret.toFixed(2)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* legend — one chip per token; click to focus */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" }}>
        {series.map((s, i) => {
          const ret = ((s.equity[s.equity.length - 1] - s.start) / s.start) * 100;
          return (
            <button key={s.symbol} onClick={() => setFocus(i)} className="mono" title={`${s.symbol} · ${s.strategy}`}
              style={{
                display: "flex", alignItems: "center", gap: "6px", padding: "4px 8px", borderRadius: "6px", cursor: "pointer",
                fontSize: "10px", background: i === focus ? "var(--navy-2,#1b214b)" : "transparent",
                border: `1px solid ${i === focus ? "var(--orange,#f97316)" : "var(--navy-line,#2a3060)"}`,
                opacity: i === focus ? 1 : 0.72, color: "var(--white)",
              }}>
              <TokenIcon symbol={s.symbol} size={16} pair={false} />
              <span style={{ fontWeight: 700 }}>{s.symbol.replace("USDT", "")}</span>
              <span style={{ color: ret >= 0 ? "var(--teal)" : "var(--red)" }}>{ret >= 0 ? "+" : ""}{ret.toFixed(1)}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
