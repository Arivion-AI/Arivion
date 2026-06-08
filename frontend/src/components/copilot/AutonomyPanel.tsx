"use client";

import { useCallback, useEffect, useState } from "react";
import { copilotGet, copilotPost, copilotPut } from "@/lib/copilot/api";
import { Card, Pill, Toggle, Empty, useToast } from "./ui";

type Rec = Record<string, unknown>;
interface TriggersResp { autonomy_level: string; triggers: Rec[]; recent: Rec[] }
interface KillResp { global: boolean; per_owner: boolean; granular: Record<string, boolean>; autonomy_level: string }

const TRIGGER_TYPES = [
  { key: "volatility_spike", label: "Volatility spike", threshold: 2.0, hint: "× median vol" },
  { key: "regime_flip", label: "Regime flip", threshold: 0, hint: "12-regime change" },
  { key: "funding_extreme", label: "Funding extreme", threshold: 0.0008, hint: "|funding rate|" },
  { key: "volume_spike", label: "Volume spike", threshold: 3.0, hint: "× median vol" },
  { key: "drawdown", label: "Drawdown breach", threshold: 0.15, hint: "session DD frac" },
  { key: "coverage", label: "Coverage / staleness", threshold: 600000, hint: "ms stale" },
] as const;

// Synthetic events to demo a trigger firing without waiting for the market.
const TEST_EVENT: Record<string, Rec> = {
  volatility_spike: { symbol: "BTCUSDT", category: "linear", vol_pct: 6.0, median_vol_pct: 1.0, regime: "trend_up_high_vol", bar_ts: Date.now() },
  regime_flip: { symbol: "ETHUSDT", category: "linear", regime: "trend_down_high_vol", prev_regime: "range_low_vol", bar_ts: Date.now() },
  funding_extreme: { symbol: "BTCUSDT", category: "linear", funding_rate: 0.0015, bar_ts: Date.now() },
  volume_spike: { symbol: "SOLUSDT", category: "linear", volume: 9, median_volume: 1, bar_ts: Date.now() },
  drawdown: { symbol: "BTCUSDT", category: "linear", drawdown: 0.22, bar_ts: Date.now() },
  coverage: { symbol: "BTCUSDT", category: "linear", age_ms: 1200000, bar_ts: Date.now() },
};
const AUTONOMY = [
  { v: "L0", l: "Suggest" }, { v: "L1", l: "Approve" }, { v: "L1_5_shadow", l: "Shadow" },
  { v: "L2", l: "Auto-paper" }, { v: "L3", l: "Auto-budget" },
];

