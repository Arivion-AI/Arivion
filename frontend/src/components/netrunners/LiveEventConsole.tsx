"use client";

import { useEffect, useMemo, useState } from "react";

const MAX_LINES = 40;

type ConsoleLine = {
  ts: string;
  event: string;
  payload: string;
};

function compactPayload(payload: string): string {
  if (payload.length <= 110) {
    return payload;
  }
  return `${payload.slice(0, 108)}...`;
}

export function LiveEventConsole() {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const streamUrl = "/api/netrunners/api/stream?topics=prices,bars,sessions&symbols=BTCUSDT,ETHUSDT,NVDAXUSDT";
    const source = new EventSource(streamUrl);

    const pushLine = (event: string, data: string) => {
      const next: ConsoleLine = {
        ts: new Date().toISOString(),
        event,
        payload: compactPayload(data),
      };
      setLines((prev) => [next, ...prev].slice(0, MAX_LINES));
    };

    source.onopen = () => {
      setConnected(true);
      pushLine("system", "SSE connected");
    };

    source.onerror = () => {
      setConnected(false);
      pushLine("system", "SSE reconnecting");
    };

    const handleMessage = (eventName: string) => (event: MessageEvent<string>) => {
      pushLine(eventName, event.data);
    };

    source.addEventListener("hello", handleMessage("hello"));
    source.addEventListener("price", handleMessage("price"));
    source.addEventListener("barclose", handleMessage("barclose"));
    source.addEventListener("session", handleMessage("session"));
    source.addEventListener("heartbeat", handleMessage("heartbeat"));

    return () => {
      source.close();
    };
  }, []);

  const ledClassName = useMemo(() => `nt-live-led ${connected ? "" : "degraded"}`, [connected]);

  return (
    <div className="nt-card cream" style={{ gridColumn: "1 / 13" }}>
      <div className="nt-section-h">
        <div>
          <div className="nt-eyebrow dk">GET /api/stream?topics=prices,bars,sessions</div>
          <h3 className="nt-title" style={{ color: "var(--ink)" }}>
            Stream Console
          </h3>
        </div>
        <div className="nt-statuschip" style={{ background: "var(--ink)", color: "var(--white)" }}>
          <span className={ledClassName} />
          {connected ? "LIVE" : "RECONNECTING"}
        </div>
      </div>
      <div
        className="nt-box"
        style={{
          background: "#131522",
          borderColor: "#3a4180",
          maxHeight: "280px",
          overflow: "auto",
          fontFamily: "var(--font-mono), JetBrains Mono, monospace",
          fontSize: "11px",
          color: "#c8d0ff",
        }}
      >
        {lines.length === 0 ? (
          <div style={{ color: "#8a90c0" }}>Waiting for SSE events...</div>
        ) : (
          lines.map((line, idx) => (
            <div key={`${line.ts}-${idx}`} style={{ display: "grid", gridTemplateColumns: "190px 90px 1fr", gap: "10px", padding: "4px 0" }}>
              <span style={{ color: "#8a90c0" }}>{line.ts}</span>
              <span style={{ color: "#ef5a23", textTransform: "uppercase" }}>{line.event}</span>
              <span>{line.payload}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
