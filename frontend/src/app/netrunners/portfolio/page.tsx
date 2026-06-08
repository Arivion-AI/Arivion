"use client";

import { useEffect, useMemo, useState } from "react";
import { SectionTitle, SparkAreaChart } from "@/components/netrunners/Visuals";
import { SymbolPicker } from "@/components/netrunners/SymbolPicker";
import { Select } from "@/components/netrunners/Select";
import { netrunnersGet, netrunnersPost, getCandlesEnsured, seriesToPoints, fmtUsd, fmtPct, type PortfolioResult } from "@/lib/netrunners/api";

type PortfolioLeg = {
  symbol: string;
  asset_class: "crypto" | "equity";
  category: "linear" | "spot";
  target_weight: number;
  leverage: number;
  allow_short: boolean;
};

const INITIAL_LEGS: PortfolioLeg[] = [
  { symbol: "BTCUSDT", asset_class: "crypto", category: "linear", target_weight: 0.5, leverage: 1, allow_short: true },
  { symbol: "ETHUSDT", asset_class: "crypto", category: "linear", target_weight: 0.3, leverage: 1, allow_short: true },
  { symbol: "SOLUSDT", asset_class: "crypto", category: "linear", target_weight: 0.2, leverage: 1, allow_short: false },
];

type CandleResponse = { bars?: Array<{ ts: number; open: string; high: string; low: string; close: string; volume: string }> };
const COLORS = ["var(--teal)", "var(--violet)", "var(--magenta)", "var(--orange)", "#60a5fa", "#f472b6"];

