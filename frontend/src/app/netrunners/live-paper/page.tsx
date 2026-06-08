"use client";

import { useEffect, useState } from "react";
import { LiveEventConsole } from "@/components/netrunners/LiveEventConsole";
import { SectionTitle, SparkAreaChart } from "@/components/netrunners/Visuals";
import { SymbolPicker } from "@/components/netrunners/SymbolPicker";
import { Select } from "@/components/netrunners/Select";
import { TokenIcon } from "@/components/netrunners/TokenIcon";
import { fmtNum, fmtPct, netrunnersGet, netrunnersPost, type LivePaperSession } from "@/lib/netrunners/api";

const STRATEGIES = ["trend_ema_cross", "grid", "funding_fade", "twap", "pmm", "avellaneda_stoikov"];

type SessionsResponse = {
  sessions?: LivePaperSession[];
  rows?: LivePaperSession[];
};

export default function LivePaperPage() {
  const [sessions, setSessions] = useState<LivePaperSession[]>([]);
  const [statusText, setStatusText] = useState("Idle");
  const [strategyId, setStrategyId] = useState("trend_ema_cross");
  const [symbol, setSymbol] = useState("BTCUSDT");

  async function loadSessions() {
    const response = await netrunnersGet<SessionsResponse>("/api/live-paper/sessions");
    const rows = response?.sessions ?? response?.rows ?? [];
    setSessions(rows);
  }

  useEffect(() => {
    async function refresh() {
      await loadSessions();
    }
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 8000);
    return () => clearInterval(interval);
  }, []);

  async function startSession() {
    setStatusText("Starting session ...");
    const payload = {
      strategyId,
      symbol,
      category: symbol.endsWith("XUSDT") ? "spot" : "linear",
      startingEquity: "10000",
      params: { seed: 42 },
    };

    const response = await netrunnersPost<Record<string, unknown>, typeof payload>("/api/live-paper/start", payload);
    if (!response) {
      setStatusText("Start failed: endpoint unavailable");
      return;
    }

    if (response.error) {
      setStatusText(`Start failed: ${String(response.error)}`);
      return;
    }

    setStatusText("Session started. Warmup bars requested (~3h) and stream attached.");
    await loadSessions();
  }

  async function stopSession(sessionId: string) {
    setStatusText(`Stopping ${sessionId} ...`);
    const response = await netrunnersPost<Record<string, unknown>, Record<string, never>>(
      `/api/live-paper/stop/${sessionId}`,
      {},
    );

    if (!response || response.error) {
      setStatusText(`Stop failed for ${sessionId}`);
      return;
    }

    setStatusText(`Stopped ${sessionId}`);
    await loadSessions();
  }

  return (
    <>
      <section className="nt-card navy" style={{ gridColumn: "1 / 4" }}>
        <SectionTitle endpoint="POST /api/live-paper/start" title="Start Panel" />
        <div className="nt-field">
          <label>strategy_id</label>
          <Select value={strategyId} onChange={setStrategyId} options={STRATEGIES.map((s) => ({ value: s, label: s }))} />
        </div>
        <div className="nt-field">
          <label>symbol · full Bybit universe</label>
          <SymbolPicker value={symbol} onChange={(sym) => setSymbol(sym)} />
        </div>
        <div className="nt-field">
          <label>starting_equity</label>
          <input className="nt-input" defaultValue="10000" />
        </div>
        <div className="nt-box">
          <div className="nt-eyebrow">Warmup</div>
          <div className="mono" style={{ marginTop: "6px" }}>auto-backfill last ~3h of 1m bars</div>
        </div>
        <button className="nt-btn orange" style={{ width: "100%", marginTop: "14px" }} onClick={startSession}>Start</button>
        <div className="nt-footer-note">{statusText}</div>
      </section>

      <section className="nt-card navy nt-grid-bg" style={{ gridColumn: "4 / 13" }}>
        <SectionTitle endpoint="GET /api/live-paper/sessions + POST /api/live-paper/stop/:id" title="Active Sessions" />
        <div className="nt-grid-2" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          {sessions.length === 0 ? (
            <div className="nt-box" style={{ gridColumn: "1 / 4" }}>
              <div className="mono" style={{ color: "var(--muted)" }}>No active live-paper sessions yet. Start one to stream bars and forward returns.</div>
            </div>
          ) : (
            sessions.map((session) => (
              <div key={session.id} className="nt-box" style={{ background: "#1b214b" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <TokenIcon symbol={session.symbol ?? ""} size={26} />
                    <div>
                      <div className="dsp" style={{ fontSize: "13px", letterSpacing: ".04em" }}>{session.strategy_id}</div>
                      <div className="mono" style={{ fontSize: "10px", color: "var(--muted)" }}>{session.symbol}</div>
                    </div>
                  </div>
                  <span className="nt-tag" style={{ color: session.status === "running" ? "var(--teal)" : "var(--orange)" }}>
                    {String(session.status ?? "running").toUpperCase()}
                  </span>
                </div>
                <div style={{ marginTop: "10px" }}>
                  <SparkAreaChart
                    height={90}
                    points={[
                      { x: 0, y: 78 },
                      { x: 70, y: 74 },
                      { x: 140, y: 64 },
                      { x: 220, y: 68 },
                      { x: 300, y: 44 },
                      { x: 360, y: 30 },
                      { x: 420, y: 24 },
                      { x: 600, y: 18 },
                    ]}
                  />
                </div>
                <div className="nt-grid-2" style={{ marginTop: "8px" }}>
                  <div className="mono" style={{ fontSize: "10px" }}>live_return {fmtPct(session.live_return)}</div>
                  <div className="mono" style={{ fontSize: "10px", textAlign: "right" }}>live_pnl ${fmtNum(session.live_pnl)}</div>
                  <div className="mono" style={{ fontSize: "10px" }}>fills {session.live_fills ?? 0}</div>
                  <div className="mono" style={{ fontSize: "10px", textAlign: "right" }}>bars {session.bars_seen ?? 0}</div>
                </div>
                <div style={{ marginTop: "8px", display: "flex", gap: "8px" }}>
                  <span className="nt-tag" style={{ color: "#8a90c0" }}>warmup context only</span>
                  <button className="nt-btn ghost" style={{ marginLeft: "auto", padding: "6px 10px" }} onClick={() => stopSession(session.id)}>
                    Stop
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <LiveEventConsole />
    </>
  );
}
