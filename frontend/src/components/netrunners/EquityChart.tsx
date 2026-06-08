"use client";

import { useMemo, useRef, useState } from "react";

export type ChartFill = { ts: string; side: string; qty: string; price: string; fee?: string; is_maker?: boolean };
export type ChartBar = { ts: number };

type Props = {
  equity: number[];
  fills: ChartFill[];
  bars: ChartBar[];
  height?: number;
  startEquity?: number;
};

const W = 600;
const PADX = 6;

function fmt(n: number, d = 2) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: d }).format(n);
}

/** Detailed account-equity chart with buy/sell trade markers and a hover tooltip.
 *  Pure-real data: equity curve + fills from POST /api/paper/runtime/run. Themed to match
 *  the Netrunners UI (CSS vars, mono font). */
export function EquityChart({ equity, fills, bars, height = 230, startEquity }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; px: number; py: number } | null>(null);

  const { min, max, points, baselineY } = useMemo(() => {
    const vals = equity.length ? equity : [0, 0];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = hi - lo || 1;
    const usable = height - PADX * 2;
    const pts = vals.map((v, i) => ({
      x: vals.length > 1 ? (i / (vals.length - 1)) * W : 0,
      y: PADX + (1 - (v - lo) / span) * usable,
    }));
    const base = startEquity ?? vals[0];
    const baseY = PADX + (1 - (base - lo) / span) * usable;
    return { min: lo, max: hi, points: pts, baselineY: baseY };
  }, [equity, height, startEquity]);

  // Map each fill to the nearest bar index so markers sit on the equity line.
  const markers = useMemo(() => {
    if (!bars.length || !points.length) return [] as Array<{ i: number; fill: ChartFill }>;
    const barMs = bars.map((b) => b.ts);
    return fills
      .map((f) => {
        const t = Date.parse(f.ts);
        let lo = 0, hi = barMs.length - 1, idx = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (barMs[mid] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return { i: Math.min(idx, points.length - 1), fill: f };
      })
      .filter((m) => m.i >= 0);
  }, [fills, bars, points]);

  const fillByIndex = useMemo(() => {
    const m = new Map<number, ChartFill[]>();
    for (const mk of markers) {
      const arr = m.get(mk.i) ?? [];
      arr.push(mk.fill);
      m.set(mk.i, arr);
    }
    return m;
  }, [markers]);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const areaPath = points.length ? `${linePath} L ${W},${height} L 0,${height} Z` : "";
  const last = equity[equity.length - 1] ?? 0;
  const first = startEquity ?? equity[0] ?? 0;
  const up = last >= first;
  const stroke = up ? "var(--teal)" : "var(--red)";

  function onMove(e: React.MouseEvent) {
    const wrap = wrapRef.current;
    if (!wrap || points.length < 2) return;
    const rect = wrap.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const i = Math.round(frac * (points.length - 1));
    setHover({ i, px: e.clientX - rect.left, py: e.clientY - rect.top });
  }

  const hoverFills = hover ? fillByIndex.get(hover.i) ?? [] : [];
  const hoverEquity = hover ? equity[hover.i] : undefined;
  const hoverTs = hover && bars[hover.i] ? bars[hover.i].ts : undefined;
  const hoverXpx = hover ? (hover.i / (points.length - 1)) * 100 : 0;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none" style={{ display: "block" }}>
        <defs>
          <linearGradient id="eq-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={stroke} stopOpacity="0.30" />
            <stop offset="1" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* starting-equity baseline */}
        <line x1="0" y1={baselineY} x2={W} y2={baselineY} stroke="var(--navy-line)" strokeWidth="1" strokeDasharray="4 5" />
        {areaPath && <path d={areaPath} fill="url(#eq-grad)" />}
        {linePath && <path d={linePath} fill="none" stroke={stroke} strokeWidth="2" />}
        {/* trade markers */}
        {markers.map((m, idx) => {
          const p = points[m.i];
          if (!p) return null;
          const buy = m.fill.side === "buy";
          const c = buy ? "var(--teal)" : "var(--red)";
          const tri = buy ? `${p.x},${p.y + 7} ${p.x - 4},${p.y + 13} ${p.x + 4},${p.y + 13}` : `${p.x},${p.y - 7} ${p.x - 4},${p.y - 13} ${p.x + 4},${p.y - 13}`;
          return <polygon key={idx} points={tri} fill={c} opacity={0.85} />;
        })}
        {/* crosshair */}
        {hover && points[hover.i] && (
          <>
            <line x1={points[hover.i].x} y1="0" x2={points[hover.i].x} y2={height} stroke="var(--orange)" strokeWidth="1" opacity="0.5" />
            <circle cx={points[hover.i].x} cy={points[hover.i].y} r="3.5" fill="var(--orange)" stroke="#fff" strokeWidth="1" />
          </>
        )}
      </svg>

      {/* hover tooltip */}
      {hover && hoverEquity !== undefined && (
        <div
          className="mono"
          style={{
            position: "absolute",
            left: `clamp(8px, ${hoverXpx}%, calc(100% - 188px))`,
            top: 6,
            width: 180,
            pointerEvents: "none",
            background: "var(--navy-2, #1b214b)",
            border: "1px solid var(--navy-line, #2a3060)",
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: 10,
            color: "var(--white)",
            boxShadow: "0 6px 20px rgba(0,0,0,.35)",
            zIndex: 5,
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: 9, letterSpacing: ".06em" }}>
            {hoverTs ? new Date(hoverTs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : `bar ${hover.i}`}
          </div>
          <div style={{ marginTop: 4, fontSize: 13, fontWeight: 700, color: hoverEquity >= first ? "var(--teal)" : "var(--red)" }}>
            ${fmt(hoverEquity)}
          </div>
          <div style={{ color: "var(--muted)", fontSize: 9 }}>
            {(((hoverEquity - first) / (first || 1)) * 100).toFixed(2)}% vs start
          </div>
          {hoverFills.length > 0 && (
            <div style={{ marginTop: 6, borderTop: "1px solid var(--navy-line,#2a3060)", paddingTop: 5 }}>
              {hoverFills.slice(0, 3).map((f, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", color: f.side === "buy" ? "var(--teal)" : "var(--red)" }}>
                  <span>{f.side === "buy" ? "▲ BUY" : "▼ SELL"}{f.is_maker ? " ·m" : ""}</span>
                  <span style={{ color: "var(--white)" }}>{fmt(Number(f.qty), 4)} @ {fmt(Number(f.price))}</span>
                </div>
              ))}
              {hoverFills.length > 3 && <div style={{ color: "var(--muted)" }}>+{hoverFills.length - 3} more</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
