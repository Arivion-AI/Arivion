"use client";

import { useCallback, useEffect, useState } from "react";
import { copilotGet, copilotPut } from "@/lib/copilot/api";
import { Card, Pill, Empty, useToast } from "./ui";

type Rec = Record<string, unknown>;
interface Catalog { models: Rec[]; providers: { provider: string; label: string; configured: boolean }[] }
interface Prefs { default_provider: string; default_model: string; default_provider_mode: string; fallback_policy: string }

const perM = (micro: unknown) => `$${(Number(micro) / 1_000_000).toFixed(2)}/Mtok`;

export default function ModelsPanel() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [usage, setUsage] = useState<Rec[]>([]);
  const [ledger, setLedger] = useState<Rec[]>([]);
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    const [c, p, u, l] = await Promise.all([
      copilotGet<Catalog>("/model-catalog"), copilotGet<Prefs>("/model-preferences"),
      copilotGet<{ events: Rec[] }>("/usage?limit=20"), copilotGet<{ entries: Rec[] }>("/credits/ledger?limit=20"),
    ]);
    setCat(c); setPrefs(p); setUsage(u?.events ?? []); setLedger(l?.entries ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function setDefault(provider: string, model: string) {
    await copilotPut("/model-preferences", { default_provider: provider, default_model: model });
    showToast(`Default → ${provider}/${model}`); void load();
  }

  return (
    <>
      {toast}
      <div className="cp-col-7">
        <Card eye="Managed models" title="Model Catalog" accent="orange"
          right={<div className="cp-row" style={{ gap: 6 }}>{cat?.providers.map((p) => <Pill key={p.provider} tone={p.configured ? "teal" : "muted"}>{p.provider}{p.configured ? " ✓" : ""}</Pill>)}</div>}>
          {!cat ? <Empty>Loading…</Empty> : (
            <div className="cp-list">
              {cat.models.map((m, i) => {
                const isDefault = prefs?.default_provider === m.provider && prefs?.default_model === m.model;
                const configured = cat.providers.find((p) => p.provider === m.provider)?.configured;
                return (
                  <div key={i} className="cp-item" style={isDefault ? { borderColor: "var(--teal)" } : undefined}>
                    <div className="cp-row" style={{ justifyContent: "space-between" }}>
                      <div>
                        <span className="t">{String(m.model)}</span> <span className="s" style={{ display: "inline" }}>· {String(m.provider)}</span>
                        {isDefault && <Pill tone="teal" glow>★ default</Pill>}
                      </div>
                      {!isDefault && configured && <button className="cp-btn ghost" style={{ padding: "5px 12px", fontSize: 10 }} onClick={() => void setDefault(String(m.provider), String(m.model))}>Set default</button>}
                    </div>
                    <div className="s cp-row" style={{ gap: 12, flexWrap: "wrap" }}>
                      <span>in {perM(m.input_micro_usd_per_mtoken)}</span>
                      <span>cached {perM(m.cached_input_micro_usd_per_mtoken)}</span>
                      <span>out {perM(m.output_micro_usd_per_mtoken)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {prefs && <div className="cp-eye" style={{ marginTop: 12 }}>mode: {prefs.default_provider_mode} · fallback: {prefs.fallback_policy}</div>}
        </Card>
      </div>

      <div className="cp-col-5">
        <Card eye="Per-call metering" title="Usage History" accent="teal">
          {usage.length === 0 ? <Empty>No LLM calls yet.</Empty> : (
            <table className="nt-table">
              <thead><tr><th>model</th><th>purpose</th><th className="num">tok</th><th className="num">µ$</th></tr></thead>
              <tbody>{usage.map((e, i) => (
                <tr key={i}>
                  <td className="mono">{String(e.model)}</td>
                  <td><Pill tone="muted">{String(e.purpose)}</Pill></td>
                  <td className="num">{String(e.input_tokens)}/{String(e.output_tokens)}</td>
                  <td className="num">{String(e.duality_credit_debit_micro_usd)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <div style={{ height: 14 }} />
        <Card eye="Credits" title="Credit Ledger">
          {ledger.length === 0 ? <Empty>No ledger entries.</Empty> : (
            <div className="cp-list" style={{ maxHeight: 200 }}>
              {ledger.map((e, i) => (
                <div key={i} className="cp-item" style={{ animation: "none" }}>
                  <div className="cp-row" style={{ justifyContent: "space-between" }}>
                    <Pill tone={String(e.event_type).includes("grant") ? "teal" : "muted"}>{String(e.event_type)}</Pill>
                    <span className="mono">{(Number(e.amount_micro_usd) / 1e6).toFixed(6)}</span>
                  </div>
                  <div className="s">balance {(Number(e.balance_after_micro_usd) / 1e6).toFixed(4)} · {e.reason ? String(e.reason) : ""}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
