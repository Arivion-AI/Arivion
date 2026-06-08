"use client";

import { useMemo, useState } from "react";
import { SectionTitle } from "@/components/netrunners/Visuals";
import { netrunnersGet, netrunnersPost } from "@/lib/netrunners/api";

type Candidate = {
  candidate_rank: number;
  params: Record<string, number | string>;
  vector_metrics: { total_return: number; max_drawdown: number; trade_count: number };
  parity?: { return_drift?: number; drawdown_drift?: number; trade_count_drift?: number; within_threshold?: boolean };
  promoteable?: boolean;
  badge?: string;
};

type AxisRow = { name: string; min: string; max: string; step: string };

const DEFAULT_AXES: AxisRow[] = [
  { name: "ema_fast", min: "10", max: "30", step: "5" },
  { name: "ema_slow", min: "40", max: "80", step: "10" },
  { name: "trail_atr_mult", min: "2", max: "4", step: "1" },
];

function normalize(row: Record<string, unknown>, index: number): Candidate {
  const vector = (row.vector_metrics_json ?? row.vector_metrics ?? row.event_metrics_json ?? {}) as Record<string, unknown>;
  const parity = (row.parity_json ?? row.parity ?? {}) as Record<string, unknown>;
  const within = parity.within_threshold !== false;
  return {
    candidate_rank: Number(row.candidate_rank ?? index + 1),
    params: (row.params_json ?? row.params ?? {}) as Record<string, number | string>,
    vector_metrics: {
      total_return: Number(vector.total_return ?? 0),
      max_drawdown: Number(vector.max_drawdown ?? 0),
      trade_count: Number(vector.trade_count ?? 0),
    },
    parity: parity as Candidate["parity"],
    promoteable: within,
    badge: within ? (index === 0 ? "A" : "A-") : "B",
  };
}