export default function AutonomyPanel() {
  const [trig, setTrig] = useState<TriggersResp | null>(null);
  const [kill, setKill] = useState<KillResp | null>(null);
  const [shadow, setShadow] = useState<Rec[]>([]);
  const [thresholds, setThresholds] = useState<Record<string, string>>({});
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    const [t, k, s] = await Promise.all([
      copilotGet<TriggersResp>("/triggers"),
      copilotGet<KillResp>("/kill-switch"),
      copilotGet<{ triggers: Rec[] }>("/shadow-mode"),
    ]);
    setTrig(t); setKill(k); setShadow(s?.triggers ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const armed = new Map((trig?.triggers ?? []).map((r) => [String(r.trigger_type), r]));

  async function toggleTrigger(type: string, on: boolean, threshold: number) {
    await copilotPut("/triggers", { trigger_type: type, armed: on, threshold });
    showToast(`${type} ${on ? "armed" : "disarmed"}`); void load();
  }
  async function setMode(type: string, mode: "shadow" | "live") {
    await copilotPut("/triggers", { trigger_type: type, default_mode: mode }); showToast(`${type} → ${mode}`); void load();
  }
  async function testFire(type: string) {
    const r = await copilotPost<{ fired: Rec[] }>("/triggers/evaluate", TEST_EVENT[type]);
    const f = r?.fired?.[0];
    showToast(f ? `Fired: ${f.trigger_type} (${f.mode})${f.skipped ? ` skipped:${f.skipped}` : ""}` : "Armed? No fire — check config");
    void load();
  }
  async function setAutonomy(level: string) { await copilotPost("/kill-switch", { autonomy_level: level }); showToast(`Autonomy → ${level}`); void load(); }
  async function toggleKill(key: string, val: boolean) { await copilotPost("/kill-switch", { [key]: val }); void load(); }
  async function promote(id: unknown) { await copilotPost("/shadow-mode", { trigger_event_id: id }); showToast("Promoted shadow → live (executing)"); void load(); }

  return (
    <>
      {toast}
      {/* Autonomy + kill switches */}
      <div className="cp-col-5">
        <Card eye="Governance" title="Autonomy Level" accent="orange">
          <div className="cp-tabs" style={{ flexWrap: "wrap" }}>
            {AUTONOMY.map((a) => (
              <button key={a.v} className={`cp-tab ${kill?.autonomy_level === a.v ? "on" : ""}`} style={{ fontSize: 11 }} onClick={() => void setAutonomy(a.v)}>{a.v}</button>
            ))}
          </div>
          <div className="cp-eye" style={{ marginTop: 8 }}>{AUTONOMY.find((a) => a.v === kill?.autonomy_level)?.l ?? ""} — higher levels auto-execute more within budget caps.</div>
          <div className="cp-eye" style={{ margin: "16px 0 8px" }}>Kill switches</div>
          {kill?.global && <div className="nt-alert danger" style={{ marginBottom: 10 }}>GLOBAL kill switch is ON — all autonomy halted.</div>}
          {([
            ["agent_enabled (master)", "per_owner", kill?.per_owner === false],
            ["disable_triggers", "disable_triggers", kill?.granular?.disable_triggers],
            ["disable_web", "disable_web", kill?.granular?.disable_web],
            ["disable_memory_writes", "disable_memory_writes", kill?.granular?.disable_memory_writes],
            ["disable_live_paper_start", "disable_live_paper_start", kill?.granular?.disable_live_paper_start],
          ] as [string, string, boolean | undefined][]).map(([label, key, on]) => (
            <div key={key} className="cp-row" style={{ justifyContent: "space-between", padding: "7px 0" }}>
              <span className="mono" style={{ fontSize: 12 }}>{label}</span>
              {key === "per_owner"
                ? <Toggle on={!on} onClick={() => void toggleKill("agent_enabled", !!on)} />
                : <Toggle on={!!on} onClick={() => void toggleKill(key, !on)} />}
            </div>
          ))}
        </Card>
      </div>

      {/* Trigger config */}
      <div className="cp-col-7">
        <Card eye="Event-driven autonomy" title="Trigger Panel" accent="teal">
          <div className="cp-list" style={{ maxHeight: 360 }}>
            {TRIGGER_TYPES.map((t) => {
              const cfg = armed.get(t.key);
              const on = Boolean(cfg?.armed);
              const mode = String(cfg?.default_mode ?? "shadow");
              const thr = thresholds[t.key] ?? String(cfg?.threshold ?? t.threshold);
              return (
                <div key={t.key} className="cp-item">
                  <div className="cp-row" style={{ justifyContent: "space-between" }}>
                    <div><span className="t">{t.label}</span> <span className="s" style={{ display: "inline" }}>· {t.hint}</span></div>
                    <Toggle on={on} onClick={() => void toggleTrigger(t.key, !on, Number(thr))} />
                  </div>
                  <div className="cp-row" style={{ marginTop: 8, gap: 8 }}>
                    <input className="cp-input" style={{ flex: 1, padding: "6px 10px", fontSize: 12 }} value={thr}
                      onChange={(e) => setThresholds((s) => ({ ...s, [t.key]: e.target.value }))}
                      onBlur={() => on && void toggleTrigger(t.key, true, Number(thr))} placeholder="threshold" />
                    <button className={`cp-btn ${mode === "live" ? "orange" : "ghost"}`} style={{ padding: "6px 12px", fontSize: 10 }}
                      onClick={() => void setMode(t.key, mode === "live" ? "shadow" : "live")}>{mode}</button>
                    <button className="cp-btn ghost" style={{ padding: "6px 12px", fontSize: 10 }} onClick={() => void testFire(t.key)}>Test fire</button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Shadow review */}
      <div className="cp-col-7">
        <Card eye="Propose-only" title="Shadow Review" accent="violet"
          right={<Pill tone="violet">{shadow.length} pending</Pill>}>
          {shadow.length === 0 ? <Empty>No shadow proposals. Arm a trigger (shadow mode) and Test fire to see one.</Empty> : (
            <div className="cp-list">
              {shadow.map((s, i) => (
                <div key={i} className="cp-item">
                  <div className="cp-row" style={{ justifyContent: "space-between" }}>
                    <span className="t">{String(s.trigger_type)} · {String(s.symbol)}</span>
                    <button className="cp-btn teal" style={{ padding: "5px 12px", fontSize: 10 }} onClick={() => void promote(s.id)}>▶ Run this</button>
                  </div>
                  <div className="s">💭 {String(s.woke_reason)}</div>
                  <div className="s">proposed: <b>{String(s.proposed_playbook)}</b> · confidence {Number(s.confidence ?? 0).toFixed(2)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Recent fires — "why I woke up" */}
      <div className="cp-col-5">
        <Card eye="Audit" title="Recent Fires">
          {(trig?.recent ?? []).length === 0 ? <Empty>No triggers have fired yet.</Empty> : (
            <div className="cp-list" style={{ maxHeight: 360 }}>
              {(trig?.recent ?? []).map((r, i) => (
                <div key={i} className="cp-item">
                  <div className="cp-row" style={{ justifyContent: "space-between" }}>
                    <span className="t">{String(r.trigger_type)}</span>
                    <Pill tone={r.mode === "live" ? "orange" : "muted"}>{String(r.mode)}{r.acted ? " · acted" : ""}</Pill>
                  </div>
                  <div className="s">{String(r.woke_reason)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
