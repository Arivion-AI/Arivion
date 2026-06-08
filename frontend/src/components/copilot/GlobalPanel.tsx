"use client";

import { useCallback, useEffect, useState } from "react";
import { copilotGet, copilotPost } from "@/lib/copilot/api";
import { Card, Pill, Toggle, Empty, useToast } from "./ui";

type Rec = Record<string, unknown>;

export default function GlobalPanel() {
  const [insights, setInsights] = useState<Rec[]>([]);
  const [optIn, setOptIn] = useState(false);
  const [statement, setStatement] = useState("");
  const [admin, setAdmin] = useState<{ totals: Rec; per_owner: Rec[] } | null>(null);
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    const [g, k, a] = await Promise.all([
      copilotGet<{ global_insights: Rec[] }>("/global"),
      copilotGet<{ granular: Record<string, boolean> }>("/kill-switch"),
      copilotGet<{ totals: Rec; per_owner: Rec[] }>("/admin/budget"),
    ]);
    setInsights(g?.global_insights ?? []);
    // contribute_global isn't in kill-switch payload; track locally + reflect after toggle
    setAdmin(a && (a as Rec).totals ? a : null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggleOptIn() {
    const next = !optIn; setOptIn(next);
    await copilotPost("/kill-switch", { contribute_global: next });
    showToast(next ? "Opted in to contribute global insights" : "Opted out");
  }
  async function promote() {
    if (!statement.trim()) return;
    const r = await copilotPost<{ id?: number; error?: string; message?: string }>("/global/promote", { statement: statement.trim() });
    if (r && "id" in r) { showToast(`Promoted to global pool (#${r.id})`); setStatement(""); void load(); }
    else showToast("Rejected — opt in first, or statement isn't de-identified/structural");
  }

  return (
    <>
      {toast}
      <div className="cp-col-7">
        <Card eye="Cross-owner, de-identified" title="Global Insights" accent="teal">
          <div className="nt-alert" style={{ marginBottom: 14, borderColor: "rgb(22 224 176 / 35%)", background: "rgb(22 224 176 / 10%)", color: "#9ff0db" }}>
            Only structural insights are shareable — raw params, PnL, and identifiers are rejected by the de-identification guard. Owner-scoped memory never leaves the tenant.
          </div>
          {insights.length === 0 ? <Empty>No global insights yet.</Empty> : (
            <div className="cp-list">
              {insights.map((g, i) => (
                <div key={i} className="cp-item">
                  <div className="t" style={{ fontWeight: 400 }}>{String(g.statement)}</div>
                  <div className="s cp-row"><Pill tone="teal">global</Pill><span>confidence {Number(g.confidence ?? 0).toFixed(2)}</span></div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="cp-col-5">
        <Card eye="Opt-in" title="Contribute" accent="orange">
          <div className="cp-row" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span className="mono" style={{ fontSize: 12 }}>Contribute de-identified insights</span>
            <Toggle on={optIn} onClick={() => void toggleOptIn()} />
          </div>
          <label className="cp-label" style={{ marginTop: 12 }}>Structural insight</label>
          <textarea className="cp-textarea" rows={3} value={statement} onChange={(e) => setStatement(e.target.value)}
            placeholder="e.g. Grid bots underperform in trend_up_high_vol regimes on linear majors." />
          <button className="cp-btn teal" style={{ marginTop: 12, width: "100%" }} disabled={!optIn} onClick={() => void promote()}>Promote to global</button>
          <div className="cp-eye" style={{ marginTop: 8 }}>Guard rejects: raw params {`{…}`}, $ / PnL figures, owner identifiers.</div>
        </Card>
      </div>

      {admin && (
        <div className="cp-col-12">
          <Card eye="Admin only" title="Platform Budget" accent="orange"
            right={<div className="cp-row" style={{ gap: 10 }}>
              <Pill tone="muted">owners {String(admin.totals.owners)}</Pill>
              <Pill tone="orange">spend ${Number(admin.totals.total_spend_usd).toFixed(4)}</Pill>
              <Pill tone="teal">balance ${Number(admin.totals.total_balance_usd).toFixed(4)}</Pill>
            </div>}>
            <table className="nt-table">
              <thead><tr><th>owner</th><th className="num">balance</th><th className="num">lifetime spend</th><th className="num">spend today</th></tr></thead>
              <tbody>{admin.per_owner.map((o, i) => (
                <tr key={i}><td className="mono">#{String(o.owner_id)}</td>
                  <td className="num">${Number(o.balance_usd).toFixed(4)}</td>
                  <td className="num">${Number(o.lifetime_spend_usd).toFixed(4)}</td>
                  <td className="num">${Number(o.spend_today_usd).toFixed(4)}</td></tr>
              ))}</tbody>
            </table>
          </Card>
        </div>
      )}
    </>
  );
}