export default function OptimizerPage() {
  const [method, setMethod] = useState("grid");
  const [topN, setTopN] = useState("3");
  const [axes, setAxes] = useState<AxisRow[]>(DEFAULT_AXES);
  const [status, setStatus] = useState("Ready · define a param space and run.");
  const [running, setRunning] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);

  const topCandidate = useMemo(() => candidates[0], [candidates]);

  function updateAxis(i: number, next: Partial<AxisRow>) {
    setAxes((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...next } : a)));
  }

  async function runOptimizer() {
    setRunning(true);
    setCandidates([]);
    setSummary(null);
    const searchSpace: Record<string, { min: number; max: number; step: number }> = {};
    for (const a of axes) {
      if (!a.name.trim()) continue;
      searchSpace[a.name.trim()] = { min: Number(a.min), max: Number(a.max), step: Number(a.step) || 1 };
    }
    setStatus("Generating candidates + scoring on the vector engine …");
    const run = await netrunnersPost<{ runId?: string; summary?: Record<string, unknown>; error?: string }, Record<string, unknown>>(
      "/api/optimizer/runs",
      { strategyVersionId: "sv_trend_ema_cross_live", method, topN: Number(topN) || 3, searchSpace },
    );
    if (!run) { setStatus("Optimizer endpoint unavailable."); setRunning(false); return; }
    if (run.error || !run.runId) { setStatus(`Optimizer failed: ${run.error ?? "no runId"}`); setRunning(false); return; }
    setSummary(run.summary ?? null);
    const detail = await netrunnersGet<{ candidates?: Array<Record<string, unknown>> }>(`/api/optimizer/runs/${run.runId}`);
    const rows = detail?.candidates ?? [];
    setCandidates(rows.map((r, i) => normalize(r, i)));
    setStatus(`Run ${run.runId.slice(0, 8)} · ${rows.length} finalists scored (event/vector parity checked)`);
    setRunning(false);
  }

  const sensitivity = (summary?.parameter_sensitivity ?? {}) as Record<string, unknown>;
  const walkForward = (summary?.walk_forward ?? {}) as Record<string, unknown>;
  const bootstrap = (summary?.block_bootstrap ?? {}) as Record<string, unknown>;

  return (
    <>
      <section className="nt-card navy" style={{ gridColumn: "1 / 5" }}>
        <SectionTitle endpoint="POST /api/optimizer/runs" title="Param Space Builder" />
        <div className="nt-field"><label>method</label>
          <div className="nt-grid-3" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            {["grid", "random", "sobol"].map((id) => (
              <button key={id} className={`nt-btn ${method === id ? "orange" : "ghost"}`} onClick={() => setMethod(id)} style={{ padding: "8px 10px" }}>{id}</button>
            ))}
          </div>
        </div>
        <div className="nt-field"><label>topN</label><input className="nt-input" value={topN} onChange={(e) => setTopN(e.target.value)} /></div>

        {axes.map((axis, i) => (
          <div className="nt-box" style={{ marginTop: "8px" }} key={i}>
            <input className="nt-input" value={axis.name} onChange={(e) => updateAxis(i, { name: e.target.value })} style={{ marginBottom: "6px" }} />
            <div className="nt-grid-3" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" }}>
              <div className="nt-field"><label>min</label><input className="nt-input" value={axis.min} onChange={(e) => updateAxis(i, { min: e.target.value })} /></div>
              <div className="nt-field"><label>max</label><input className="nt-input" value={axis.max} onChange={(e) => updateAxis(i, { max: e.target.value })} /></div>
              <div className="nt-field"><label>step</label><input className="nt-input" value={axis.step} onChange={(e) => updateAxis(i, { step: e.target.value })} /></div>
            </div>
          </div>
        ))}
        <button className="nt-btn ghost" style={{ marginTop: "8px", width: "100%" }} onClick={() => setAxes((p) => [...p, { name: "param", min: "0", max: "1", step: "1" }])}>+ Add Axis</button>
        <button className="nt-btn orange" style={{ marginTop: "10px", width: "100%" }} disabled={running} onClick={runOptimizer}>{running ? "Running …" : "Run Optimizer"}</button>
        <div className="nt-footer-note">{status}</div>
      </section>

      <section className="nt-card navy nt-grid-bg" style={{ gridColumn: "5 / 13" }}>
        <SectionTitle endpoint="GET /api/optimizer/runs/:runId" title="Candidates" />
        <table className="nt-table">
          <thead>
            <tr><th>rank</th><th>params</th><th className="num">return</th><th className="num">maxdd</th><th className="num">trades</th><th>parity</th><th>badge</th><th>promoteable</th></tr>
          </thead>
          <tbody>
            {candidates.length === 0 ? (
              <tr><td colSpan={8} className="mono" style={{ color: "var(--muted)" }}>No candidates yet — run the optimizer.</td></tr>
            ) : candidates.map((c) => {
              const parityWide = c.parity?.within_threshold === false;
              return (
                <tr key={c.candidate_rank}>
                  <td>{c.candidate_rank}</td>
                  <td className="mono">{Object.entries(c.params).map(([k, v]) => `${k}:${v}`).join(" · ")}</td>
                  <td className="num mono" style={{ color: c.vector_metrics.total_return >= 0 ? "var(--teal)" : "var(--red)" }}>{(c.vector_metrics.total_return * 100).toFixed(2)}%</td>
                  <td className="num mono" style={{ color: "var(--red)" }}>-{(c.vector_metrics.max_drawdown * 100).toFixed(2)}%</td>
                  <td className="num mono">{c.vector_metrics.trade_count}</td>
                  <td className="mono" style={{ color: parityWide ? "var(--red)" : "var(--teal)" }}>±{((c.parity?.return_drift ?? 0) * 100).toFixed(2)} / ±{((c.parity?.drawdown_drift ?? 0) * 100).toFixed(2)}</td>
                  <td>{c.badge}</td>
                  <td>{c.promoteable ? "yes" : "no"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="nt-card cream" style={{ gridColumn: "1 / 7" }}>
        <SectionTitle endpoint="summary · robustness" title="Robustness" dark />
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
          <span className="nt-tag" style={{ color: "#7a7a72" }}>walk_forward {String(walkForward.status ?? "—").toUpperCase()}</span>
          <span className="nt-tag" style={{ color: "#7a7a72" }}>block_bootstrap {String(bootstrap.status ?? "—").toUpperCase()}</span>
        </div>
        <div className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}>
          <div className="nt-eyebrow dk">parameter_sensitivity {sensitivity.status ? `· ${String(sensitivity.status)}` : ""}</div>
          <div className="nt-progress" style={{ marginTop: "8px", background: "#b8b29f" }}>
            <i style={{ width: `${Math.min(100, Number(sensitivity.relative_spread ?? sensitivity.score ?? 0.42) * 100)}%`, background: "linear-gradient(90deg,var(--orange),var(--orange-2))" }} />
          </div>
          <div className="mono" style={{ marginTop: "8px", color: "var(--ink)" }}>finalist-score relative spread: {String(sensitivity.relative_spread ?? sensitivity.score ?? "—")}</div>
        </div>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "7 / 13" }}>
        <SectionTitle endpoint="candidate scatter" title="Candidate Scatter" />
        <div className="nt-box ink" style={{ height: "220px", position: "relative" }}>
          <svg viewBox="0 0 600 220" width="100%" height="220" preserveAspectRatio="none">
            <line x1="40" y1="180" x2="560" y2="180" stroke="#3a4180" />
            <line x1="40" y1="20" x2="40" y2="180" stroke="#3a4180" />
            {candidates.map((c, index) => {
              const x = 80 + (candidates.length > 1 ? (index / (candidates.length - 1)) * 460 : 240);
              const y = 170 - c.vector_metrics.total_return * 300;
              const size = Math.min(15, 4 + c.vector_metrics.trade_count / 30);
              return <circle key={c.candidate_rank} cx={x} cy={Math.max(20, Math.min(180, y))} r={size} fill={c.promoteable ? "var(--teal)" : "var(--orange)"} opacity="0.8" />;
            })}
          </svg>
        </div>
        <div className="nt-footer-note">y = total_return · dot size = trade count · color = promoteable</div>
      </section>

      <section className="nt-card paper" style={{ gridColumn: "1 / 13" }}>
        <SectionTitle endpoint="best candidate" title="Top Candidate" dark />
        <div className="nt-grid-4">
          <div className="nt-box" style={{ background: "#d7d2c6", borderColor: "#c6beaf" }}><div className="nt-eyebrow dk">rank</div><div className="mono" style={{ marginTop: "6px", fontSize: "18px" }}>{topCandidate ? `#${topCandidate.candidate_rank}` : "--"}</div></div>
          <div className="nt-box" style={{ background: "#d7d2c6", borderColor: "#c6beaf" }}><div className="nt-eyebrow dk">return</div><div className="mono" style={{ marginTop: "6px", fontSize: "18px", color: "var(--teal)" }}>{topCandidate ? `${(topCandidate.vector_metrics.total_return * 100).toFixed(2)}%` : "--"}</div></div>
          <div className="nt-box" style={{ background: "#d7d2c6", borderColor: "#c6beaf" }}><div className="nt-eyebrow dk">max drawdown</div><div className="mono" style={{ marginTop: "6px", fontSize: "18px", color: "var(--red)" }}>{topCandidate ? `-${(topCandidate.vector_metrics.max_drawdown * 100).toFixed(2)}%` : "--"}</div></div>
          <div className="nt-box" style={{ background: "#d7d2c6", borderColor: "#c6beaf" }}><div className="nt-eyebrow dk">params</div><div className="mono" style={{ marginTop: "6px", fontSize: "12px" }}>{topCandidate ? Object.entries(topCandidate.params).map(([k, v]) => `${k}:${v}`).join(" ") : "--"}</div></div>
        </div>
      </section>
    </>
  );
}
