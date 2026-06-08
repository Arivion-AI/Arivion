"use client";

import { useEffect, useMemo, useState } from "react";
import { SectionTitle, SemiGauge } from "@/components/netrunners/Visuals";
import { SymbolPicker } from "@/components/netrunners/SymbolPicker";
import { netrunnersGet, netrunnersPost } from "@/lib/netrunners/api";

const SYMBOL_PARAM_KEYS = new Set(["symbol", "perp_symbol", "spot_symbol", "base_symbol", "quote_symbol"]);

type BotTemplate = {
  template_id?: string;
  bot_type?: string;
  display_name?: string;
  description?: string;
  category?: string;
  risk_class?: string;
  default_params?: Record<string, unknown>;
  eligibility_hint?: string;
};
type TemplateResponse = { templates?: BotTemplate[] };
type Recommendation = { bot_type?: string; regime_label?: string; confidence?: number; reason?: string; params?: Record<string, unknown> };
type Cockpit = { risk_score?: number; risk_class?: string; hard_blocks?: string[]; modules?: Record<string, Record<string, unknown>>; spec_hash?: string };
type CandleResponse = { bars?: unknown[] };

export default function BotOSPage() {
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [selectedType, setSelectedType] = useState<string>("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [name, setName] = useState("BTC range grid");
  const [cockpit, setCockpit] = useState<Cockpit | null>(null);
  const [cockpitStatus, setCockpitStatus] = useState("Validate a spec to compute the risk cockpit.");
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [recoStatus, setRecoStatus] = useState("");

  useEffect(() => {
    netrunnersGet<TemplateResponse>("/api/bots/templates").then((t) => {
      const rows = t?.templates ?? [];
      if (rows.length) {
        setTemplates(rows);
        setSelectedType(rows[0].bot_type ?? "");
        seedParams(rows[0]);
      }
    });
  }, []);

  function seedParams(tpl: BotTemplate | undefined) {
    const dp = tpl?.default_params ?? {};
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(dp)) next[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
    setParams(next);
  }

  const selected = useMemo(() => templates.find((t) => t.bot_type === selectedType), [templates, selectedType]);

  function selectBot(tpl: BotTemplate) {
    setSelectedType(tpl.bot_type ?? "");
    seedParams(tpl);
    setCockpit(null);
    setCockpitStatus("Validate a spec to compute the risk cockpit.");
  }

  function buildSpecParams(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      const num = Number(v);
      out[k] = v !== "" && !Number.isNaN(num) && /^-?\d*\.?\d+$/.test(v) ? num : v;
    }
    return out;
  }

  async function validateCockpit() {
    setCockpitStatus("Computing risk cockpit …");
    const symbol = String(params.symbol ?? params.perp_symbol ?? "BTCUSDT").toUpperCase();
    const payload = {
      spec: { bot_type: selectedType, name, symbols: [symbol], params: buildSpecParams(), risk: {}, accounting: {} },
      coverage: {},
    };
    const r = await netrunnersPost<Cockpit & { error?: string }, typeof payload>("/api/bots/cockpit", payload);
    if (!r) { setCockpitStatus("Cockpit endpoint unreachable."); return; }
    if ((r as { detail?: unknown }).detail) { setCockpitStatus("Spec invalid — check params."); return; }
    setCockpit(r);
    setCockpitStatus(`risk_class ${r.risk_class} · score ${r.risk_score} · ${r.spec_hash?.slice(0, 10)}`);
  }

  async function scanRecommendations() {
    setRecoStatus("Fetching candles + scanning regime …");
    const c = await netrunnersGet<CandleResponse>("/api/candles?symbol=BTCUSDT&category=linear&interval=60&limit=300");
    const bars = c?.bars ?? [];
    if (bars.length < 30) { setRecoStatus("Not enough BTCUSDT candles for a regime scan."); return; }
    const r = await netrunnersPost<{ recommendations?: Recommendation[] }, Record<string, unknown>>(
      "/api/bots/recommendations/scan", { bars, risk_tolerance: "moderate" });
    setRecommendations(r?.recommendations?.slice(0, 4) ?? []);
    setRecoStatus(`${r?.recommendations?.length ?? 0} recommendations for the active regime`);
  }

  const moduleEntries = Object.entries(cockpit?.modules ?? {});

  return (
    <>
      <section className="nt-card navy nt-grid-bg" style={{ gridColumn: "1 / 9" }}>
        <SectionTitle endpoint="GET /api/bots/templates" title="Bot OS · 15 Products" right={<span className="nt-tag" style={{ color: "var(--orange)" }}>PARAMS FULLY CUSTOM</span>} />
        <div className="nt-grid-3" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "8px" }}>
          {templates.map((tpl, index) => (
            <button key={tpl.bot_type} type="button" onClick={() => selectBot(tpl)} className="nt-box"
              style={{ cursor: "pointer", textAlign: "left", borderColor: selectedType === tpl.bot_type ? "var(--orange)" : "var(--navy-line)", background: selectedType === tpl.bot_type ? "linear-gradient(180deg,#2d2150,#241b40)" : "var(--navy-2)", minHeight: "82px" }}>
              <div className="mono" style={{ color: "var(--muted)", fontSize: "9px", textAlign: "right" }}>{String(index + 1).padStart(2, "0")}</div>
              <div className="dsp" style={{ color: "var(--white)", fontSize: "12px", lineHeight: 1.15 }}>{tpl.bot_type}</div>
              <div className="mono" style={{ color: "var(--muted)", fontSize: "8px", marginTop: "3px" }}>{tpl.category}</div>
            </button>
          ))}
        </div>
        {selected && <div className="nt-footer-note">{selected.description} · {selected.eligibility_hint}</div>}
      </section>

      <section className="nt-card navy nt-grid-bg" style={{ gridColumn: "9 / 13" }}>
        <SectionTitle endpoint="POST /api/bots/cockpit" title="Risk Cockpit" />
        <SemiGauge value={cockpit?.risk_score ?? 0} max={100} label={cockpit?.risk_class ?? "—"}
          color={(cockpit?.risk_score ?? 0) > 66 ? "var(--red)" : (cockpit?.risk_score ?? 0) > 33 ? "var(--orange)" : "var(--teal)"} />
        <div className="nt-footer-note">{cockpitStatus}</div>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "1 / 5" }}>
        <SectionTitle endpoint={`params · ${selectedType}`} title="Bot Spec" />
        <div className="nt-field"><label>name</label><input className="nt-input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="nt-grid-2">
          {Object.entries(params).map(([k, v]) => (
            <div className="nt-field" key={k}>
              <label>{k}</label>
              {SYMBOL_PARAM_KEYS.has(k)
                ? <SymbolPicker value={v} onChange={(sym) => setParams((p) => ({ ...p, [k]: sym }))} />
                : <input className="nt-input" value={v} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} />}
            </div>
          ))}
        </div>
        <button className="nt-btn orange" style={{ width: "100%", marginTop: "10px" }} onClick={validateCockpit}>Validate Spec → Cockpit</button>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "5 / 9" }}>
        <SectionTitle endpoint="validator · §E0 guardrails" title="Hard Blocks + Stress" />
        {cockpit ? (
          <>
            {(cockpit.hard_blocks ?? []).length === 0 ? (
              <div className="nt-alert" style={{ borderColor: "rgb(22 224 176 / 35%)", background: "rgb(22 224 176 / 8%)", color: "#9af3da", marginBottom: "8px" }}>● NO HARD BLOCKS ✓</div>
            ) : (cockpit.hard_blocks ?? []).map((b) => (
              <div key={b} className="nt-alert danger" style={{ marginBottom: "8px" }}>● {b}</div>
            ))}
            <div className="nt-eyebrow" style={{ margin: "10px 0 6px" }}>stress modules</div>
            {moduleEntries.map(([name, mod]) => {
              const applicable = mod.applicable !== false;
              const label = String(mod.label ?? (applicable ? "applicable" : "n/a"));
              return (
                <div key={name} style={{ marginBottom: "8px" }}>
                  <div className="mono" style={{ color: "var(--muted)", fontSize: "10px", marginBottom: "4px", display: "flex", justifyContent: "space-between" }}>
                    <span>{name}</span><span style={{ color: applicable ? "var(--teal)" : "var(--muted)" }}>{applicable ? label : "N/A"}</span>
                  </div>
                  <div className="nt-progress"><i style={{ width: applicable ? "100%" : "8%", background: applicable ? "linear-gradient(90deg,var(--orange),var(--orange-2))" : "#3a4180" }} /></div>
                </div>
              );
            })}
          </>
        ) : (
          <div className="nt-box"><div className="mono" style={{ color: "var(--muted)" }}>Validate a spec to see hard blocks + stress modules (ruin, fee/slippage, liquidation heatmap, funding, concentration).</div></div>
        )}
      </section>

      <section className="nt-card cream" style={{ gridColumn: "9 / 13" }}>
        <SectionTitle endpoint="module · liquidation_heatmap" title="Liq / Margin" dark />
        {cockpit?.modules?.liquidation_heatmap?.applicable ? (
          <div className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}>
            <div className="nt-eyebrow dk">leverage {String(cockpit.modules.liquidation_heatmap.leverage ?? "—")}</div>
            <div className="mono" style={{ marginTop: "6px", fontSize: "11px", color: "var(--ink)" }}>
              MMR {String(cockpit.modules.liquidation_heatmap.maintenance_margin_fraction ?? "—")}<br />
              liq dist ≈ {String(cockpit.modules.liquidation_heatmap.approx_liquidation_distance_fraction ?? "—")}
            </div>
          </div>
        ) : (
          <div className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}><div className="mono" style={{ color: "var(--ink)" }}>No leverage / liquidation exposure for this spec (spot / 1×).</div></div>
        )}
        <div className="nt-box" style={{ marginTop: "12px", background: "#e3d9c2", borderColor: "#cfc4a8" }}>
          <div className="nt-eyebrow dk">risk_class</div>
          <div className="mono" style={{ marginTop: "5px", fontSize: "13px", color: "var(--orange-deep)", fontWeight: 700 }}>{cockpit?.risk_class ?? "—"}</div>
        </div>
      </section>

      <section className="nt-card navy" style={{ gridColumn: "1 / 13" }}>
        <SectionTitle endpoint="POST /api/bots/recommendations/scan" title="Recommender" right={<button className="nt-btn orange" onClick={scanRecommendations}>Scan Regime</button>} />
        {recoStatus && <div className="nt-footer-note" style={{ marginTop: 0, marginBottom: "8px" }}>{recoStatus}</div>}
        {recommendations.length === 0 ? (
          <div className="nt-box"><div className="mono" style={{ color: "var(--muted)" }}>Run scan to populate recommendation cards (regime, confidence, suggested bot + params) from real BTCUSDT candles.</div></div>
        ) : (
          <div className="nt-grid-4" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
            {recommendations.map((item, index) => (
              <div key={`${item.bot_type}-${index}`} className="nt-box" style={{ cursor: "pointer" }}
                onClick={() => { const tpl = templates.find((t) => t.bot_type === item.bot_type); if (tpl) { selectBot(tpl); if (item.params) { const np: Record<string, string> = {}; for (const [k, v] of Object.entries(item.params)) np[k] = String(v); setParams((p) => ({ ...p, ...np })); } } }}>
                <div className="nt-eyebrow">{item.regime_label ?? "regime"}</div>
                <div className="dsp" style={{ marginTop: "6px", fontSize: "15px", letterSpacing: "0.04em" }}>{item.bot_type ?? "bot"}</div>
                <div className="mono" style={{ marginTop: "10px", color: "var(--teal)" }}>confidence {((item.confidence ?? 0) * 100).toFixed(1)}%</div>
                <div className="mono" style={{ marginTop: "8px", fontSize: "10px", color: "var(--muted)" }}>{item.reason ?? "Click to load this spec."}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
