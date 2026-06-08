"use client";

import { useCallback, useEffect, useState } from "react";
import { copilotGet, copilotPost } from "@/lib/copilot/api";
import { Card, Meter, Pill, Empty, AnimatedInt, useToast } from "./ui";

type Rec = Record<string, unknown>;
interface BudgetResp {
  caps: { max_runs_per_day: number; max_live_sessions_per_day: number; max_cost_per_day_usd: number; max_cost_per_run_usd: number; max_cost_per_step_usd: number };
  today: { runs_today: number; live_sessions_today: number; llm_usd_today: number };
  remaining: { runs: number; live_sessions: number; usd: number };
  ledger: Rec[];
}

export default function BudgetPanel() {
  const [b, setB] = useState<BudgetResp | null>(null);
  const [approvals, setApprovals] = useState<Rec[]>([]);
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    const [bud, ap] = await Promise.all([copilotGet<BudgetResp>("/budget"), copilotGet<{ approvals: Rec[] }>("/approvals")]);
    setB(bud); setApprovals(ap?.approvals ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function decide(id: unknown, approved: boolean) {
    await copilotPost(`/approvals/${id}`, { approved });
    showToast(approved ? "Approved — run resumed" : "Denied");
    void load();
  }

  const pct = (used: number, cap: number) => (cap > 0 ? (used / cap) * 100 : 0);

  return (
    <>
      {toast}
      {/* Daily caps with meters */}
      <div className="cp-col-8">
        <Card eye="Phase 5 governance" title="Budget Dashboard" accent="teal">
          {!b ? <Empty>Loading…</Empty> : (
            <div className="nt-grid-3" style={{ gap: 12 }}>
              {[
                { l: "Autonomous runs / day", used: b.today.runs_today, cap: b.caps.max_runs_per_day, rem: b.remaining.runs },
                { l: "Live sessions / day", used: b.today.live_sessions_today, cap: b.caps.max_live_sessions_per_day, rem: b.remaining.live_sessions },
                { l: "LLM spend / day (USD)", used: Number(b.today.llm_usd_today.toFixed(4)), cap: b.caps.max_cost_per_day_usd, rem: Number(b.remaining.usd.toFixed(4)) },
              ].map((m) => (
                <div key={m.l} className="cp-item" style={{ animation: "none" }}>
                  <div className="cp-eye">{m.l}</div>
                  <div className="cp-row" style={{ alignItems: "baseline", justifyContent: "space-between", margin: "6px 0 10px" }}>
                    <AnimatedInt value={typeof m.used === "number" ? m.used : 0} className="" />
                    <span className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>/ {m.cap}</span>
                  </div>
                  <Meter pct={pct(Number(m.used), m.cap)} />
                  <div className="cp-eye" style={{ marginTop: 8 }}>{m.rem} remaining</div>
                </div>
              ))}
            </div>
          )}
          {b && (
            <div className="cp-row" style={{ gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <Pill tone="muted">cap/run ${b.caps.max_cost_per_run_usd}</Pill>
              <Pill tone="muted">cap/step ${b.caps.max_cost_per_step_usd}</Pill>
            </div>
          )}
        </Card>

        <div style={{ height: 14 }} />
        <Card eye="Audit" title="Budget Ledger">
          {(b?.ledger ?? []).length === 0 ? <Empty>No autonomous-action events yet.</Empty> : (
            <table className="nt-table">
              <thead><tr><th>kind</th><th>amount</th><th>reason</th><th>run</th></tr></thead>
              <tbody>{(b?.ledger ?? []).map((e, i) => (
                <tr key={i}><td><Pill tone="muted">{String(e.kind)}</Pill></td><td>{String(e.amount)}</td>
                  <td>{String(e.reason ?? "—")}</td><td className="mono">{e.run_id ? String(e.run_id).slice(0, 12) : "—"}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      </div>

      {/* Approvals queue */}
      <div className="cp-col-4">
        <Card eye="Phase 5" title="Approvals" accent="orange" right={<Pill tone={approvals.length ? "orange" : "muted"} glow={approvals.length > 0}>{approvals.length}</Pill>}>
          {approvals.length === 0 ? <Empty>No pending approvals. Gated steps land here.</Empty> : (
            <div className="cp-list">
              {approvals.map((a, i) => (
                <div key={i} className="cp-item">
                  <div className="t">{String(a.tool)}</div>
                  <div className="s">run {String(a.run_id).slice(0, 14)}… · step {String(a.step_id)}</div>
                  <div className="cp-row" style={{ marginTop: 8 }}>
                    <button className="cp-btn teal" style={{ padding: "5px 12px", fontSize: 10 }} onClick={() => void decide(a.id, true)}>Approve</button>
                    <button className="cp-btn red" style={{ padding: "5px 12px", fontSize: 10 }} onClick={() => void decide(a.id, false)}>Deny</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
