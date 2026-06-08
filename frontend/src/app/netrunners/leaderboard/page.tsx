"use client";

import { useEffect, useState } from "react";
import { SectionTitle, SemiGauge } from "@/components/netrunners/Visuals";
import { fmtNum, netrunnersGet, netrunnersPost } from "@/lib/netrunners/api";

type LeaderboardRow = {
  passport_id?: string;
  run_id?: string;
  strategy_version_id?: string;
  tier?: string;
  rank_score?: number;
};

type LeaderboardResponse = {
  rows?: LeaderboardRow[];
};

type MarketplaceCard = {
  card_id?: string;
  title?: string;
  bot_type?: string;
  result_tier?: string;
  rank_score?: number;
};

type MarketplaceResponse = {
  cards?: MarketplaceCard[];
};

export default function LeaderboardPage() {
  const [tier, setTier] = useState("BACKTEST VERIFIED");
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [marketplace, setMarketplace] = useState<MarketplaceCard[]>([]);
  const [status, setStatus] = useState("");

  async function load() {
    const leaderboard = await netrunnersGet<LeaderboardResponse>(`/api/leaderboard?tier=${encodeURIComponent(tier)}&ranked=true`);
    const market = await netrunnersGet<MarketplaceResponse>(`/api/bots/marketplace?tier=${encodeURIComponent(tier)}`);
    setRows(leaderboard?.rows ?? []);
    setMarketplace((market?.cards ?? []).slice(0, 6));
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier]);

  async function forkCard(cardId: string | undefined) {
    if (!cardId) return;
    setStatus(`Forking ${cardId} …`);
    const r = await netrunnersPost<{ error?: string; bot_spec_id?: string }, Record<string, never>>(`/api/bots/marketplace/${cardId}/fork`, {});
    setStatus(!r || r.error ? `Fork failed${r?.error ? ": " + r.error : ""}` : `Forked → ${r.bot_spec_id ?? "new spec"} (edit it in Bot OS)`);
  }

  return (
    <>
      <section className="nt-card navy" style={{ gridColumn: "1 / 13" }}>
        <SectionTitle endpoint="GET /api/leaderboard?tier=" title="Tier Tabs" />
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {["BACKTEST VERIFIED", "LIVE PAPER VERIFIED"].map((item) => (
            <button
              key={item}
              className={`nt-btn ${tier === item ? "orange" : "ghost"}`}
              onClick={() => setTier(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </section>

      <section className="nt-card navy nt-grid-bg" style={{ gridColumn: "1 / 9" }}>
        <SectionTitle endpoint="GET /api/leaderboard" title="Leaderboard" right={<span className="nt-tag" style={{ color: "var(--muted)" }}>{rows.length} ranked</span>} />
        {rows.length === 0 && (
          <div className="nt-box"><div className="mono" style={{ color: "var(--muted)" }}>No verified passports in this tier yet. Run a backtest in Strategy Lab, then publish a passport to appear here — no fabricated rankings.</div></div>
        )}
        <div className="nt-grid-3" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          {rows.map((row, index) => (
            <div key={row.passport_id ?? index} className="nt-box" style={{ minHeight: "200px" }}>
              <div className="nt-eyebrow">{row.strategy_version_id}</div>
              <div className="dsp" style={{ marginTop: "8px", fontSize: "16px", letterSpacing: "0.04em" }}>
                Rank #{index + 1}
              </div>
              <div style={{ marginTop: "8px" }}>
                <SemiGauge value={Math.min(100, Number(row.rank_score ?? 0))} max={100} label={String(row.tier ?? "VERIFIED")} color="var(--teal)" />
              </div>
              <div className="nt-tag" style={{ color: "var(--teal)", marginTop: "8px" }}>passport seal</div>
              <div style={{ marginTop: "8px", height: "28px", borderRadius: "3px", background: "repeating-linear-gradient(90deg,#d0ccbf 0 2px, transparent 2px 4px, #d0ccbf 4px 5px, transparent 5px 9px)" }} />
            </div>
          ))}
        </div>
      </section>

      <section className="nt-card cream" style={{ gridColumn: "9 / 13" }}>
        <SectionTitle endpoint="GET /api/bots/marketplace" title="Marketplace" dark />
        {status && <div className="nt-footer-note" style={{ marginTop: 0 }}>{status}</div>}
        {marketplace.length === 0 && (
          <div className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}><div className="mono" style={{ color: "var(--ink)" }}>No published cards yet.</div></div>
        )}
        <div className="nt-list">
          {marketplace.map((card) => (
            <div key={card.card_id} className="nt-box" style={{ background: "#e3d9c2", borderColor: "#cfc4a8" }}>
              <div className="dsp" style={{ color: "var(--ink)", fontSize: "14px" }}>{card.title}</div>
              <div className="mono" style={{ marginTop: "5px", color: "var(--muted-ink)", fontSize: "10px" }}>{card.bot_type}</div>
              <div style={{ marginTop: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
                <span className="nt-tag" style={{ color: "var(--orange-deep)" }}>{card.result_tier}</span>
                <span className="mono" style={{ marginLeft: "auto", color: "var(--ink)" }}>score {fmtNum(card.rank_score)}</span>
              </div>
              <button className="nt-btn orange" style={{ marginTop: "10px", width: "100%" }} onClick={() => forkCard(card.card_id)}>Fork</button>
            </div>
          ))}
        </div>
      </section>

      <section className="nt-card paper" style={{ gridColumn: "1 / 13" }}>
        <SectionTitle endpoint="publish/fork workflow" title="Publishing Rules" dark />
        <div className="nt-grid-3">
          <div className="nt-box" style={{ background: "#d7d2c6", borderColor: "#c6beaf" }}>
            <div className="nt-eyebrow dk">verified seal</div>
            <p style={{ marginTop: "8px", color: "var(--ink)", fontSize: "13px", lineHeight: 1.5 }}>
              Only cards with VERIFIED tiers are marked as publishable and discoverable in marketplace ranking.
            </p>
          </div>
          <div className="nt-box" style={{ background: "#d7d2c6", borderColor: "#c6beaf" }}>
            <div className="nt-eyebrow dk">no fake verification</div>
            <p style={{ marginTop: "8px", color: "var(--ink)", fontSize: "13px", lineHeight: 1.5 }}>
              Approximate fills or missing L2 data forces demotion to local-only. Tier badge reflects this explicitly.
            </p>
          </div>
          <div className="nt-box" style={{ background: "#d7d2c6", borderColor: "#c6beaf" }}>
            <div className="nt-eyebrow dk">promotion path</div>
            <p style={{ marginTop: "8px", color: "var(--ink)", fontSize: "13px", lineHeight: 1.5 }}>
              Spec → Cockpit validate → Backtest/Live-paper run → Passport publish → Marketplace card.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