export default function PortfolioPage() {
  const [legs, setLegs] = useState<PortfolioLeg[]>(INITIAL_LEGS);
  const [scheme, setScheme] = useState("risk_parity");
  const [schemes, setSchemes] = useState<string[]>(["fixed", "equal", "inverse_vol", "risk_parity", "momentum"]);
  const [lookback, setLookback] = useState("48");
  const [topN, setTopN] = useState("3");
  const [validationMessage, setValidationMessage] = useState<string>("Not validated yet");
  const [status, setStatus] = useState("Idle");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PortfolioResult | null>(null);

  const totalWeight = useMemo(() => legs.reduce((sum, leg) => sum + leg.target_weight, 0), [legs]);

  useEffect(() => {
    netrunnersGet<{ weighting_schemes?: string[] }>("/api/portfolio/schemes").then((r) => {
      if (r?.weighting_schemes?.length) setSchemes(r.weighting_schemes);
    });
  }, []);

  function updateLeg(index: number, next: Partial<PortfolioLeg>) {
    setLegs((prev) => prev.map((leg, i) => (i === index ? { ...leg, ...next } : leg)));
  }
  function addLeg() {
    setLegs((prev) => [...prev, { symbol: "BTCUSDT", asset_class: "crypto", category: "linear", target_weight: 0.1, leverage: 1, allow_short: false }]);
  }
  function removeLeg(index: number) {
    setLegs((prev) => prev.filter((_, i) => i !== index));
  }

  function legPayload(withBars: Array<{ leg: PortfolioLeg; bars: unknown[] }> | null) {
    return (withBars ?? legs.map((leg) => ({ leg, bars: [] }))).map(({ leg, bars }) => ({
      symbol: leg.symbol, asset_class: leg.asset_class, category: leg.category,
      target_weight: String(leg.target_weight), leverage: String(leg.leverage),
      allow_short: leg.allow_short, bars,
    }));
  }

  async function validatePortfolio() {
    const payload = { legs: legPayload(null), weighting: scheme };
    const result = await netrunnersPost<{ valid?: boolean; errors?: string[]; error?: string }, typeof payload>("/api/portfolio/validate", payload);
    if (!result) return setValidationMessage("Validation endpoint unreachable. Check worker/api runtime.");
    if (result.error) return setValidationMessage(`Validation failed: ${result.error}`);
    setValidationMessage(result.valid ? "✓ Validation passed — portfolio can run." : `✗ ${(result.errors ?? []).join(", ")}`);
  }

  async function runPortfolio() {
    setRunning(true);
    setResult(null);
    setStatus("Fetching candles for each leg (auto-backfilling from Bybit if needed) …");
    const withBars: Array<{ leg: PortfolioLeg; bars: unknown[] }> = [];
    for (const leg of legs) {
      const interval = leg.asset_class === "equity" ? "D" : "60";
      const bars = await getCandlesEnsured(leg.symbol, leg.category, interval, 120);
      withBars.push({ leg, bars });
    }
    const thin = withBars.filter((w) => w.bars.length < 30);
    if (thin.length > 0) {
      setStatus(`No Bybit candle data available for: ${thin.map((t) => t.leg.symbol).join(", ")}.`);
      setRunning(false);
      return;
    }
    const payload = {
      legs: legPayload(withBars), weighting: scheme, total_equity: "100000",
      fee_bps_taker: "5.5", slippage_bps_one_way: "2.0", rebalance_threshold: "0.05",
      lookback_bars: Number(lookback) || 48, top_n: Number(topN) || 3, interval_minutes: 60,
      risk: { max_position_fraction: "1.0", max_total_exposure_fraction: "3.0" },
    };
    setStatus("Running combined multi-asset portfolio …");
    const r = await netrunnersPost<PortfolioResult, typeof payload>("/api/portfolio/run", payload);
    if (!r) { setStatus("Run failed: worker/API unreachable."); setRunning(false); return; }
    if (r.error) { setStatus(`Run failed: ${r.error}${r.errors ? " · " + r.errors.join(", ") : ""}`); setRunning(false); return; }
    setResult(r);
    setStatus(`Completed · ${(r.equity_curve ?? []).length} steps · ${r.rebalances ?? 0} rebalances`);
    setRunning(false);
  }

  const equityPoints = useMemo(() => seriesToPoints(result?.equity_curve ?? [], 170), [result]);
  const metrics = (result as unknown as { metrics?: Record<string, unknown> })?.metrics;
  const riskState = (result as unknown as { risk_state?: Record<string, unknown> })?.risk_state;
  const weightsHistory = result?.weights_history ?? [];
  const finalEquity = result?.final_equity ? Number(result.final_equity) : undefined;

  return (
    <>
      <section className="nt-card navy nt-grid-bg" style={{ gridColumn: "1 / 8" }}>
        <SectionTitle endpoint="POST /api/portfolio/validate + /run" title="Legs Table" />
        <table className="nt-table">
          <thead>
            <tr><th>symbol</th><th>asset_class</th><th>category</th><th className="num">target_weight</th><th className="num">leverage</th><th>short</th><th></th></tr>
          </thead>
          <tbody>
            {legs.map((leg, index) => (
              <tr key={index}>
                <td style={{ minWidth: "170px" }}>
                  <SymbolPicker value={leg.symbol} onChange={(sym, meta) => {
                    const a = meta?.kind === "equity" ? "equity" : "crypto";
                    updateLeg(index, { symbol: sym, asset_class: a, category: (meta?.category as "linear" | "spot") ?? (a === "equity" ? "spot" : "linear"), leverage: a === "equity" ? 1 : leg.leverage, allow_short: a === "equity" ? false : leg.allow_short });
                  }} />
                </td>
                <td>
                  <Select value={leg.asset_class} onChange={(v) => {
                    const a = v as "crypto" | "equity";
                    updateLeg(index, { asset_class: a, category: a === "equity" ? "spot" : leg.category, leverage: a === "equity" ? 1 : leg.leverage, allow_short: a === "equity" ? false : leg.allow_short });
                  }} options={[{ value: "crypto", label: "crypto" }, { value: "equity", label: "equity" }]} />
                </td>
                <td>
                  <Select value={leg.category} onChange={(v) => updateLeg(index, { category: v as "linear" | "spot" })} disabled={leg.asset_class === "equity"} options={[{ value: "linear", label: "linear" }, { value: "spot", label: "spot" }]} />
                </td>
                <td><input className="nt-input" type="number" step="0.01" min="0" max="1" value={leg.target_weight} onChange={(e) => updateLeg(index, { target_weight: Number(e.target.value) })} /></td>
                <td><input className="nt-input" type="number" min="1" step="1" value={leg.leverage} disabled={leg.asset_class === "equity"} onChange={(e) => updateLeg(index, { leverage: Number(e.target.value) })} /></td>
                <td><input type="checkbox" checked={leg.allow_short} disabled={leg.asset_class === "equity"} onChange={(e) => updateLeg(index, { allow_short: e.target.checked })} /></td>
                <td><button className="nt-btn ghost" style={{ padding: "4px 8px" }} onClick={() => removeLeg(index)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: "10px", marginTop: "14px", flexWrap: "wrap", alignItems: "center" }}>
          <button className="nt-btn ghost" onClick={addLeg}>+ Add Leg</button>
          <button className="nt-btn ghost" onClick={validatePortfolio}>Validate</button>
          <button className="nt-btn orange" disabled={running} onClick={runPortfolio}>{running ? "Running …" : "▶ Run Portfolio"}</button>
          <span className="nt-tag" style={{ color: Math.abs(totalWeight - 1) < 0.001 ? "var(--teal)" : "var(--orange)" }}>weight sum {totalWeight.toFixed(2)}</span>
        </div>
        <div className="nt-footer-note">{validationMessage}</div>
      </section>

      <section className="nt-card cream" style={{ gridColumn: "8 / 13" }}>
        <SectionTitle endpoint="GET /api/portfolio/schemes" title="Weighting Scheme" dark />
        <div className="nt-field">
          <label>weighting</label>
          <Select value={scheme} onChange={setScheme} variant="light" options={schemes.map((s) => ({ value: s, label: s }))} />
        </div>
        <div className="nt-field">
          <label>lookback_bars</label>
          <input className="nt-input" value={lookback} onChange={(e) => setLookback(e.target.value)} style={{ background: "#e7dcc6", color: "var(--ink)", borderColor: "#cfc4a8" }} />
        </div>
        <div className="nt-field">
          <label>top_n (momentum)</label>
          <input className="nt-input" value={topN} onChange={(e) => setTopN(e.target.value)} style={{ background: "#e7dcc6", color: "var(--ink)", borderColor: "#cfc4a8" }} />
        </div>
        <div className="nt-alert warn">Equity legs auto-lock to spot / long / 1× (XSTOCK_SPOT_ONLY). Equity uses daily candles; crypto uses 60m.</div>
      </section>

      <section className="nt-card navy nt-grid-bg" style={{ gridColumn: "1 / 8" }}>
        <SectionTitle endpoint="POST /api/portfolio/run" title="Combined Equity Curve" right={<span className="nt-tag" style={{ color: "var(--orange)" }}>{result?.rebalances ?? 0} rebalances</span>} />
        <div className="nt-box ink">
          <SparkAreaChart points={equityPoints} stroke={finalEquity && finalEquity >= 100000 ? "var(--teal)" : "var(--red)"} />
        </div>
        <div className="nt-footer-note">{status} · union timeline · fwd-fill · crypto 24/7 · equity RTH-only</div>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "8 / 13" }}>
        <SectionTitle endpoint="weights_history" title="Weights Over Time" />
        <div className="nt-box ink" style={{ height: "180px", display: "grid", alignItems: "end" }}>
          {weightsHistory.length === 0 ? (
            <div className="mono" style={{ color: "var(--muted)", alignSelf: "center", textAlign: "center" }}>Run to see realized weight allocation over time.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(weightsHistory.length, 24)}, minmax(0, 1fr))`, gap: "3px", height: "150px", alignItems: "end" }}>
              {weightsHistory.slice(-24).map((w, idx) => {
                const weights = (w.weights ?? w) as Record<string, number>;
                const syms = legs.map((l) => l.symbol);
                return (
                  <div key={idx} style={{ display: "grid", gridTemplateRows: syms.map(() => "1fr").join(" "), gap: "1px", height: "100%" }}>
                    {syms.map((s, si) => (
                      <span key={s} title={`${s}: ${weights[s] ?? 0}`} style={{ background: COLORS[si % COLORS.length], opacity: 0.85, minHeight: "2px", flex: Math.max(0.02, Number(weights[s] ?? 0)) }} />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="nt-card paper" style={{ gridColumn: "1 / 13" }}>
        <SectionTitle endpoint="risk_state + risk_notes + metrics" title="Risk State Band" dark />
        {riskState?.killed ? (
          <div className="nt-alert danger">KILLED · {String(riskState.kill_reason)} — hard kill engaged; positions flattened at next open.</div>
        ) : (
          <div className="nt-alert">Risk rails active: daily-loss / drawdown killrails + RUIN_ZERO_EQUITY backstop.</div>
        )}
        <div className="nt-grid-4" style={{ marginTop: "12px" }}>
          <div className="nt-box" style={{ background: "#d7d2c6", borderColor: "#c6beaf" }}><div className="nt-eyebrow dk">final_equity</div><div className="mono" style={{ marginTop: "6px", fontSize: "18px" }}>{finalEquity !== undefined ? fmtUsd(finalEquity) : "--"}</div></div>
          <div className="nt-box" style={{ background: "#d7d2c6", borderColor: "#c6beaf" }}><div className="nt-eyebrow dk">total_return</div><div className="mono" style={{ marginTop: "6px", fontSize: "18px" }}>{fmtPct(metrics?.total_return as number | undefined)}</div></div>
          <div className="nt-box" style={{ background: "#d7d2c6", borderColor: "#c6beaf" }}><div className="nt-eyebrow dk">sharpe</div><div className="mono" style={{ marginTop: "6px", fontSize: "18px" }}>{typeof metrics?.sharpe === "number" ? (metrics.sharpe as number).toFixed(2) : "--"}</div></div>
          <div className="nt-box" style={{ background: "#d7d2c6", borderColor: "#c6beaf" }}><div className="nt-eyebrow dk">rebalances</div><div className="mono" style={{ marginTop: "6px", fontSize: "18px" }}>{result?.rebalances ?? "--"}</div></div>
        </div>
        {(result?.risk_notes ?? []).length > 0 && (
          <div className="nt-footer-note">{(result?.risk_notes ?? []).slice(0, 4).join(" · ")}</div>
        )}
      </section>
    </>
  );
}
