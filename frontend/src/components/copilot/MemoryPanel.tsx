"use client";

import { useCallback, useEffect, useState } from "react";
import { copilotGet, copilotPost, copilotDelete } from "@/lib/copilot/api";
import { Card, Pill, Empty, Skeleton, useToast } from "./ui";

type MemType = "episodes" | "semantic" | "policy";
interface MemResp { episodes?: Rec[]; semantic?: Rec[]; policy?: Rec[] }
type Rec = Record<string, unknown>;
interface LearnedResp { promoted_buckets: Rec[]; semantic_facts: Rec[]; total_policy_buckets: number }

export default function MemoryPanel() {
  const [tab, setTab] = useState<MemType>("episodes");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<MemResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<LearnedResp | null>(null);
  const [reflecting, setReflecting] = useState(false);
  const [toast, showToast] = useToast();

  const load = useCallback(async (q?: string) => {
    setLoading(true);
    const params = new URLSearchParams({ type: tab, limit: "50" });
    if (q) params.set("query", q);
    setData(await copilotGet<MemResp>(`/memory?${params.toString()}`));
    setLoading(false);
  }, [tab]);

  const loadReport = useCallback(async () => { setReport(await copilotGet<LearnedResp>("/memory/report/learned")); }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadReport(); }, [loadReport]);

  async function forget(id: unknown, table: MemType) {
    await copilotDelete(`/memory/${id}?table=${table}`, { reason: "via inspector" });
    showToast("Memory forgotten — logged to deletion ledger");
    void load(query || undefined);
  }
  async function runReflection() {
    setReflecting(true);
    const r = await copilotPost<{ promoted: unknown[]; new_semantic: number; buckets_checked: number }>("/reflect", {});
    setReflecting(false);
    showToast(r ? `Reflection: ${r.promoted?.length ?? 0} promoted, ${r.new_semantic ?? 0} new facts` : "Reflection failed");
    void loadReport(); void load(query || undefined);
  }

  const rows = (data?.[tab] ?? []) as Rec[];

  return (
    <>
      {toast}
      {/* Inspector */}
      <div className="cp-col-7">
        <Card eye="Vector memory" title="Memory Inspector" accent="violet"
          right={<div className="cp-tabs" style={{ padding: 4 }}>
            {(["episodes", "semantic", "policy"] as MemType[]).map((t) => (
              <button key={t} className={`cp-tab ${tab === t ? "on" : ""}`} style={{ padding: "6px 12px", fontSize: 11 }} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>}>
          {tab !== "policy" && (
            <div className="cp-row" style={{ marginBottom: 12 }}>
              <input className="cp-input" placeholder={`Semantic search ${tab}…`} value={query}
                onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(query || undefined); }} />
              <button className="cp-btn ghost" onClick={() => void load(query || undefined)}>Search</button>
            </div>
          )}
          {loading ? <Skeleton rows={4} /> : rows.length === 0 ? <Empty>No {tab} yet.</Empty> : (
            <div className="cp-list">
              {rows.map((r, i) => (
                <div key={i} className="cp-item">
                  {tab === "episodes" && <>
                    <div className="cp-row" style={{ justifyContent: "space-between" }}>
                      <span className="t">{String(r.summary ?? "").slice(0, 90)}</span>
                      <button className="cp-btn ghost" style={{ padding: "4px 10px", fontSize: 10 }} onClick={() => void forget(r.id, "episodes")}>Forget</button>
                    </div>
                    <div className="s cp-row" style={{ gap: 8, flexWrap: "wrap" }}>
                      <Pill tone="muted">{String(r.kind)}</Pill>
                      {r.source ? <Pill tone={r.source === "verified" ? "teal" : r.source === "web" ? "violet" : "muted"}>{String(r.source)}</Pill> : null}
                      {r.result_tier ? <Pill tone="orange">{String(r.result_tier)}</Pill> : null}
                      {r.reward != null ? <span>reward {Number(r.reward).toFixed(3)}</span> : null}
                    </div>
                  </>}
                  {tab === "semantic" && <>
                    <div className="cp-row" style={{ justifyContent: "space-between" }}>
                      <span className="t">{String(r.statement)}</span>
                      <button className="cp-btn ghost" style={{ padding: "4px 10px", fontSize: 10 }} onClick={() => void forget(r.id, "semantic")}>Forget</button>
                    </div>
                    <div className="s cp-row" style={{ gap: 8 }}>
                      <Pill tone={r.scope === "global" ? "teal" : "muted"}>{String(r.scope)}</Pill>
                      <span>confidence {Number(r.confidence ?? 0).toFixed(2)}</span>
                    </div>
                  </>}
                  {tab === "policy" && <>
                    <div className="cp-row" style={{ justifyContent: "space-between" }}>
                      <span className="t">{String(r.context_key)}</span>
                      {r.promoted ? <Pill tone="teal" glow>★ promoted</Pill> : <Pill tone="muted">learning</Pill>}
                    </div>
                    <div className="s">{JSON.stringify(r.param_bucket)} · n={String(r.n)} · reward {Number(r.reward_mean ?? 0).toFixed(3)} · verified {String(r.verified_n)}</div>
                  </>}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Learning report */}
      <div className="cp-col-5">
        <Card eye="What I learned" title="Learning Report" accent="teal"
          right={<button className="cp-btn teal" disabled={reflecting} onClick={() => void runReflection()}>{reflecting ? "Reflecting…" : "Run reflection"}</button>}>
          <div className="cp-kv"><span className="k">Policy buckets</span><span className="v mono">{report?.total_policy_buckets ?? "…"}</span></div>
          <div className="cp-eye" style={{ margin: "12px 0 8px" }}>Promoted preferences</div>
          {report?.promoted_buckets?.length ? (
            <div className="cp-list" style={{ maxHeight: 180 }}>
              {report.promoted_buckets.map((b, i) => (
                <div key={i} className="cp-item">
                  <div className="t">{String((b as Rec).context_key)}</div>
                  <div className="s">{JSON.stringify((b as Rec).param_bucket)} · reward {String((b as Rec).reward_mean)} · n={String((b as Rec).n)}</div>
                </div>
              ))}
            </div>
          ) : <Empty>No promoted policies yet — the reflection job promotes buckets that clear all gates.</Empty>}
          <div className="cp-eye" style={{ margin: "14px 0 8px" }}>Semantic facts</div>
          {report?.semantic_facts?.length ? (
            <div className="cp-list" style={{ maxHeight: 200 }}>
              {report.semantic_facts.map((f, i) => (
                <div key={i} className="cp-item">
                  <div className="t" style={{ fontWeight: 400 }}>{String((f as Rec).statement)}</div>
                  <div className="s cp-row"><Pill tone={(f as Rec).scope === "global" ? "teal" : "muted"}>{String((f as Rec).scope)}</Pill><span>conf {Number((f as Rec).confidence ?? 0).toFixed(2)}</span></div>
                </div>
              ))}
            </div>
          ) : <Empty>No distilled facts yet.</Empty>}
        </Card>
      </div>
    </>
  );
}
