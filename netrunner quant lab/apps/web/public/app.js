import React, { useEffect, useMemo, useState, useCallback } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap
} from "https://esm.sh/@xyflow/react@12.8.4?deps=react@18.3.1";
import { parse as parseYaml, stringify as stringifyYaml } from "https://esm.sh/yaml@2.5.0";

const html = htm.bind(React.createElement);
const apiUrl = window.__APP_CONFIG__?.apiUrl ?? "http://localhost:4400";

// ---- Spec-derived static metadata ----
const ELIGIBILITY_META = {
  HISTORICAL_FACTOR_OK: { tag: "ok", label: "Historical Factor OK", desc: "Backtestable on public history if coverage gate passes.", blocksHistorical: false },
  SUBJECT_TO_RETENTION: { tag: "warn", label: "Subject to Retention", desc: "Needs OI / LS history. Coverage gate must pass before leaderboard verification.", blocksHistorical: false },
  RECORDED_L2_REQUIRED: { tag: "danger", label: "Recorded L2 Required", desc: "Needs historical orderbook data. No recorded L2 = historical backtest blocked.", blocksHistorical: true },
  PAPER_ONLY_LIVE: { tag: "danger", label: "Paper-Only Live", desc: "Uses live microstructure not historically available. Forward paper only.", blocksHistorical: true },
  APPROXIMATE_FILLS: { tag: "warn", label: "Approximate Fills", desc: "OHLC hit-testing approximates fills. Allowed locally; unverified.", blocksHistorical: false }
};

const TIER_META = {
  "LOCAL ONLY": { tag: "muted", label: "Local Only" },
  "UNVERIFIED PAPER": { tag: "warn", label: "Unverified Paper" },
  "BACKTEST VERIFIED": { tag: "info", label: "Backtest Verified" },
  "LIVE PAPER VERIFIED": { tag: "ok", label: "Live Paper Verified" }
};

const SCREENS = [
  { id: "home", label: "Home Dashboard", icon: "▣", section: "Overview" },
  { id: "builder", label: "Strategy Builder", icon: "◇", section: "Build" },
  { id: "arena", label: "Backtest Arena", icon: "▷", section: "Build" },
  { id: "botstudio", label: "Bot Template Studio", icon: "▦", section: "Bots" },
  { id: "recommender", label: "Strategy Recommender", icon: "✦", section: "Bots" },
  { id: "xstocks", label: "xStocks / Cross-Asset", icon: "≣", section: "Bots" },
  { id: "cockpit", label: "Risk Cockpit", icon: "⚠", section: "Bots" },
  { id: "marketplace", label: "Bot Marketplace", icon: "◫", section: "Bots" },
  { id: "desk", label: "Strategy Desk ($100 all)", icon: "◰", section: "Run" },
  { id: "livepaper", label: "Live Paper (forward)", icon: "◉", section: "Run" },
  { id: "algo", label: "Algo Bot Lab", icon: "⚙", section: "Run" },
  { id: "portfolio", label: "Multi-Asset Portfolio", icon: "◧", section: "Run" },
  { id: "paper", label: "Paper War Room", icon: "◉", section: "Run" },
  { id: "optimizer", label: "Optimization Lab", icon: "≋", section: "Run" },
  { id: "risk", label: "Risk Lab", icon: "△", section: "Verify" },
  { id: "leaderboard", label: "Leaderboard", icon: "★", section: "Verify" },
  { id: "verifier", label: "Verifier / Passport", icon: "✓", section: "Verify" },
  { id: "replay", label: "Replay Debugger", icon: "▤", section: "Verify" },
  { id: "data", label: "Data Health Console", icon: "≡", section: "Infra" }
];

// ---- Helpers ----
const j = (v) => JSON.stringify(v, null, 2);
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
let authToken = null;

// §25 P1.3 — obtain the internal owner token. Production path: Privy getAccessToken() ->
// POST /auth/session (token-exchange). Dev/CI path: /auth/dev-token, behind window.DUALITY_USE_DEV_TOKEN
// (defaults on while Privy isn't wired into this static shell). Downstream (Bearer on REST, ?token=
// on SSE) is unchanged either way.
const USE_DEV_TOKEN = (typeof window !== "undefined" && window.DUALITY_USE_DEV_TOKEN === false) ? false : true;

async function privyAccessToken() {
  // Real Privy web SDK exposes getAccessToken(); absent in this static shell.
  try {
    if (typeof window !== "undefined" && window.privy && typeof window.privy.getAccessToken === "function") {
      return await window.privy.getAccessToken();
    }
  } catch { /* fall through */ }
  return null;
}

async function ensureAuthToken() {
  if (authToken) return authToken;
  // 1) Privy token-exchange when available.
  const privyTok = await privyAccessToken();
  if (privyTok) {
    const r = await fetch(`${apiUrl}/auth/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ privyToken: privyTok }),
    });
    if (r.ok) { authToken = (await r.json())?.ownerToken || null; if (authToken) return authToken; }
  }
  // 2) Dev/CI fallback.
  if (USE_DEV_TOKEN) {
    const r = await fetch(`${apiUrl}/auth/dev-token?ownerId=1`);
    if (r.ok) authToken = (await r.json())?.token || null;
  }
  return authToken;
}

// Drop the cached token (e.g. on 401 TOKEN_REVOKED) so the next call re-exchanges.
function clearAuthToken() { authToken = null; }

async function api(path, opts = {}) {
  const token = await ensureAuthToken();
  const res = await fetch(`${apiUrl}${path}`, {
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    ...opts
  });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, body };
}

function useHealth() {
  const [state, setState] = useState({ api: null, data: null, loading: true });
  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    const [health, data] = await Promise.all([
      api("/health"),
      api("/api/data/health")
    ]);
    setState({ api: health.body, data: data.body, loading: false });
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);
  return { ...state, refresh };
}

// ---- Eligibility banner ----
function EligibilityBanner({ label }) {
  const meta = ELIGIBILITY_META[label] ?? ELIGIBILITY_META.HISTORICAL_FACTOR_OK;
  return html`
    <div class="eligibility-banner">
      <div class="left">
        <span class=${`tag ${meta.tag}`}>${meta.label}</span>
        <span class="desc">${meta.desc}</span>
      </div>
    </div>
  `;
}

// ====================================================================
// Charting layer — dependency-free SVG (candles, lines, bars, gauges)
// ====================================================================
function fmtNum(v, d = 2) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 1) return v.toFixed(d);
  if (a === 0) return "0";
  return v.toFixed(Math.min(6, d + 3));
}
function niceExtent(lo, hi, padFrac = 0.08) {
  if (!isFinite(lo) || !isFinite(hi)) return [0, 1];
  if (lo === hi) { const p = Math.abs(lo) || 1; return [lo - p * 0.05, hi + p * 0.05]; }
  const pad = (hi - lo) * padFrac;
  return [lo - pad, hi + pad];
}

// Candlestick chart with volume strip, fill markers (buy/sell), overlays, crosshair.
function CandleChart({ bars, fills = [], overlays = [], height = 320, showVolume = true }) {
  const data = useMemo(() => (Array.isArray(bars) ? bars : []).map((b, i) => ({
    i, ts: Number(b.ts ?? b.t ?? b.event_ts ?? i),
    o: Number(b.open ?? b.o), h: Number(b.high ?? b.h),
    l: Number(b.low ?? b.l), c: Number(b.close ?? b.c),
    v: Number(b.volume ?? b.v ?? 0),
  })).filter((b) => isFinite(b.o) && isFinite(b.h) && isFinite(b.l) && isFinite(b.c)), [bars]);
  const [hov, setHov] = useState(null);
  if (!data.length) return html`<div class="chart-empty">No candles to display — load real data or generate sample bars.</div>`;
  const n = data.length;
  const W = 820, padL = 8, padR = 64, padT = 26, axisH = 18;
  const volH = showVolume ? 30 : 0, gap = showVolume ? 8 : 0;
  const plotH = Math.max(40, height - padT - axisH - volH - gap);
  const priceTop = padT, volTop = padT + plotH + gap;
  const plotW = W - padL - padR;
  const lo = Math.min(...data.map((b) => b.l)), hh = Math.max(...data.map((b) => b.h));
  const [ymin, ymax] = niceExtent(lo, hh);
  const xOf = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yOf = (v) => priceTop + (1 - (v - ymin) / ((ymax - ymin) || 1)) * plotH;
  const cw = Math.max(1.5, Math.min(13, (plotW / n) * 0.6));
  const vMax = Math.max(...data.map((b) => b.v), 1e-9);
  const up = "#5ec27a", dn = "#f7768e";
  const fillPts = (Array.isArray(fills) ? fills : []).map((f) => {
    const ft = Number(f.ts ?? f.event_ts ?? f.timestamp);
    let idx = f.index;
    if (idx == null && isFinite(ft)) {
      let best = 0, bd = Infinity;
      for (const b of data) { const d = Math.abs(b.ts - ft); if (d < bd) { bd = d; best = b.i; } }
      idx = best;
    }
    const price = Number(f.price ?? f.fill_price ?? f.payload_json?.fill_price ?? f.payload?.fill_price);
    const side = String(f.side ?? f.payload_json?.side ?? f.payload?.side ?? "").toLowerCase();
    return (idx == null || !isFinite(price)) ? null : { idx, price, side };
  }).filter(Boolean);
  const tickN = 5;
  const yticks = [...Array(tickN + 1)].map((_, k) => ymin + (k / tickN) * (ymax - ymin));
  const spanMs = data[n - 1].ts - data[0].ts;
  const multiDay = spanMs > 2 * 864e5;
  const fmtT = (ts) => {
    const d = new Date(ts);
    if (!isFinite(ts)) return "";
    return multiDay ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
      : `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };
  const xticks = [0, Math.floor((n - 1) * 0.25), Math.floor((n - 1) * 0.5), Math.floor((n - 1) * 0.75), n - 1]
    .filter((v, i, a) => a.indexOf(v) === i);
  const cur = hov != null ? data[hov] : data[n - 1];
  const move = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const idx = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    setHov(Math.max(0, Math.min(n - 1, idx)));
  };
  return html`
    <div class="chart-wrap">
      <svg class="chart-svg" viewBox=${`0 0 ${W} ${height}`} preserveAspectRatio="none"
           onMouseMove=${move} onMouseLeave=${() => setHov(null)}>
        ${yticks.map((tv, k) => html`<g key=${`y${k}`}>
          <line x1=${padL} y1=${yOf(tv)} x2=${padL + plotW} y2=${yOf(tv)} stroke="#232a36" stroke-width="0.5" />
          <text x=${padL + plotW + 4} y=${yOf(tv) + 3} fill="#5b6377" font-size="9">${fmtNum(tv)}</text>
        </g>`)}
        ${xticks.map((xi, k) => html`<text key=${`x${k}`} x=${xOf(xi)} y=${height - 5} fill="#5b6377" font-size="9" text-anchor="middle">${fmtT(data[xi].ts)}</text>`)}
        ${overlays.map((ov, oi) => {
          const pts = (ov.values || []).map((v, i) => isFinite(v) ? `${xOf(i)},${yOf(v)}` : null).filter(Boolean).join(" ");
          return html`<polyline key=${`ov${oi}`} fill="none" stroke=${ov.color || "#7dcfff"} stroke-width="1.1" points=${pts} opacity="0.9" />`;
        })}
        ${data.map((b) => {
          const col = b.c >= b.o ? up : dn;
          const bt = yOf(Math.max(b.o, b.c)), bb = yOf(Math.min(b.o, b.c));
          return html`<g key=${b.i}>
            <line x1=${xOf(b.i)} y1=${yOf(b.h)} x2=${xOf(b.i)} y2=${yOf(b.l)} stroke=${col} stroke-width="1" />
            <rect x=${xOf(b.i) - cw / 2} y=${bt} width=${cw} height=${Math.max(1, bb - bt)} fill=${col} />
          </g>`;
        })}
        ${showVolume && data.map((b) => {
          const hgt = (b.v / vMax) * volH;
          return html`<rect key=${`v${b.i}`} x=${xOf(b.i) - cw / 2} y=${volTop + volH - hgt} width=${cw} height=${Math.max(0.4, hgt)} fill=${b.c >= b.o ? "rgba(94,194,122,0.4)" : "rgba(247,118,142,0.4)"} />`;
        })}
        ${fillPts.map((f, k) => {
          const px = xOf(f.idx), py = yOf(f.price);
          const buy = f.side === "buy" || f.side === "long";
          const tri = buy ? `${px},${py + 9} ${px - 5},${py + 18} ${px + 5},${py + 18}`
                          : `${px},${py - 9} ${px - 5},${py - 18} ${px + 5},${py - 18}`;
          return html`<polygon key=${`f${k}`} points=${tri} fill=${buy ? up : dn} stroke="#0b0e14" stroke-width="0.5" />`;
        })}
        ${hov != null && html`<line x1=${xOf(hov)} y1=${priceTop} x2=${xOf(hov)} y2=${priceTop + plotH} stroke="#5b6377" stroke-width="0.5" stroke-dasharray="2 2" />`}
        <text x=${padL} y=${14} font-size="10.5">
          <tspan fill="#5b6377">O </tspan><tspan fill="#e4e9f0">${fmtNum(cur.o)}</tspan>
          <tspan fill="#5b6377">  H </tspan><tspan fill="#e4e9f0">${fmtNum(cur.h)}</tspan>
          <tspan fill="#5b6377">  L </tspan><tspan fill="#e4e9f0">${fmtNum(cur.l)}</tspan>
          <tspan fill="#5b6377">  C </tspan><tspan fill=${cur.c >= cur.o ? up : dn}>${fmtNum(cur.c)}</tspan>
        </text>
      </svg>
    </div>
  `;
}

// Multi-series line/area chart with axes.
function LineChart({ series = [], height = 160, fmt = fmtNum, zeroLine = false }) {
  const all = series.flatMap((s) => s.values || []).filter((v) => isFinite(v));
  if (!all.length) return html`<div class="chart-empty">No series data yet.</div>`;
  const n = Math.max(...series.map((s) => (s.values || []).length), 1);
  const W = 820, padL = 8, padR = 58, padT = 10, padB = 16;
  const plotW = W - padL - padR, plotH = height - padT - padB;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const [ymin, ymax] = niceExtent(lo, hi);
  const xOf = (i) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yOf = (v) => padT + (1 - (v - ymin) / ((ymax - ymin) || 1)) * plotH;
  const yticks = [ymin, (ymin + ymax) / 2, ymax];
  const baseY = ymin < 0 && ymax > 0 ? 0 : ymin;
  return html`
    <div class="chart-wrap">
      <svg class="chart-svg" viewBox=${`0 0 ${W} ${height}`} preserveAspectRatio="none">
        ${yticks.map((tv, k) => html`<g key=${k}>
          <line x1=${padL} y1=${yOf(tv)} x2=${padL + plotW} y2=${yOf(tv)} stroke="#232a36" stroke-width="0.5" />
          <text x=${padL + plotW + 4} y=${yOf(tv) + 3} fill="#5b6377" font-size="9">${fmt(tv)}</text>
        </g>`)}
        ${zeroLine && ymin < 0 && ymax > 0 ? html`<line x1=${padL} y1=${yOf(0)} x2=${padL + plotW} y2=${yOf(0)} stroke="#2f3847" stroke-width="0.7" />` : null}
        ${series.map((s, si) => {
          const vals = s.values || [];
          const pts = vals.map((v, i) => isFinite(v) ? `${xOf(i)},${yOf(v)}` : null).filter(Boolean).join(" ");
          const area = s.fill && vals.length ? `${xOf(0)},${yOf(baseY)} ${pts} ${xOf(vals.length - 1)},${yOf(baseY)}` : null;
          return html`<g key=${si}>
            ${s.fill ? html`<polygon points=${area} fill=${s.fill} stroke="none" />` : null}
            <polyline fill="none" stroke=${s.color || "#7aa2f7"} stroke-width="1.3" points=${pts} />
          </g>`;
        })}
      </svg>
      ${series.length > 1 ? html`<div class="chart-legend">${series.map((s, i) => html`<span key=${i}><i style=${{ background: s.color || "#7aa2f7" }}></i>${s.name}</span>`)}</div>` : null}
    </div>
  `;
}

// Vertical bar chart for categorical data (scores, contributions).
function BarChart({ data = [], height = 190, color = "#7aa2f7", fmt = fmtNum }) {
  const vals = data.map((d) => Number(d.value)).filter((v) => isFinite(v));
  if (!vals.length) return html`<div class="chart-empty">No data.</div>`;
  const W = 820, padL = 8, padR = 10, padT = 12, padB = 32;
  const plotW = W - padL - padR, plotH = height - padT - padB;
  const [ymin, ymax] = niceExtent(Math.min(0, ...vals), Math.max(0, ...vals), 0.12);
  const n = data.length;
  const bw = Math.max(4, Math.min(54, (plotW / n) * 0.62));
  const xOf = (i) => padL + (i + 0.5) * (plotW / n);
  const yOf = (v) => padT + (1 - (v - ymin) / ((ymax - ymin) || 1)) * plotH;
  return html`<div class="chart-wrap"><svg class="chart-svg" viewBox=${`0 0 ${W} ${height}`} preserveAspectRatio="none">
    <line x1=${padL} y1=${yOf(0)} x2=${padL + plotW} y2=${yOf(0)} stroke="#2f3847" stroke-width="0.6" />
    ${data.map((d, i) => {
      const v = Number(d.value) || 0, y0 = yOf(0), y1 = yOf(v);
      const top = Math.min(y0, y1), h = Math.max(1, Math.abs(y1 - y0));
      return html`<g key=${i}>
        <rect x=${xOf(i) - bw / 2} y=${top} width=${bw} height=${h} fill=${d.color || color} rx="2" />
        <text x=${xOf(i)} y=${top - 3} fill="#8a93a5" font-size="9" text-anchor="middle">${fmt(v)}</text>
        <text x=${xOf(i)} y=${height - 14} fill="#5b6377" font-size="8.5" text-anchor="middle">${String(d.label).slice(0, 12)}</text>
      </g>`;
    })}
  </svg></div>`;
}

// Semicircular gauge for a 0..max score.
function Gauge({ value, max = 100, label = "", color }) {
  const v = Math.max(0, Math.min(max, Number(value) || 0));
  const frac = max ? v / max : 0;
  const W = 220, H = 124, cx = 110, cy = 112, r = 86;
  const polar = (ang) => [cx + r * Math.cos(ang), cy - r * Math.sin(ang)];
  const [sx, sy] = polar(Math.PI), [ex, ey] = polar(0), [px, py] = polar(Math.PI * (1 - frac));
  const arc = (x1, y1, x2, y2, large) => `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  const c = color || (frac < 0.4 ? "#5ec27a" : frac < 0.7 ? "#e0af68" : "#f7768e");
  return html`<div class="chart-wrap" style=${{ textAlign: "center" }}><svg viewBox=${`0 0 ${W} ${H}`} style=${{ width: "100%", maxWidth: "260px" }}>
    <path d=${arc(sx, sy, ex, ey, 0)} fill="none" stroke="#232a36" stroke-width="13" stroke-linecap="round" />
    <path d=${arc(sx, sy, px, py, frac > 0.5 ? 1 : 0)} fill="none" stroke=${c} stroke-width="13" stroke-linecap="round" />
    <text x=${cx} y=${cy - 16} fill="#e4e9f0" font-size="28" text-anchor="middle" font-weight="600">${Math.round(v)}</text>
    <text x=${cx} y=${cy + 2} fill="#5b6377" font-size="10" text-anchor="middle">${label}</text>
  </svg></div>`;
}

// Compute simple EMA series for chart overlays.
function ema(values, period) {
  if (!values.length || period < 1) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) { prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}

// Loads real candles from a stored regime into the caller's bars state.
function RegimeBarLoader({ onLoad, max = 500 }) {
  const [regimes, setRegimes] = useState([]);
  const [sel, setSel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    api("/api/regimes").then(({ body }) => {
      const r = body?.regimes || [];
      setRegimes(r);
      if (r.length) setSel(r[0].regime_id);
    }).catch(() => {});
  }, []);
  const load = async () => {
    if (!sel) return;
    setBusy(true); setErr("");
    const { ok, body } = await api(`/api/regimes/${encodeURIComponent(sel)}/bars`);
    setBusy(false);
    if (!ok || !(body?.bars || []).length) { setErr(body?.error || "No bars stored — load this regime in Data Health first."); return; }
    onLoad(body.bars.slice(-max), body);
  };
  return html`<div class="regime-loader">
    <span class="rl-label">Real candles</span>
    <select value=${sel} onChange=${(e) => setSel(e.target.value)}>
      ${regimes.length === 0
        ? html`<option value="">No regimes available</option>`
        : regimes.map((r) => html`<option key=${r.regime_id} value=${r.regime_id}>${r.regime_id} · ${r.symbol} ${r.interval}</option>`)}
    </select>
    <button class="secondary" onClick=${load} disabled=${busy || !sel}>${busy ? "Loading…" : "Load"}</button>
    ${err ? html`<span class="footer-note" style=${{ color: "var(--danger)", margin: 0 }}>${err}</span>` : null}
  </div>`;
}

// ---- Header ----
function Header({ health }) {
  const apiOk = health.api?.ok;
  const dataAge = health.data?.live_data_age_ms;
  const stale = typeof dataAge === "number" && dataAge > 30_000;
  return html`
    <header>
      <div class="brand">
        <span class="brand-dot"></span>
        <h1>Duality Netrunner Quant Lab</h1>
        <span class="tag muted">v3.1</span>
      </div>
      <div style=${{ display: "flex", gap: 10, alignItems: "center" }}>
        ${apiOk
          ? html`<span class="status-pill"><span class="pulse"></span>API up</span>`
          : html`<span class="status-pill bad"><span class="pulse"></span>API down</span>`}
        ${stale
          ? html`<span class="status-pill warn"><span class="pulse"></span>Data stale</span>`
          : html`<span class="status-pill"><span class="pulse"></span>Data fresh</span>`}
      </div>
    </header>
  `;
}

// ---- Sidebar nav ----
function Sidebar({ screen, setScreen }) {
  const sections = ["Overview", "Build", "Bots", "Run", "Verify", "Infra"];
  return html`
    <aside class="sidebar">
      ${sections.map((sec) => html`
        <${React.Fragment} key=${sec}>
          <div class="nav-section">${sec}</div>
          ${SCREENS.filter((s) => s.section === sec).map((s) => html`
            <button
              key=${s.id}
              class=${`nav-item ${screen === s.id ? "active" : ""}`}
              onClick=${() => setScreen(s.id)}
            >
              <span class="nav-icon">${s.icon}</span>${s.label}
            </button>
          `)}
        </>
      `)}
      <div style=${{ marginTop: 24 }}>
        <div class="nav-section">Safety</div>
        <div class="footer-note" style=${{ padding: "0 8px" }}>
          No Bybit API keys.<br />
          No private endpoints.<br />
          All accounts virtual.<br />
          Official scores via verifier only.
        </div>
      </div>
    </aside>
  `;
}

// ---- Home Dashboard ----
function HomeDashboard({ health, templates, refreshHealth }) {
  const dataAgeSec = health.data?.live_data_age_ms != null ? Math.round(health.data.live_data_age_ms / 1000) : null;
  const dbOk = health.api?.db === "up";
  const redisOk = health.api?.redis === "up";
  const coverageRows = health.data?.recent_coverage || [];
  const [previewBars, setPreviewBars] = useState([]);
  const [previewMeta, setPreviewMeta] = useState(null);
  return html`
    <div class="page-title">
      <div>
        <h2>Home Dashboard</h2>
        <div class="sub">Lab status, data health, and recent activity (§14).</div>
      </div>
      <button class="ghost" onClick=${refreshHealth}>Refresh</button>
    </div>
    <div class="page-desc">
      Brains separated from money: research and paper trade with public Bybit data and internal virtual accounts. No real orders, no API keys.
    </div>

    <div class="tiles">
      <div class=${`tile ${dbOk ? "ok" : "danger"}`}>
        <div class="tile-label">Postgres / Timescale</div>
        <div class="tile-value">${dbOk ? "Up" : "Down"}</div>
        <div class="tile-sub">Source of truth for events</div>
      </div>
      <div class=${`tile ${redisOk ? "ok" : "danger"}`}>
        <div class="tile-label">Redis Cache</div>
        <div class="tile-value">${redisOk ? "Up" : "Down"}</div>
        <div class="tile-sub">Rebuildable from event log</div>
      </div>
      <div class=${`tile ${dataAgeSec == null || dataAgeSec > 30 ? "warn" : "ok"}`}>
        <div class="tile-label">Live Data Age</div>
        <div class="tile-value">${dataAgeSec == null ? "—" : `${dataAgeSec}s`}</div>
        <div class="tile-sub">Paper pauses if &gt; max_data_age_ms</div>
      </div>
      <div class="tile">
        <div class="tile-label">Templates Loaded</div>
        <div class="tile-value">${templates.length}</div>
        <div class="tile-sub">DCA, trend, MR, funding, OI, L2…</div>
      </div>
    </div>

    <div class="panel" style=${{ marginTop: 16 }}>
      <div class="panel-title">
        <span>Market Preview${previewMeta ? ` · ${previewMeta.regime?.regime_id} (${previewBars.length} candles)` : ""}</span>
      </div>
      <${RegimeBarLoader} onLoad=${(bars, meta) => { setPreviewBars(bars); setPreviewMeta(meta); }} />
      ${previewBars.length
        ? html`<div style=${{ marginTop: 12 }}><${CandleChart} bars=${previewBars} height=${300} /></div>`
        : html`<div class="chart-empty" style=${{ marginTop: 12 }}>Load a stored regime to preview real Bybit candles.</div>`}
    </div>

    <div class="panel" style=${{ marginTop: 16 }}>
      <div class="panel-title">Recent Data Coverage</div>
      ${coverageRows.length > 0 ? html`<div style=${{ marginBottom: 12 }}><${BarChart}
        data=${coverageRows.map((r) => ({ label: `${r.symbol} ${r.interval}m`, value: Number(r.missing_bars) || 0, color: (Number(r.missing_bars) || 0) === 0 ? "#5ec27a" : "#e0af68" }))}
        height=${170} fmt=${(v) => String(Math.round(v))} /></div>` : null}
      ${coverageRows.length === 0
        ? html`<div class="footer-note">No coverage rows yet. Start the data-ingestor and request a backfill.</div>`
        : html`<table>
            <thead><tr><th>Symbol</th><th>Interval</th><th>Range</th><th>Missing</th><th>Status</th></tr></thead>
            <tbody>
              ${coverageRows.map((r, i) => html`
                <tr key=${i}>
                  <td>${r.symbol}</td>
                  <td class="num">${r.interval}</td>
                  <td class="num">${r.range_start} → ${r.range_end}</td>
                  <td class="num">${r.missing_bars}</td>
                  <td>${r.missing_bars === 0
                    ? html`<span class="tag ok">Complete</span>`
                    : html`<span class="tag warn">Gap</span>`}</td>
                </tr>
              `)}
            </tbody>
          </table>`}
    </div>
  `;
}

// ---- Strategy Builder ----
function StrategyBuilder({ templates, selected, onSelect, jsonText, yamlText, syncFromJson, syncFromYaml, editorMode, setEditorMode, validation, validationError, validateStrategy, saveVersion, coverageInput, setCoverageInput, strategyId, setStrategyId, strategyVersionId, setStrategyVersionId }) {
  const eligibility = validation?.eligibility_label ?? selected?.eligibility ?? "HISTORICAL_FACTOR_OK";
  const eligMeta = ELIGIBILITY_META[eligibility] ?? ELIGIBILITY_META.HISTORICAL_FACTOR_OK;
  const [bpBars, setBpBars] = useState([]);

  const flow = useMemo(() => {
    const x = 140;
    const nodes = [
      { id: "universe", position: { x, y: 30 }, data: { label: "Universe" } },
      { id: "features", position: { x, y: 110 }, data: { label: "Features" } },
      { id: "entry", position: { x, y: 190 }, data: { label: "Entry Conditions" } },
      { id: "exit", position: { x, y: 270 }, data: { label: "Exit + Risk" } }
    ];
    const edges = [
      { id: "e1", source: "universe", target: "features" },
      { id: "e2", source: "features", target: "entry" },
      { id: "e3", source: "entry", target: "exit" }
    ];
    if (selected?.id === "orderbook_scalper") {
      nodes.push({ id: "l2", position: { x: 380, y: 110 }, data: { label: "⚠ L2 Required" } });
      edges.push({ id: "e4", source: "l2", target: "features" });
    }
    return { nodes, edges };
  }, [selected?.id]);

  return html`
    <div class="page-title">
      <div>
        <h2>Strategy Builder</h2>
        <div class="sub">Visual DSL + JSON/YAML editor with semantic validation (§6, §14, §24, §26).</div>
      </div>
    </div>

    <${EligibilityBanner} label=${eligibility} />

    <div style=${{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>
      <div class="panel">
        <div class="panel-title">Template Library</div>
        ${templates.map((t) => html`
          <div
            key=${t.id}
            class=${`template-card ${selected?.id === t.id ? "active" : ""}`}
            onClick=${() => onSelect(t)}
          >
            <div class="t-name">${t.name}</div>
            <div class="t-desc">${t.description}</div>
            <span class=${`tag ${ELIGIBILITY_META[t.eligibility]?.tag || "warn"}`}>${t.eligibility}</span>
          </div>
        `)}
      </div>

      <div>
        <div class="panel">
          <div class="panel-title">Visual DSL (compiles to StrategySpec)</div>
          <div class="flow-wrap">
            <${ReactFlow} nodes=${flow.nodes} edges=${flow.edges} fitView>
              <${Background} variant="dots" gap=${14} size=${1} />
              <${Controls} />
              <${MiniMap} />
            <//>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">Editor</div>
          <div class="tabs">
            <button class=${editorMode === "json" ? "active" : ""} onClick=${() => setEditorMode("json")}>JSON</button>
            <button class=${editorMode === "yaml" ? "active" : ""} onClick=${() => setEditorMode("yaml")}>YAML</button>
          </div>
          ${editorMode === "json"
            ? html`<textarea rows=${14} value=${jsonText} onChange=${(e) => syncFromJson(e.target.value)} />`
            : html`<textarea rows=${14} value=${yamlText} onChange=${(e) => syncFromYaml(e.target.value)} />`}
        </div>

        <div class="panel">
          <div class="panel-title">Identifiers</div>
          <div class="grid-2">
            <div class="field"><label>Strategy ID</label>
              <input value=${strategyId} onChange=${(e) => setStrategyId(e.target.value)} /></div>
            <div class="field"><label>Strategy Version ID</label>
              <input value=${strategyVersionId} onChange=${(e) => setStrategyVersionId(e.target.value)} /></div>
          </div>
          <button class="secondary" onClick=${saveVersion}>Save Strategy + Version</button>
        </div>

        <div class="panel">
          <div class="panel-title">Validation + Coverage Window</div>
          <div class="grid-3">
            <div class="field"><label>Symbol <${MarketHoursBadge} symbol=${coverageInput.symbol} /></label>
              <input list="builder-symbols" value=${coverageInput.symbol} onChange=${(e) => setCoverageInput((s) => ({ ...s, symbol: e.target.value }))} />
              <${SymbolDatalist} id="builder-symbols" /></div>
            <div class="field"><label>Interval (min)</label>
              <input value=${coverageInput.interval} onChange=${(e) => setCoverageInput((s) => ({ ...s, interval: e.target.value }))} /></div>
            <div class="field"><label>Category</label>
              <input value=${coverageInput.category} onChange=${(e) => setCoverageInput((s) => ({ ...s, category: e.target.value }))} /></div>
          </div>
          <div class="grid-2">
            <div class="field"><label>Start (ms)</label>
              <input value=${coverageInput.startTs} onChange=${(e) => setCoverageInput((s) => ({ ...s, startTs: Number(e.target.value) }))} /></div>
            <div class="field"><label>End (ms)</label>
              <input value=${coverageInput.endTs} onChange=${(e) => setCoverageInput((s) => ({ ...s, endTs: Number(e.target.value) }))} /></div>
          </div>
          <button onClick=${validateStrategy}>Validate Strategy</button>

          ${validation && html`
            <div style=${{ marginTop: 12 }}>
              <span class=${`tag ${ELIGIBILITY_META[validation.eligibility_label]?.tag || "warn"}`}>${validation.eligibility_label}</span>
              ${validation.valid
                ? html`<div class="alert ok"><span class="alert-icon">✓</span><div>Validation passed.</div></div>`
                : html`<div class="alert danger"><span class="alert-icon">✗</span><div>${(validation.errors || []).join(" · ")}</div></div>`}
              ${(validation.warnings || []).map((w) => html`<div class="alert warn" key=${w}><span class="alert-icon">!</span><div>${w}</div></div>`)}
            </div>
          `}
          ${validationError && html`<div class="alert danger"><span class="alert-icon">✗</span><div>${validationError}</div></div>`}
          ${eligMeta.blocksHistorical && html`<div class="alert danger"><span class="alert-icon">⊘</span><div>Historical backtest is disabled for this template. ${eligMeta.desc}</div></div>`}
        </div>

        <div class="panel">
          <div class="panel-title">Market Preview</div>
          <${RegimeBarLoader} onLoad=${(bars) => setBpBars(bars)} />
          ${bpBars.length
            ? html`<div style=${{ marginTop: 12 }}><${CandleChart} bars=${bpBars} height=${260} /></div>`
            : html`<div class="chart-empty" style=${{ marginTop: 12 }}>Load real candles to preview the market your strategy targets.</div>`}
        </div>
      </div>
    </div>
  `;
}

// ---- Backtest Arena ----
function BacktestArena({ strategyVersionId, coverageInput, eligibility, runBacktest, runResult, runError, barsText, setBarsText, fundingText, setFundingText, checkCoverage, coverageResult }) {
  const eligMeta = ELIGIBILITY_META[eligibility] ?? ELIGIBILITY_META.HISTORICAL_FACTOR_OK;
  const blocked = eligMeta.blocksHistorical;
  const metrics = runResult?.run?.metrics_json || null;
  const events = runResult?.events || [];
  const fills = events.filter((e) => e.event_type === "FILL");
  const tier = runResult?.run?.result_tier || "LOCAL ONLY";
  const tierMeta = TIER_META[tier] || TIER_META["LOCAL ONLY"];
  const inputBars = useMemo(() => safeParse(barsText) || [], [barsText]);
  const equityCurve = (runResult?.run?.equity_curve || metrics?.equity_curve || []).map(Number).filter(isFinite);

  return html`
    <div class="page-title">
      <div>
        <h2>Backtest Arena <${MarketHoursBadge} symbol=${coverageInput.symbol} /></h2>
        <div class="sub">Event-driven run. No-lookahead, stop-first, strict-limit, timestamp-funding (§10, §14). xStocks: spot, long-only, RTH-aware fills.</div>
      </div>
    </div>

    <${EligibilityBanner} label=${eligibility} />

    <div class="panel">
      <div class="panel-title">Coverage Check</div>
      <button class="secondary" onClick=${checkCoverage}>Check Coverage for ${coverageInput.symbol} / ${coverageInput.interval}m</button>
      ${coverageResult && html`<pre>${j(coverageResult)}</pre>`}
    </div>

    <div class="panel">
      <div class="panel-title">Run Config</div>
      <${RegimeBarLoader} onLoad=${(bars) => setBarsText(j(bars))} />
      ${inputBars.length ? html`<div style=${{ marginTop: 12 }}><${CandleChart} bars=${inputBars} height=${260} /></div>` : null}
      <div class="field" style=${{ marginTop: 12 }}><label>Bars (JSON)</label>
        <textarea rows=${6} value=${barsText} onChange=${(e) => setBarsText(e.target.value)} /></div>
      <div class="field"><label>Funding Rows (JSON) — applied at actual fundingRateTimestamp only</label>
        <textarea rows=${4} value=${fundingText} onChange=${(e) => setFundingText(e.target.value)} /></div>
      <button onClick=${runBacktest} disabled=${blocked}>
        ${blocked ? "Historical Backtest Disabled" : "Run Historical Backtest"}
      </button>
      <div class="footer-note">
        Fill model: next-open + configured slippage · Funding: timestamp-driven · Same-bar TP+SL: stop-first · Limit fills: strict penetration only
      </div>
      ${runError && html`<div class="alert danger"><span class="alert-icon">✗</span><div>${runError}</div></div>`}
    </div>

    ${runResult && html`
      <div class="panel">
        <div class="panel-title">
          <span>Run Results</span>
          <span class=${`tag ${tierMeta.tag}`}>${tierMeta.label}</span>
        </div>

        <div class="kv">
          <div class="k">Run ID</div><div class="v">${runResult.run?.run_id || "—"}</div>
          <div class="k">Data version</div><div class="v">${runResult.run?.data_version || "—"}</div>
          <div class="k">Engine version</div><div class="v">${runResult.run?.engine_version || "—"}</div>
          <div class="k">Seed</div><div class="v">${runResult.run?.seed ?? "—"}</div>
          <div class="k">Fill model</div><div class="v">next-open + slippage_bps</div>
          <div class="k">Funding model</div><div class="v">funding_history_timestamp_driven</div>
        </div>

        ${metrics && html`
          <div class="tiles" style=${{ marginTop: 14 }}>
            <div class="tile"><div class="tile-label">Total Return</div><div class="tile-value">${(Number(metrics.total_return_after_fees_funding ?? 0) * 100).toFixed(2)}%</div></div>
            <div class="tile"><div class="tile-label">Sharpe (√N)</div><div class="tile-value">${Number(metrics.sharpe ?? 0).toFixed(2)}</div></div>
            <div class="tile"><div class="tile-label">Max Drawdown</div><div class="tile-value">${(Number(metrics.max_drawdown ?? 0) * 100).toFixed(2)}%</div></div>
            <div class="tile"><div class="tile-label">Fills</div><div class="tile-value">${fills.length}</div></div>
          </div>
        `}

        <div style=${{ marginTop: 14 }}>
          <div class="panel-title">Price + Executions (fills marked on candles)</div>
          <${CandleChart} bars=${inputBars} fills=${fills} height=${320} />
        </div>

        ${equityCurve.length ? html`
        <div style=${{ marginTop: 14 }}>
          <div class="panel-title">Equity Curve</div>
          <${LineChart} series=${[{ name: "Equity", color: "#7aa2f7", fill: "rgba(122,162,247,0.12)", values: equityCurve }]} height=${160} />
        </div>` : null}

        <div style=${{ marginTop: 14 }}>
          <div class="panel-title">Trade List</div>
          ${fills.length === 0 ? html`<div class="footer-note">No fills generated.</div>` : html`
            <table>
              <thead><tr><th>Timestamp</th><th>Side</th><th>Qty</th><th>Fill Price</th></tr></thead>
              <tbody>
                ${fills.map((evt, i) => html`
                  <tr key=${i}>
                    <td class="num">${evt.event_ts}</td>
                    <td>${evt.payload_json?.side || evt.payload?.side}</td>
                    <td class="num">${evt.payload_json?.qty || evt.payload?.qty}</td>
                    <td class="num">${evt.payload_json?.fill_price || evt.payload?.fill_price}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
        </div>

        <div style=${{ marginTop: 14 }}>
          <div class="panel-title">Event Log</div>
          <pre>${j(events.slice(0, 50))}${events.length > 50 ? `\n... (+${events.length - 50} more)` : ""}</pre>
        </div>
      </div>
    `}
  `;
}

// ---- Paper War Room ----
function PaperWarRoom({ paperState, setPaperState, paperResult, paperError, initPaper, sendTick, rebuildPaper }) {
  const [ticks, setTicks] = useState([]);
  useEffect(() => {
    if (paperResult?.tickRes) {
      const price = Number(paperResult.tickRes.price ?? paperResult.tickRes.last_price ?? paperState.price);
      if (isFinite(price)) setTicks((t) => [...t.slice(-249), { ts: Number(paperState.tsMs) || Date.now(), price }]);
    }
  }, [paperResult]);
  const pos = paperResult?.position || paperResult?.positions || null;
  return html`
    <div class="page-title">
      <div>
        <h2>Paper War Room</h2>
        <div class="sub">Virtual sessions with staleness gate + Redis rebuild from event log (§11, §27).</div>
      </div>
    </div>

    <div class="alert info">
      <span class="alert-icon">ⓘ</span>
      <div>Staleness gate runs <b>before</b> any signal logic. On reconnect we wait for <b>N fresh ticks</b> before resuming.
      Redis hot state is fully rebuildable from <code>paper_events</code>.</div>
    </div>

    <div class="panel">
      <div class="panel-title">Session Setup</div>
      <div class="grid-3">
        <div class="field"><label>Account ID</label>
          <input value=${paperState.accountId} onChange=${(e) => setPaperState((s) => ({ ...s, accountId: e.target.value }))} /></div>
        <div class="field"><label>Session ID</label>
          <input value=${paperState.sessionId} onChange=${(e) => setPaperState((s) => ({ ...s, sessionId: e.target.value }))} /></div>
        <div class="field"><label>Strategy Version</label>
          <input value=${paperState.strategyVersionId} onChange=${(e) => setPaperState((s) => ({ ...s, strategyVersionId: e.target.value }))} /></div>
      </div>
      <button class="secondary" onClick=${initPaper}>Init Account + Session</button>
    </div>

    <div class="panel">
      <div class="panel-title">Tick Input</div>
      <div class="grid-3">
        <div class="field"><label>Symbol</label>
          <input value=${paperState.symbol} onChange=${(e) => setPaperState((s) => ({ ...s, symbol: e.target.value }))} /></div>
        <div class="field"><label>Price</label>
          <input value=${paperState.price} onChange=${(e) => setPaperState((s) => ({ ...s, price: e.target.value }))} /></div>
        <div class="field"><label>Tick Timestamp (ms)</label>
          <input value=${paperState.tsMs} onChange=${(e) => setPaperState((s) => ({ ...s, tsMs: Number(e.target.value) }))} /></div>
      </div>
      <div class="row">
        <button onClick=${sendTick}>Process Tick</button>
        <button class="secondary" onClick=${rebuildPaper}>Rebuild From Events</button>
        <button class="ghost" onClick=${() => setPaperState((s) => ({ ...s, tsMs: Date.now() }))}>Use Current Time</button>
      </div>
      ${paperError && html`<div class="alert danger"><span class="alert-icon">✗</span><div>${paperError}</div></div>`}
    </div>

    <div class="panel">
      <div class="panel-title">
        <span>Live Price Feed (${ticks.length} ticks)</span>
        ${ticks.length ? html`<span class="tag info">last ${fmtNum(ticks[ticks.length - 1].price)}</span>` : null}
      </div>
      ${ticks.length
        ? html`<${LineChart} series=${[{ name: "Price", color: "#7dcfff", fill: "rgba(125,207,255,0.10)", values: ticks.map((t) => t.price) }]} height=${200} />`
        : html`<div class="chart-empty">Process ticks to build the live price chart.</div>`}
    </div>

    ${paperResult && html`
      <div class="panel">
        <div class="panel-title">Session State</div>
        <pre>${j(paperResult)}</pre>
      </div>
    `}
  `;
}

// ---- Optimization Lab ----
function OptimizationLab({ strategyVersionId, optimizerCandidatesText, setOptimizerCandidatesText, runOptimization, optimizerResult, optimizerError }) {
  return html`
    <div class="page-title">
      <div>
        <h2>Optimization Lab</h2>
        <div class="sub">Vector sweep → event re-score for finalists. Parity-checked (§12, §28).</div>
      </div>
    </div>

    <div class="alert info">
      <span class="alert-icon">ⓘ</span>
      <div>Vector engine runs sweeps; <b>only top-N candidates are re-scored on the event engine</b>. Parity thresholds: return drift 0.5pp, drawdown 1pp, trade-count 2. Templates that fail parity get marked <b>event-only</b>.</div>
    </div>

    <div class="panel">
      <div class="panel-title">Candidates (JSON)</div>
      <textarea rows=${12} value=${optimizerCandidatesText} onChange=${(e) => setOptimizerCandidatesText(e.target.value)} />
      <div class="row" style=${{ marginTop: 8 }}>
        <button onClick=${runOptimization}>Run Sweep + Event Re-score</button>
      </div>
      ${optimizerError && html`<div class="alert danger"><span class="alert-icon">✗</span><div>${optimizerError}</div></div>`}
    </div>

    ${optimizerResult && html`
      <div class="panel">
        <div class="panel-title">Finalists (event-rescored)</div>
        ${optimizerResult.finalists?.length
          ? html`<div style=${{ marginBottom: 12 }}><${BarChart}
              data=${optimizerResult.finalists.map((f, i) => ({ label: `#${i + 1}`, value: Number(f.event_score) || 0, color: f.parity_ok ? "#5ec27a" : "#e0af68" }))}
              height=${180} fmt=${(v) => v.toFixed(3)} /></div>` : null}
        ${optimizerResult.finalists?.length
          ? html`<table>
              <thead><tr><th>#</th><th>Params</th><th>Event Score</th><th>Parity</th></tr></thead>
              <tbody>
                ${optimizerResult.finalists.map((f, i) => html`
                  <tr key=${i}>
                    <td>${i + 1}</td>
                    <td class="num">${JSON.stringify(f.params)}</td>
                    <td class="num">${f.event_score?.toFixed?.(4) ?? f.event_score ?? "—"}</td>
                    <td>${f.parity_ok ? html`<span class="tag ok">OK</span>` : html`<span class="tag warn">Event-only</span>`}</td>
                  </tr>
                `)}
              </tbody>
            </table>`
          : html`<pre>${j(optimizerResult)}</pre>`}
      </div>
    `}
  `;
}

// ---- Risk Lab ----
function RiskLab({ riskInput, setRiskInput, riskResult, evaluateRisk }) {
  return html`
    <div class="page-title">
      <div>
        <h2>Risk Lab</h2>
        <div class="sub">Hard gates: drawdown cap, liquidation_events==0, complete coverage, overfit, approximate_fills (§13.3, §29).</div>
      </div>
    </div>

    <div class="alert warn">
      <span class="alert-icon">!</span>
      <div>Hard gates run <b>in addition to</b> the weighted score. A return-flavoured strategy with high drawdown is gated out regardless of percentile rank.</div>
    </div>

    <div class="panel">
      <div class="panel-title">Candidate Metrics</div>
      <div class="grid-3">
        <div class="field"><label>Total Return</label><input value=${riskInput.total_return_after_fees_funding} onChange=${(e) => setRiskInput((s) => ({ ...s, total_return_after_fees_funding: Number(e.target.value) }))} /></div>
        <div class="field"><label>Sharpe</label><input value=${riskInput.sharpe} onChange=${(e) => setRiskInput((s) => ({ ...s, sharpe: Number(e.target.value) }))} /></div>
        <div class="field"><label>Calmar</label><input value=${riskInput.calmar} onChange=${(e) => setRiskInput((s) => ({ ...s, calmar: Number(e.target.value) }))} /></div>
        <div class="field"><label>Max Drawdown</label><input value=${riskInput.max_drawdown} onChange=${(e) => setRiskInput((s) => ({ ...s, max_drawdown: Number(e.target.value) }))} /></div>
        <div class="field"><label>Liquidation Events</label><input value=${riskInput.liquidation_events} onChange=${(e) => setRiskInput((s) => ({ ...s, liquidation_events: Number(e.target.value) }))} /></div>
        <div class="field"><label>Overfit Penalty</label><input value=${riskInput.overfit_penalty} onChange=${(e) => setRiskInput((s) => ({ ...s, overfit_penalty: Number(e.target.value) }))} /></div>
      </div>
      <div class="row">
        <label style=${{ flex: "0 0 auto", color: "var(--text-muted)" }}>
          <input type="checkbox" style=${{ width: 16, marginRight: 6 }}
            checked=${riskInput.data_coverage_complete}
            onChange=${(e) => setRiskInput((s) => ({ ...s, data_coverage_complete: e.target.checked }))} />
          Data coverage complete
        </label>
        <label style=${{ flex: "0 0 auto", color: "var(--text-muted)" }}>
          <input type="checkbox" style=${{ width: 16, marginRight: 6 }}
            checked=${riskInput.approximate_fills}
            onChange=${(e) => setRiskInput((s) => ({ ...s, approximate_fills: e.target.checked }))} />
          Approximate fills
        </label>
      </div>
      <button onClick=${evaluateRisk}>Evaluate Risk Gates</button>
    </div>

    ${riskResult && html`
      <div class="panel">
        <div class="panel-title">
          <span>Gate Result</span>
          ${riskResult.hard_gates_passed
            ? html`<span class="tag ok">All Gates Passed</span>`
            : html`<span class="tag danger">Gated Out</span>`}
        </div>
        <${Gauge} value=${riskResult.base_score} max=${100} label="Weighted score" color=${riskResult.hard_gates_passed ? "#5ec27a" : "#f7768e"} />
        <div class="kv">
          <div class="k">Base score</div><div class="v">${riskResult.base_score?.toFixed?.(4)}</div>
          <div class="k">Gate failures</div><div class="v">${(riskResult.gate_failures || []).join(", ") || "—"}</div>
        </div>
      </div>
    `}
  `;
}

// ---- Leaderboard ----
function Leaderboard({ rows, tier, setTier, refresh }) {
  return html`
    <div class="page-title">
      <div>
        <h2>Leaderboard</h2>
        <div class="sub">Verified tiers only via Duality verifier. Local/Unverified shown separately and never officially ranked (§13, §30).</div>
      </div>
      <button class="ghost" onClick=${refresh}>Refresh</button>
    </div>

    <div class="toolbar">
      ${Object.keys(TIER_META).map((t) => html`
        <button key=${t} class=${`secondary ${tier === t ? "" : "ghost"}`} onClick=${() => setTier(t)}>${TIER_META[t].label}</button>
      `)}
    </div>

    ${rows && rows.length > 0 ? html`<div class="panel">
      <div class="panel-title">Verified Scores</div>
      <${BarChart} data=${rows.slice(0, 20).map((r, i) => ({ label: (r.strategy_name || r.strategy_version_id || `#${i + 1}`), value: Number(r.score) || 0 }))} height=${190} fmt=${(v) => v.toFixed(3)} />
    </div>` : null}

    <div class="panel">
      ${(!rows || rows.length === 0)
        ? html`<div class="footer-note">No passports for tier <b>${tier}</b>. Publish a passport from the Verifier screen.</div>`
        : html`<table>
            <thead><tr><th>Rank</th><th>Strategy</th><th>Tier</th><th>Score</th><th>Verified at</th></tr></thead>
            <tbody>
              ${rows.map((r, i) => html`
                <tr key=${r.passport_id || i}>
                  <td>${i + 1}</td>
                  <td>${r.strategy_name || r.strategy_version_id}</td>
                  <td><span class=${`tag ${TIER_META[r.tier]?.tag || "muted"}`}>${r.tier}</span></td>
                  <td class="num">${r.score?.toFixed?.(4) ?? r.score ?? "—"}</td>
                  <td class="num">${r.signed_at || "—"}</td>
                </tr>
              `)}
            </tbody>
          </table>`}
    </div>
  `;
}

// ---- Verifier / Passport ----
function VerifierPassport({ verifyInput, setVerifyInput, verifyResult, verifyError, submit }) {
  return html`
    <div class="page-title">
      <div>
        <h2>Verifier / Passport</h2>
        <div class="sub">Server-side replay on pinned canonical data. Client-submitted PnL is ignored (§13.2, §30).</div>
      </div>
    </div>

    <div class="alert info">
      <span class="alert-icon">ⓘ</span>
      <div>The verifier <b>never re-fetches Bybit</b> at scoring time. It replays the strategy version on Duality's pinned dataset and signs the resulting tier.</div>
    </div>

    <div class="panel">
      <div class="panel-title">Submit Passport for Verification</div>
      <div class="grid-2">
        <div class="field"><label>Run ID</label><input value=${verifyInput.runId} onChange=${(e) => setVerifyInput((s) => ({ ...s, runId: e.target.value }))} /></div>
        <div class="field"><label>Strategy Version ID</label><input value=${verifyInput.strategyVersionId} onChange=${(e) => setVerifyInput((s) => ({ ...s, strategyVersionId: e.target.value }))} /></div>
        <div class="field"><label>Submitted Run Hash</label><input value=${verifyInput.submittedRunHash} onChange=${(e) => setVerifyInput((s) => ({ ...s, submittedRunHash: e.target.value }))} /></div>
        <div class="field"><label>Submitted Strategy Hash</label><input value=${verifyInput.submittedStrategyHash} onChange=${(e) => setVerifyInput((s) => ({ ...s, submittedStrategyHash: e.target.value }))} /></div>
        <div class="field"><label>Requested Tier</label>
          <select value=${verifyInput.requestedTier} onChange=${(e) => setVerifyInput((s) => ({ ...s, requestedTier: e.target.value }))}>
            <option value="BACKTEST_VERIFIED">BACKTEST_VERIFIED</option>
            <option value="LIVE_PAPER_VERIFIED">LIVE_PAPER_VERIFIED (host-from-start only)</option>
          </select>
        </div>
        <div class="field"><label>Data Snapshot ID</label><input value=${verifyInput.dataSnapshotId} onChange=${(e) => setVerifyInput((s) => ({ ...s, dataSnapshotId: e.target.value }))} /></div>
      </div>
      <button onClick=${submit}>Submit for Verification</button>
      ${verifyError && html`<div class="alert danger"><span class="alert-icon">✗</span><div>${verifyError}</div></div>`}
    </div>

    ${verifyResult && html`
      <div class="panel">
        <div class="panel-title">
          <span>Verifier Response</span>
          ${verifyResult.status === "verified"
            ? html`<span class="tag ok">Verified</span>`
            : html`<span class="tag danger">${verifyResult.status || "rejected"}</span>`}
        </div>
        ${verifyResult.status === "verified" && isFinite(Number(verifyResult.officialScore)) && html`
          <${Gauge} value=${Number(verifyResult.officialScore) <= 1 ? Number(verifyResult.officialScore) * 100 : Number(verifyResult.officialScore)} max=${100} label="official score" color="#5ec27a" />
        `}
        ${verifyResult.status === "verified" && html`
          <div class="kv">
            <div class="k">Tier</div><div class="v">${verifyResult.tier}</div>
            <div class="k">Official Score</div><div class="v">${verifyResult.officialScore}</div>
            <div class="k">Verification Hash</div><div class="v">${verifyResult.verificationHash}</div>
            <div class="k">Canonical Snapshot</div><div class="v">${verifyResult.officialSummary?.canonical_snapshot_id}</div>
            <div class="k">Verified at</div><div class="v">${verifyResult.officialSummary?.verified_at}</div>
          </div>
        `}
        ${verifyResult.status !== "verified" && html`
          <div class="alert danger"><span class="alert-icon">⊘</span><div>Reason: <b>${verifyResult.reason}</b></div></div>
        `}
        <pre>${j(verifyResult)}</pre>
      </div>
    `}
  `;
}

function ReplayDebugger({ runId, setRunId, replay, setReplay, replayError, setReplayError }) {
  const [step, setStep] = useState(1);
  const load = useCallback(async () => {
    setReplayError("");
    setReplay(null);
    const { ok, body } = await api(`/api/replay/${encodeURIComponent(runId)}/timeline`);
    if (!ok) {
      setReplayError(body?.error || "Replay fetch failed");
      return;
    }
    setReplay(body);
    setStep(1);
  }, [runId, setReplay, setReplayError]);

  const total = replay?.totalSteps || 0;
  const idx = Math.min(Math.max(step, 1), Math.max(total, 1));
  const current = total > 0 ? replay.steps[idx - 1] : null;

  return html`
    <div class="page-title">
      <div>
        <h2>Replay Debugger</h2>
        <div class="sub">Step-by-step run timeline for bot/backtest event audit.</div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">Load Timeline</div>
      <div class="row">
        <input style=${{ flex: 1 }} value=${runId} onChange=${(e) => setRunId(e.target.value)} placeholder="run id" />
        <button onClick=${load}>Load</button>
      </div>
      ${replayError && html`<div class="alert danger"><span class="alert-icon">✗</span><div>${replayError}</div></div>`}
    </div>
    ${replay && html`
      <div class="panel">
        <div class="panel-title">Timeline (${total} steps)</div>
        ${(() => {
          const steps = replay.steps || [];
          const series = steps.map((s) => Number(
            s.equity ?? s.mark ?? s.price ?? s.close ?? s.payload?.fill_price ?? s.payload_json?.fill_price ?? NaN
          ));
          const valid = series.filter(isFinite);
          if (valid.length < 2) return null;
          return html`<div style=${{ marginBottom: 12 }}>
            <${LineChart} series=${[{ name: "Timeline", color: "#7aa2f7", values: series }]} height=${170} />
            <div class="footer-note">Step marker: ${idx} / ${total}</div>
          </div>`;
        })()}
        <div class="field"><label>Step ${idx} / ${total}</label>
          <input type="range" min="1" max=${Math.max(total, 1)} value=${idx} onChange=${(e) => setStep(Number(e.target.value))} />
        </div>
        ${current ? html`<pre>${j(current)}</pre>` : html`<div class="footer-note">No steps.</div>`}
      </div>
    `}
  `;
}

// ---- Data Health Console ----
function DataHealthConsole({ health, refresh, coverageInput, setCoverageInput, gapsResult, runGapScan }) {
  const dbOk = health.api?.db === "up";
  const redisOk = health.api?.redis === "up";
  const dataAgeSec = health.data?.live_data_age_ms != null ? Math.round(health.data.live_data_age_ms / 1000) : null;
  const coverageRows = health.data?.recent_coverage || [];
  const [hcBars, setHcBars] = useState([]);
  const [hcMeta, setHcMeta] = useState(null);
  return html`
    <div class="page-title">
      <div>
        <h2>Data Health Console</h2>
        <div class="sub">Backfill coverage, gap scanner, retention status, throttle limits (§4, §14).</div>
      </div>
      <button class="ghost" onClick=${refresh}>Refresh</button>
    </div>

    <div class="tiles">
      <div class=${`tile ${dbOk ? "ok" : "danger"}`}><div class="tile-label">Timescale</div><div class="tile-value">${dbOk ? "Up" : "Down"}</div></div>
      <div class=${`tile ${redisOk ? "ok" : "danger"}`}><div class="tile-label">Redis</div><div class="tile-value">${redisOk ? "Up" : "Down"}</div></div>
      <div class=${`tile ${dataAgeSec == null || dataAgeSec > 30 ? "warn" : "ok"}`}><div class="tile-label">Live data age</div><div class="tile-value">${dataAgeSec == null ? "—" : `${dataAgeSec}s`}</div></div>
    </div>

    <div class="panel" style=${{ marginTop: 16 }}>
      <div class="panel-title">Coverage — Missing Bars by Feed</div>
      ${coverageRows.length
        ? html`<${BarChart} data=${coverageRows.map((r) => ({ label: `${r.symbol} ${r.interval}m`, value: Number(r.missing_bars) || 0, color: (Number(r.missing_bars) || 0) === 0 ? "#5ec27a" : "#e0af68" }))} height=${180} fmt=${(v) => String(Math.round(v))} />`
        : html`<div class="chart-empty">No coverage rows yet.</div>`}
    </div>

    <div class="panel">
      <div class="panel-title">
        <span>Inspect Stored Candles${hcMeta ? ` · ${hcMeta.regime?.regime_id} (${hcBars.length})` : ""}</span>
      </div>
      <${RegimeBarLoader} onLoad=${(bars, meta) => { setHcBars(bars); setHcMeta(meta); }} />
      ${hcBars.length
        ? html`<div style=${{ marginTop: 12 }}><${CandleChart} bars=${hcBars} height=${300} /></div>`
        : html`<div class="chart-empty" style=${{ marginTop: 12 }}>Load a regime to inspect its stored candles.</div>`}
    </div>

    <div class="panel" style=${{ marginTop: 16 }}>
      <div class="panel-title">Gap Scan</div>
      <div class="grid-3">
        <div class="field"><label>Symbol</label>
          <input value=${coverageInput.symbol} onChange=${(e) => setCoverageInput((s) => ({ ...s, symbol: e.target.value }))} /></div>
        <div class="field"><label>Interval (min)</label>
          <input value=${coverageInput.interval} onChange=${(e) => setCoverageInput((s) => ({ ...s, interval: e.target.value }))} /></div>
        <div class="field"><label>Category</label>
          <input value=${coverageInput.category} onChange=${(e) => setCoverageInput((s) => ({ ...s, category: e.target.value }))} /></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Start (ms)</label><input value=${coverageInput.startTs} onChange=${(e) => setCoverageInput((s) => ({ ...s, startTs: Number(e.target.value) }))} /></div>
        <div class="field"><label>End (ms)</label><input value=${coverageInput.endTs} onChange=${(e) => setCoverageInput((s) => ({ ...s, endTs: Number(e.target.value) }))} /></div>
      </div>
      <button onClick=${runGapScan}>Scan Gaps</button>
      ${gapsResult && html`<pre>${j(gapsResult)}</pre>`}
    </div>
  `;
}

// ---- Algo Bot Lab ----
function AlgoBotLab({ strategies, selectedAlgo, setSelectedAlgo, algoParams, setAlgoParams, algoBars, setAlgoBars, runAlgo, algoResult, algoError, algoRunning, algoSymbol, setAlgoSymbol, algoEquity, setAlgoEquity, algoRisk, setAlgoRisk, generateSampleBars }) {
  const perf = algoResult?.performance || null;
  const positions = algoResult?.positions || {};
  const fills = algoResult?.fills || [];
  const events = algoResult?.events || [];
  const killed = algoResult?.risk_state?.killed;
  const equityCurve = algoResult?.equity_curve?.map(Number).filter(isFinite) || [];
  const ddCurve = (perf?.drawdown_curve || []).map(Number).filter(isFinite);
  const algoCandles = useMemo(() => safeParse(algoBars) || [], [algoBars]);
  const closes = useMemo(() => algoCandles.map((b) => Number(b.close ?? b.c)).filter(isFinite), [algoCandles]);
  const emaFast = useMemo(() => ema(closes, 9), [closes]);
  const emaSlow = useMemo(() => ema(closes, 21), [closes]);

  return html`
    <div class="page-title">
      <div>
        <h2>Algo Bot Lab</h2>
        <div class="sub">Hummingbot-style strategy runtime — PMM, Avellaneda-Stoikov, funding fade, EMA trend, grid, TWAP.</div>
      </div>
    </div>

    <div class="alert info">
      <span class="alert-icon">ⓘ</span>
      <div>Real strategy executors with limit/market/stop/trailing orders, OCO, post-only, reduce-only, plus portfolio risk gates (max position, daily loss kill, drawdown kill). Output equivalent to Hummingbot paper mode — but determined by your supplied bars + funding rows, so it's reproducible.</div>
    </div>

    <div style=${{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 16 }}>
      <div>
        <div class="panel">
          <div class="panel-title">Strategy Selector</div>
          ${strategies.map((s) => html`
            <div key=${s.id} class=${`template-card ${selectedAlgo?.id === s.id ? "active" : ""}`} onClick=${() => setSelectedAlgo(s)}>
              <div class="t-name">${s.name}</div>
              <div class="t-desc">${s.description}</div>
            </div>
          `)}
        </div>

        <div class="panel">
          <div class="panel-title">Parameters</div>
          <textarea rows=${8} value=${algoParams} onChange=${(e) => setAlgoParams(e.target.value)} />
        </div>

        <div class="panel">
          <div class="panel-title">Portfolio</div>
          <div class="grid-2">
            <div class="field">
              <label>Symbol <${MarketHoursBadge} symbol=${algoSymbol} /></label>
              <input list="algo-symbols" value=${algoSymbol} onChange=${(e) => setAlgoSymbol(e.target.value)} />
              <${SymbolDatalist} id="algo-symbols" />
            </div>
            <div class="field"><label>Starting Equity (USDT)</label><input value=${algoEquity} onChange=${(e) => setAlgoEquity(e.target.value)} /></div>
          </div>
          <div class="grid-2">
            <div class="field"><label>Max Position Fraction</label><input value=${algoRisk.max_position_fraction} onChange=${(e) => setAlgoRisk((s) => ({ ...s, max_position_fraction: e.target.value }))} /></div>
            <div class="field"><label>Max Daily Loss Fraction</label><input value=${algoRisk.max_daily_loss_fraction} onChange=${(e) => setAlgoRisk((s) => ({ ...s, max_daily_loss_fraction: e.target.value }))} /></div>
            <div class="field"><label>Max Drawdown Kill</label><input value=${algoRisk.max_drawdown_kill_fraction} onChange=${(e) => setAlgoRisk((s) => ({ ...s, max_drawdown_kill_fraction: e.target.value }))} /></div>
            <div class="field"><label>Max Total Exposure Fraction</label><input value=${algoRisk.max_total_exposure_fraction} onChange=${(e) => setAlgoRisk((s) => ({ ...s, max_total_exposure_fraction: e.target.value }))} /></div>
          </div>
        </div>
      </div>

      <div>
        <div class="panel">
          <div class="panel-title">
            <span>Market Data</span>
            <button class="ghost" onClick=${generateSampleBars}>Generate 60 sample bars</button>
          </div>
          <${RegimeBarLoader} onLoad=${(bars) => setAlgoBars(j(bars))} />
          ${algoCandles.length ? html`<div style=${{ marginTop: 12 }}>
            <${CandleChart} bars=${algoCandles} fills=${fills} height=${300}
              overlays=${[{ name: "EMA9", color: "#e0af68", values: emaFast }, { name: "EMA21", color: "#7dcfff", values: emaSlow }]} />
          </div>` : null}
          <div class="field" style=${{ marginTop: 12 }}><label>Bars (JSON)</label>
            <textarea rows=${6} value=${algoBars} onChange=${(e) => setAlgoBars(e.target.value)} /></div>
          <div class="row" style=${{ marginTop: 10 }}>
            <button onClick=${runAlgo} disabled=${algoRunning}>${algoRunning ? "Running…" : "Run Strategy"}</button>
            <span class="footer-note">${selectedAlgo ? `Active: ${selectedAlgo.name}` : "Pick a strategy"}</span>
          </div>
          ${algoError && html`<div class="alert danger"><span class="alert-icon">✗</span><div>${algoError}</div></div>`}
        </div>

        ${algoResult && html`
          <div class="panel">
            <div class="panel-title">
              <span>Results</span>
              ${killed ? html`<span class="tag danger">KILLED · ${algoResult.risk_state.kill_reason}</span>` : html`<span class="tag ok">Completed</span>`}
            </div>
            <div class="tiles">
              <div class="tile"><div class="tile-label">Final Equity</div><div class="tile-value">${Number(algoResult.final_equity).toFixed(2)}</div></div>
              <div class="tile ${perf?.total_return > 0 ? 'ok' : (perf?.total_return < 0 ? 'danger' : '')}"><div class="tile-label">Total Return</div><div class="tile-value">${(Number(perf?.total_return || 0) * 100).toFixed(3)}%</div></div>
              <div class="tile"><div class="tile-label">Sharpe (√N)</div><div class="tile-value">${Number(perf?.sharpe || 0).toFixed(2)}</div></div>
              <div class="tile warn"><div class="tile-label">Max Drawdown</div><div class="tile-value">${(Number(perf?.max_drawdown || 0) * 100).toFixed(2)}%</div></div>
              <div class="tile"><div class="tile-label">Fills</div><div class="tile-value">${fills.length}</div></div>
              <div class="tile"><div class="tile-label">Win Rate</div><div class="tile-value">${(Number(perf?.win_rate || 0) * 100).toFixed(1)}%</div></div>
              <div class="tile"><div class="tile-label">Profit Factor</div><div class="tile-value">${Number(perf?.profit_factor || 0).toFixed(2)}</div></div>
              <div class="tile"><div class="tile-label">Trades</div><div class="tile-value">${perf?.n_trades ?? 0}</div></div>
            </div>

            <div style=${{ marginTop: 14 }}>
              <div class="panel-title">Price + Executions</div>
              <${CandleChart} bars=${algoCandles} fills=${fills} height=${300}
                overlays=${[{ name: "EMA9", color: "#e0af68", values: emaFast }, { name: "EMA21", color: "#7dcfff", values: emaSlow }]} />
            </div>
            <div style=${{ marginTop: 14 }}>
              <div class="panel-title">Equity Curve</div>
              <${LineChart} series=${[{ name: "Equity", color: "#7aa2f7", fill: "rgba(122,162,247,0.12)", values: equityCurve }]} height=${150} />
            </div>
            <div style=${{ marginTop: 8 }}>
              <div class="panel-title">Drawdown Curve</div>
              <${LineChart} series=${[{ name: "Drawdown", color: "#f7768e", fill: "rgba(247,118,142,0.12)", values: ddCurve }]} height=${140} />
            </div>

            <div style=${{ marginTop: 14 }}>
              <div class="panel-title">Positions</div>
              ${Object.keys(positions).length === 0
                ? html`<div class="footer-note">No positions.</div>`
                : html`<table>
                    <thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg Entry</th><th>Realized PnL</th><th>Funding PnL</th></tr></thead>
                    <tbody>
                      ${Object.entries(positions).map(([sym, p]) => html`
                        <tr key=${sym}>
                          <td>${sym}</td>
                          <td><span class=${`tag ${p.side === 'long' ? 'ok' : (p.side === 'short' ? 'danger' : 'muted')}`}>${p.side}</span></td>
                          <td class="num">${Number(p.qty).toFixed(4)}</td>
                          <td class="num">${Number(p.avg_entry).toFixed(2)}</td>
                          <td class="num">${Number(p.realized_pnl).toFixed(4)}</td>
                          <td class="num">${Number(p.funding_pnl).toFixed(4)}</td>
                        </tr>
                      `)}
                    </tbody>
                  </table>`}
            </div>

            <div style=${{ marginTop: 14 }}>
              <div class="panel-title">Fills (latest 30)</div>
              ${fills.length === 0 ? html`<div class="footer-note">No fills yet.</div>` : html`
                <table>
                  <thead><tr><th>Time</th><th>Side</th><th>Qty</th><th>Price</th><th>Fee</th><th>Maker?</th></tr></thead>
                  <tbody>
                    ${fills.slice(-30).map((f, i) => html`
                      <tr key=${i}>
                        <td class="num">${f.ts.slice(11, 19)}</td>
                        <td><span class=${`tag ${f.side === 'buy' ? 'ok' : 'danger'}`}>${f.side}</span></td>
                        <td class="num">${Number(f.qty).toFixed(4)}</td>
                        <td class="num">${Number(f.price).toFixed(2)}</td>
                        <td class="num">${Number(f.fee).toFixed(4)}</td>
                        <td>${f.is_maker ? "maker" : "taker"}</td>
                      </tr>
                    `)}
                  </tbody>
                </table>`}
            </div>

            <div style=${{ marginTop: 14 }}>
              <div class="panel-title">Event Log (latest 50)</div>
              <pre>${j(events.slice(-50))}</pre>
            </div>

            <div style=${{ marginTop: 14 }}>
              <div class="panel-title">Full Performance Report</div>
              <div class="kv">
                <div class="k">Sortino</div><div class="v">${Number(perf?.sortino || 0).toFixed(3)}</div>
                <div class="k">Calmar</div><div class="v">${Number(perf?.calmar || 0).toFixed(3)}</div>
                <div class="k">Volatility (ann.)</div><div class="v">${(Number(perf?.volatility_annualized || 0) * 100).toFixed(2)}%</div>
                <div class="k">Avg Win</div><div class="v">${Number(perf?.avg_win || 0).toFixed(4)}</div>
                <div class="k">Avg Loss</div><div class="v">${Number(perf?.avg_loss || 0).toFixed(4)}</div>
                <div class="k">Expectancy</div><div class="v">${Number(perf?.expectancy || 0).toFixed(4)}</div>
                <div class="k">Max consec wins</div><div class="v">${perf?.max_consecutive_wins ?? 0}</div>
                <div class="k">Max consec losses</div><div class="v">${perf?.max_consecutive_losses ?? 0}</div>
                <div class="k">DD duration (bars)</div><div class="v">${perf?.max_drawdown_duration_bars ?? 0}</div>
              </div>
            </div>
          </div>
        `}
      </div>
    </div>
  `;
}

// ---- Bot Template Studio ----
function BotTemplateStudio({ botTemplates, selectedBot, setSelectedBot, botParams, setBotParams, botBars, setBotBars, botRunResult, botRunError, runBot, requestedTier, setRequestedTier, l2Available, setL2Available }) {
  const meta = selectedBot;
  const fills = botRunResult?.fills || [];
  const events = botRunResult?.events || [];
  const perf = botRunResult?.performance;
  const botCandles = useMemo(() => safeParse(botBars) || [], [botBars]);
  const botEquity = (botRunResult?.equity_curve || []).map(Number).filter(isFinite);
  return html`
    <div class="page-title">
      <div>
        <h2>Bot Template Studio</h2>
        <div class="sub">14 v4.1 bot products — Spot/Futures Grid, DCA, Martingale, Combo, Funding Arb, TWAP/VP/Chase/Iceberg/Scaled, Snowball.</div>
      </div>
    </div>
    <div class="alert info"><span class="alert-icon">ⓘ</span><div>Bots compile to a deterministic <code>BotSpec</code> → engine orders. Unified ledger. No parallel accounting. Verifier pins <b>{engine, compiler, data}</b>.</div></div>
    <div style=${{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>
      <div>
        <div class="panel">
          <div class="panel-title">Template Library (14)</div>
          ${botTemplates.map((t) => html`
            <div key=${t.template_id} class=${`template-card ${selectedBot?.template_id === t.template_id ? "active" : ""}`} onClick=${() => { setSelectedBot(t); setBotParams(j(t.default_params)); }}>
              <div class="t-name">${t.display_name}</div>
              <div class="t-desc">${t.description}</div>
              <span class=${`tag ${{LOW:"ok",MODERATE:"info",HIGH:"warn",VERY_HIGH:"danger",EXTREME:"danger"}[t.risk_class] || "muted"}`}>${t.risk_class}</span>
              <span class=${`tag ${{HISTORICAL_FACTOR_OK:"ok",APPROXIMATE_FILLS:"warn",PAPER_ONLY_LIVE:"warn",RECORDED_L2_REQUIRED:"danger",SUBJECT_TO_RETENTION:"warn"}[t.eligibility_hint] || "muted"}`} style=${{ marginLeft: 6 }}>${t.eligibility_hint}</span>
            </div>
          `)}
        </div>
        <div class="panel">
          <div class="panel-title">Parameters</div>
          <textarea rows=${10} value=${botParams} onChange=${(e) => setBotParams(e.target.value)} />
        </div>
        <div class="panel">
          <div class="panel-title">Run Configuration</div>
          <div class="field"><label>Requested Tier</label>
            <select value=${requestedTier} onChange=${(e) => setRequestedTier(e.target.value)}>
              <option value="LOCAL ONLY">LOCAL ONLY</option>
              <option value="UNVERIFIED PAPER">UNVERIFIED PAPER</option>
              <option value="BACKTEST_VERIFIED">BACKTEST_VERIFIED (requires L2 for execution bots)</option>
            </select>
          </div>
          <div class="field">
            <label><input type="checkbox" style=${{ width: 16, marginRight: 6 }} checked=${l2Available} onChange=${(e) => setL2Available(e.target.checked)} />L1/L2 data available (coverage)</label>
          </div>
        </div>
      </div>
      <div>
        <div class="panel">
          <div class="panel-title">Market Data</div>
          <${RegimeBarLoader} onLoad=${(bars) => setBotBars(j(bars))} />
          ${botCandles.length ? html`<div style=${{ marginTop: 12 }}><${CandleChart} bars=${botCandles} fills=${fills} height=${300} /></div>` : null}
          <div class="field" style=${{ marginTop: 12 }}><label>Bars (JSON)</label>
            <textarea rows=${6} value=${botBars} onChange=${(e) => setBotBars(e.target.value)} /></div>
          <button onClick=${runBot} style=${{ marginTop: 4 }}>Run Bot Backtest</button>
          ${botRunError && html`<div class="alert danger"><span class="alert-icon">✗</span><div>${botRunError}</div></div>`}
        </div>
        ${botRunResult && html`
          <div class="panel">
            <div class="panel-title">
              <span>Result</span>
              ${botRunResult.status === "completed"
                ? html`<span class="tag ok">${botRunResult.status}</span>`
                : html`<span class="tag danger">${botRunResult.status}</span>`}
            </div>
            <div class="kv">
              <div class="k">spec_hash</div><div class="v">${botRunResult.spec_hash?.slice(0,16)}…</div>
              <div class="k">compiler_version</div><div class="v">${botRunResult.compiler_version}</div>
              <div class="k">engine_version</div><div class="v">${botRunResult.engine_version}</div>
              <div class="k">data_version</div><div class="v">${botRunResult.data_version}</div>
              <div class="k">final_equity</div><div class="v">${botRunResult.final_equity}</div>
              <div class="k">eligibility</div><div class="v">${(botRunResult.validation?.eligibility_labels||[]).join(", ")}</div>
              <div class="k">risk_class</div><div class="v">${botRunResult.validation?.risk_class}</div>
            </div>
            ${botRunResult.status === "rejected" && html`<div class="alert danger"><span class="alert-icon">⊘</span><div>Rejected by validator: ${(botRunResult.validation?.errors||[]).join(", ")}</div></div>`}
            ${perf && html`
              <div class="tiles" style=${{ marginTop: 12 }}>
                <div class="tile"><div class="tile-label">Total Return</div><div class="tile-value">${((perf.total_return||0)*100).toFixed(2)}%</div></div>
                <div class="tile"><div class="tile-label">Sharpe</div><div class="tile-value">${(perf.sharpe||0).toFixed(2)}</div></div>
                <div class="tile warn"><div class="tile-label">Max DD</div><div class="tile-value">${((perf.max_drawdown||0)*100).toFixed(2)}%</div></div>
                <div class="tile"><div class="tile-label">Fills</div><div class="tile-value">${fills.length}</div></div>
              </div>
            `}
            ${botEquity.length ? html`<div style=${{ marginTop: 12 }}>
              <div class="panel-title">Equity Curve</div>
              <${LineChart} series=${[{ name: "Equity", color: "#7aa2f7", fill: "rgba(122,162,247,0.12)", values: botEquity }]} height=${150} />
            </div>` : null}
            <div style=${{ marginTop: 12 }}>
              <div class="panel-title">Recent Events</div>
              <pre>${j(events.slice(-30))}</pre>
            </div>
          </div>
        `}
      </div>
    </div>
  `;
}

// ---- Strategy Recommender ----
function StrategyRecommenderScreen({ recBars, setRecBars, recFunding, setRecFunding, recRiskTolerance, setRecRiskTolerance, recResult, runRecommend, recError, createFromRec }) {
  return html`
    <div class="page-title">
      <div>
        <h2>Strategy Recommender</h2>
        <div class="sub">Regime → bot match → seeded params. Vector screening never promotes; every pick is event-rescored on a real run.</div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">Scan Inputs</div>
      <div class="grid-2">
        <div class="field"><label>Funding Rate Last (e.g. 0.0015)</label><input value=${recFunding} onChange=${(e) => setRecFunding(e.target.value)} /></div>
        <div class="field"><label>Risk Tolerance</label>
          <select value=${recRiskTolerance} onChange=${(e) => setRecRiskTolerance(e.target.value)}>
            <option>low</option><option>moderate</option><option>high</option>
          </select>
        </div>
      </div>
      <${RegimeBarLoader} onLoad=${(bars) => setRecBars(j(bars))} />
      ${(safeParse(recBars) || []).length ? html`<div style=${{ margin: "12px 0" }}><${CandleChart} bars=${safeParse(recBars)} height=${260} /></div>` : null}
      <div class="field"><label>Bars JSON</label><textarea rows=${6} value=${recBars} onChange=${(e) => setRecBars(e.target.value)} /></div>
      <button onClick=${runRecommend}>Scan + Recommend</button>
      ${recError && html`<div class="alert danger"><span class="alert-icon">✗</span><div>${recError}</div></div>`}
    </div>
    ${recResult && html`
      <div class="panel">
        <div class="panel-title">Recommendations (${recResult.recommendations?.length || 0})</div>
        ${(recResult.recommendations || []).map((r, i) => html`
          <div key=${i} class="template-card" style=${{ cursor: "default" }}>
            <div style=${{ display: "flex", gap: 8, alignItems: "center" }}>
              <span class="tag ok">${r.bot_type}</span>
              <span class="tag info">${r.regime_label}</span>
              <span class="tag muted">confidence ${(r.confidence * 100).toFixed(0)}%</span>
              <span class="spacer"></span>
              <button class="secondary" onClick=${() => createFromRec(r)}>Create Spec</button>
            </div>
            <div class="t-desc" style=${{ marginTop: 6 }}>${r.reason?.regime} · trend=${r.reason?.trend?.toFixed?.(4)} · vol=${r.reason?.vol?.toFixed?.(4)}</div>
            <pre style=${{ marginTop: 6 }}>${j(r.params)}</pre>
          </div>
        `)}
      </div>
    `}
  `;
}

// ---- Risk Cockpit ----
function RiskCockpitScreen({ cockpitBotType, setCockpitBotType, cockpitParams, setCockpitParams, cockpitL2, setCockpitL2, cockpitResult, runCockpit, cockpitError, botTemplates }) {
  return html`
    <div class="page-title">
      <div>
        <h2>Risk Cockpit</h2>
        <div class="sub">Per-bot risk decomposition. Hard-blocks unsafe configs (futures w/ leverage but no MM tiers, martingale w/o stop, verified execution without L2…).</div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">Spec Inputs</div>
      <div class="field"><label>Bot Type</label>
        <select value=${cockpitBotType} onChange=${(e) => { setCockpitBotType(e.target.value); const t = botTemplates.find(t => t.bot_type === e.target.value); if (t) setCockpitParams(j(t.default_params)); }}>
          ${botTemplates.map((t) => html`<option key=${t.bot_type} value=${t.bot_type}>${t.display_name}</option>`)}
        </select>
      </div>
      <div class="field"><label>Params</label><textarea rows=${8} value=${cockpitParams} onChange=${(e) => setCockpitParams(e.target.value)} /></div>
      <div class="field"><label><input type="checkbox" style=${{ width: 16, marginRight: 6 }} checked=${cockpitL2} onChange=${(e) => setCockpitL2(e.target.checked)} />L1/L2 coverage available</label></div>
      <button onClick=${runCockpit}>Run Cockpit</button>
      ${cockpitError && html`<div class="alert danger"><span class="alert-icon">✗</span><div>${cockpitError}</div></div>`}
    </div>
    ${cockpitResult && html`
      <div class="panel">
        <div class="panel-title">
          <span>Composite Score</span>
          <span class=${`tag ${{LOW:"ok",MODERATE:"info",HIGH:"warn",VERY_HIGH:"danger",EXTREME:"danger"}[cockpitResult.risk_class]}`}>${cockpitResult.risk_class} · ${cockpitResult.risk_score}</span>
        </div>
        ${cockpitResult.hard_blocks?.length > 0
          ? html`<div class="alert danger"><span class="alert-icon">⊘</span><div><b>Hard blocks:</b> ${cockpitResult.hard_blocks.join(", ")}</div></div>`
          : html`<div class="alert ok"><span class="alert-icon">✓</span><div>No hard blocks.</div></div>`}
        <${Gauge} value=${cockpitResult.risk_score} max=${100} label=${`risk · ${cockpitResult.risk_class}`} />
        ${(() => {
          const mods = cockpitResult.modules || {};
          const bars = Object.entries(mods)
            .map(([k, v]) => ({ label: k, value: Number(v?.score ?? v?.contribution ?? (typeof v === "number" ? v : NaN)) }))
            .filter((d) => isFinite(d.value));
          return bars.length ? html`<div style=${{ marginTop: 12 }}>
            <div class="panel-title">Module Contributions</div>
            <${BarChart} data=${bars} height=${190} color="#e0af68" fmt=${(v) => v.toFixed(1)} />
          </div>` : null;
        })()}
        <div class="panel-title" style=${{ marginTop: 12 }}>Modules</div>
        <pre>${j(cockpitResult.modules)}</pre>
      </div>
    `}
  `;
}

// ---- Bot Marketplace ----
function MarketplaceScreen({ marketplaceRows, refreshMarketplace, mpTier, setMpTier, forkCard }) {
  return html`
    <div class="page-title">
      <div>
        <h2>Bot Marketplace</h2>
        <div class="sub">Published bot cards. Local-only never ranked; every card carries {data, engine, compiler} version + result tier.</div>
      </div>
      <button class="ghost" onClick=${refreshMarketplace}>Refresh</button>
    </div>
    <div class="toolbar">
      ${["BACKTEST VERIFIED", "LIVE PAPER VERIFIED"].map((t) => html`
        <button key=${t} class=${`secondary ${mpTier === t ? "" : "ghost"}`} onClick=${() => setMpTier(t)}>${t}</button>
      `)}
    </div>
    ${marketplaceRows && marketplaceRows.length > 0 && marketplaceRows.some((c) => isFinite(Number(c.rank_score)))
      ? html`<div class="panel">
          <div class="panel-title">Card Rank Scores</div>
          <${BarChart} data=${marketplaceRows.slice(0, 20).map((c) => ({ label: c.title || c.bot_type, value: Number(c.rank_score) || 0 }))} height=${180} fmt=${(v) => v.toFixed(3)} />
        </div>` : null}

    <div class="panel">
      ${(!marketplaceRows || marketplaceRows.length === 0)
        ? html`<div class="footer-note">No published cards for tier <b>${mpTier}</b>.</div>`
        : html`<table>
            <thead><tr><th>Title</th><th>Bot Type</th><th>Symbols</th><th>Tier</th><th>Versions</th><th></th></tr></thead>
            <tbody>
              ${marketplaceRows.map((c) => html`
                <tr key=${c.card_id}>
                  <td>${c.title}</td>
                  <td><span class="tag info">${c.bot_type}</span></td>
                  <td class="num">${(c.symbol_set || []).join(", ")}</td>
                  <td><span class="tag ok">${c.result_tier}</span></td>
                  <td class="num" style=${{ fontSize: 11 }}>${c.engine_version}<br/>${c.compiler_version}<br/>${c.data_version}</td>
                  <td><button class="secondary" onClick=${() => forkCard(c.card_id)}>Fork</button></td>
                </tr>
              `)}
            </tbody>
          </table>`}
    </div>
  `;
}

// ---- Shared symbol universe (crypto + xStocks) ----
let _xstockCache = null;
function useXstocks() {
  const [state, setState] = useState(_xstockCache || { symbols: [], set: new Set() });
  useEffect(() => {
    if (_xstockCache) { setState(_xstockCache); return; }
    api("/api/xstocks/catalog").then(({ ok, body }) => {
      if (ok && body?.xstocks) {
        const symbols = body.xstocks.map((x) => x.symbol);
        _xstockCache = { symbols, set: new Set(symbols) };
        setState(_xstockCache);
      }
    }).catch(() => {});
  }, []);
  return state;
}
function isXstockSym(set, symbol) { return !!(symbol && set.has(String(symbol).toUpperCase())); }

const CRYPTO_MAJORS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
function SymbolDatalist({ id }) {
  const { symbols } = useXstocks();
  return html`<datalist id=${id}>${[...CRYPTO_MAJORS, ...symbols].map((s) => html`<option key=${s} value=${s}></option>`)}</datalist>`;
}

// Live US-equity session pill — renders only for xStock symbols.
function MarketHoursBadge({ symbol }) {
  const { set } = useXstocks();
  const [sess, setSess] = useState(null);
  const isXs = isXstockSym(set, symbol);
  useEffect(() => {
    if (!isXs) { setSess(null); return; }
    let live = true;
    const tick = () => api("/api/xstocks/session").then(({ ok, body }) => { if (live && ok) setSess(body); }).catch(() => {});
    tick();
    const iv = setInterval(tick, 15000);
    return () => { live = false; clearInterval(iv); };
  }, [isXs]);
  if (!isXs) return null;
  const cls = sess ? (sess.is_rth ? "ok" : "warn") : "muted";
  const txt = sess ? (sess.is_rth ? "xStock · US RTH open" : "xStock · off-hours") : "xStock";
  return html`<span class=${`tag ${cls}`} style=${{ marginLeft: 8 }}>${txt}</span>`;
}

// ---- xStocks / Cross-Asset Lab ----
function XStocksLab() {
  const [catalog, setCatalog] = useState(null);
  const [session, setSession] = useState(null);
  const [bars, setBars] = useState([]);
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api("/api/xstocks/catalog").then(({ ok, body }) => {
      if (ok) setCatalog(body); else setErr(body?.error || "catalog unavailable");
    }).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    const tick = () => api("/api/xstocks/session").then(({ ok, body }) => { if (ok) setSession(body); }).catch(() => {});
    tick();
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, []);

  const rows = catalog?.xstocks || [];
  const c = catalog?.constraints || {};
  return html`
    <div class="page-title">
      <div>
        <h2>xStocks / Cross-Asset Lab</h2>
        <div class="sub">Tokenized US equities (Backed Finance) on Bybit Spot — combine with crypto in one USDT book, 24/7. Spot-only · long-only · no leverage.</div>
      </div>
      ${session ? html`<span class=${`status-pill ${session.is_rth ? "" : "warn"}`}>
        <span class="pulse"></span>${session.is_rth ? "US Market OPEN (RTH)" : "US Market CLOSED (off-hours)"}
      </span>` : null}
    </div>

    <div class="alert info">
      <span class="alert-icon">ⓘ</span>
      <div>Each xStock is 1:1 backed by a real share; price ≈ token_price ÷ <code>xstockMultiplier</code>. Trades 24/7 but the underlying only has Regular Trading Hours — off-hours acts as a thin prediction market (wider effective spread). Position cap ${catalog ? catalog.position_cap_usdt : "300000"} USDT/token; LIVE deployment region-gated (${(catalog?.restricted_regions || ["EEA", "AU", "JP"]).join(", ")}).</div>
    </div>

    ${err ? html`<div class="alert danger"><span class="alert-icon">✗</span><div>${err}</div></div>` : null}

    <div class="tiles">
      <div class="tile"><div class="tile-label">Instruments</div><div class="tile-value">${rows.length}</div><div class="tile-sub">tokenized equities + ETFs</div></div>
      <div class="tile ${session?.is_rth ? "ok" : "warn"}"><div class="tile-label">Session Phase</div><div class="tile-value">${session ? (session.is_rth ? "RTH" : "Off-hours") : "—"}</div><div class="tile-sub">off-hours spread ×${session?.off_hours_spread_multiplier ?? "—"}</div></div>
      <div class="tile"><div class="tile-label">Quote / Settle</div><div class="tile-value">${catalog?.quote || "USDT"}</div><div class="tile-sub">${catalog?.settlement_network || "Solana"} network</div></div>
      <div class="tile"><div class="tile-label">Constraints</div><div class="tile-value">Spot</div><div class="tile-sub">${c.short_selling === false ? "no short" : ""} · ${c.leverage === false ? "no leverage" : ""} · ${c.funding === false ? "no funding" : ""}</div></div>
    </div>

    <div class="panel" style=${{ marginTop: 16 }}>
      <div class="panel-title">Inspect Tokenized-Equity Candles</div>
      <${RegimeBarLoader} onLoad=${(b, m) => { setBars(b); setMeta(m); }} />
      ${bars.length
        ? html`<div style=${{ marginTop: 12 }}><${CandleChart} bars=${bars} height=${320} /></div>`
        : html`<div class="chart-empty" style=${{ marginTop: 12 }}>Load an xStock regime (e.g. NVDAx / AAPLx / SPYx) to chart real candles. Load it first in Data Health if empty.</div>`}
      ${meta ? html`<div class="footer-note">${meta.regime?.label || meta.regime?.regime_id} · ${bars.length} candles</div>` : null}
    </div>

    <div class="panel">
      <div class="panel-title">xStocks Instrument Catalog</div>
      ${rows.length === 0
        ? html`<div class="chart-empty">Catalog loading… (worker must be up).</div>`
        : html`<table>
            <thead><tr><th>Symbol</th><th>Underlying</th><th>Name</th><th>Sector</th><th>Class</th><th>Multiplier</th><th>Bot-enabled</th></tr></thead>
            <tbody>
              ${rows.map((x) => html`<tr key=${x.symbol}>
                <td class="num">${x.symbol}</td>
                <td>${x.underlying}</td>
                <td>${x.name}</td>
                <td>${x.sector}</td>
                <td><span class=${`tag ${x.kind === "etf" ? "info" : "muted"}`}>${x.asset_class}${x.kind === "etf" ? " · ETF" : ""}</span></td>
                <td class="num">${x.xstock_multiplier}</td>
                <td>${x.bot_enabled ? html`<span class="tag ok">grid</span>` : html`<span class="tag muted">spot</span>`}</td>
              </tr>`)}
            </tbody>
          </table>`}
      <div class="footer-note">Build a multi-asset strategy in <b>Bot Template Studio → Cross-Asset Allocator</b> (static / momentum / regime-switch). Equity legs are auto-constrained to long-only, unleveraged, RTH-aware.</div>
    </div>
  `;
}

// ---- Live Feed tape (realtime prices via demand-driven poller) ----
function LiveTape({ symbols }) {
  const [prices, setPrices] = useState([]);
  const [status, setStatus] = useState(null);
  const [subbed, setSubbed] = useState(false);
  useEffect(() => {
    // Subscribe the needed symbols (only what's in use) — POST.
    const items = (symbols || []).map((s) => ({ symbol: s.symbol, category: s.category, interval: "1" }));
    api("/api/live/subscribe", { method: "POST", body: JSON.stringify({ items }) })
      .then(() => setSubbed(true)).catch(() => {});
  }, []);
  useEffect(() => {
    let live = true;
    const tick = () => api("/api/live/prices").then(({ ok, body }) => {
      if (live && ok) { setPrices(body.prices || []); setStatus(body.status || null); }
    }).catch(() => {});
    tick();
    const iv = setInterval(tick, 12000);
    return () => { live = false; clearInterval(iv); };
  }, []);
  const fresh = prices.filter((p) => p.fresh).length;
  return html`
    <div class="panel">
      <div class="panel-title">
        <span>Realtime Feed (Bybit public, 1-min poll)</span>
        <span class=${`tag ${fresh > 0 ? "ok" : "warn"}`}>${fresh}/${prices.length} fresh${status ? ` · every ${status.poll_seconds}s` : ""}</span>
      </div>
      ${prices.length === 0
        ? html`<div class="chart-empty">No live subscriptions yet — start the desk to subscribe symbols.</div>`
        : html`<div class="live-tape">
            ${prices.map((p) => html`<div key=${p.symbol} class=${`live-chip ${p.fresh ? "fresh" : "stale"}`}>
              <div class="lc-sym">${p.symbol} <span class=${`tag ${p.category === "spot" ? "info" : "muted"}`}>${p.category}</span></div>
              <div class="lc-px">$${Number(p.last_close).toLocaleString("en-US", { maximumFractionDigits: 2 })}</div>
              <div class="lc-age">${Math.round(p.age_ms / 1000)}s ago ${p.fresh ? "● live" : "○ stale"}</div>
            </div>`)}
          </div>`}
      <div class="footer-note">Demand-driven: only symbols with active strategies are polled (≈ ${prices.length} req/min, far under Bybit's 600/5s limit). Covers crypto (linear) + xStocks (spot).</div>
    </div>
  `;
}

// ---- Live Paper (persistent server-side forward sessions) ----
function LivePaperScreen() {
  const [sessions, setSessions] = useState([]);
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState({ strategyId: "pmm", symbol: "BTCUSDT" });
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let live = true;
    const tick = () => api("/api/live-paper/sessions").then(({ ok, body }) => {
      if (live && ok) { setSessions(body.sessions || []); setStatus(body.status || null); }
    }).catch(() => {});
    tick();
    const iv = setInterval(tick, 8000);
    return () => { live = false; clearInterval(iv); };
  }, []);
  const presets = {
    pmm: { bid_spread_bps: "8", ask_spread_bps: "8", order_qty: "0.002", max_inventory_qty: "0.01" },
    trend_ema_cross: { ema_fast: 5, ema_slow: 20, order_qty: "0.01" },
    avellaneda_stoikov: { gamma_mode: "manual", gamma: "0.3", target_spread_bps: "12", k: "1.5", order_qty: "0.002" },
    grid: { spacing_bps: "30", num_levels: 5, qty_per_level: "0.001" },
  };
  async function start() {
    setMsg("");
    const isXs = /XUSDT$/.test(form.symbol);
    const { ok, body } = await api("/api/live-paper/start", { method: "POST", body: JSON.stringify({
      strategyId: form.strategyId, symbol: form.symbol, category: isXs ? "spot" : "linear",
      params: presets[form.strategyId] || {}, startingEquity: "10000",
    }) });
    setMsg(ok && !body.error ? `Started ${body.session_id}` : `Error: ${JSON.stringify(body)}`);
  }
  async function stop(id) { await api(`/api/live-paper/stop/${encodeURIComponent(id)}`, { method: "POST" }); }
  const running = sessions.filter((s) => s.status === "running");
  const fmtTick = (t) => t ? new Date(t).toLocaleTimeString() : "—";
  return html`
    <div class="page-title">
      <div>
        <h2>Live Paper — Forward Sessions</h2>
        <div class="sub">Persistent server-side paper trading. Each session advances on real incoming 1-min Bybit bars (no client driver) until stopped.</div>
      </div>
      <span class=${`status-pill ${status?.last_cycle_ts ? "" : "warn"}`}><span class="pulse"></span>
        server loop · every ${status?.tick_seconds ?? "?"}s · ${status?.last_cycle_count ?? 0} ticking</span>
    </div>

    <div class="panel">
      <div class="panel-title">Launch a forward session</div>
      <div class="row">
        <div class="field"><label>Strategy</label>
          <select value=${form.strategyId} onChange=${(e) => setForm((f) => ({ ...f, strategyId: e.target.value }))}>
            ${["pmm", "trend_ema_cross", "avellaneda_stoikov", "grid"].map((s) => html`<option key=${s} value=${s}>${s}</option>`)}
          </select></div>
        <div class="field"><label>Symbol <${MarketHoursBadge} symbol=${form.symbol} /></label>
          <input list="lp-syms" value=${form.symbol} onChange=${(e) => setForm((f) => ({ ...f, symbol: e.target.value }))} />
          <${SymbolDatalist} id="lp-syms" /></div>
        <button onClick=${start}>▶ Start Forward Session</button>
      </div>
      ${msg ? html`<div class="footer-note">${msg}</div>` : null}
    </div>

    <div class="tiles">
      <div class="tile ok"><div class="tile-label">Running</div><div class="tile-value">${running.length}</div></div>
      <div class="tile"><div class="tile-label">Total Sessions</div><div class="tile-value">${sessions.length}</div></div>
      <div class="tile"><div class="tile-label">Aggregate Equity</div><div class="tile-value">$${running.reduce((a, s) => a + Number(s.final_equity || 0), 0).toFixed(0)}</div></div>
    </div>

    <div class="panel" style=${{ marginTop: 16 }}>
      <div class="panel-title">Live Sessions (auto-refresh 8s)</div>
      ${sessions.length === 0
        ? html`<div class="chart-empty">No sessions. Launch one above — it will trade forward on its own.</div>`
        : html`<table>
            <thead><tr><th>Strategy</th><th>Symbol</th><th>Status</th><th>Last bar</th><th>Last price</th><th>Live fills</th><th>Live P&L</th><th>Live Return</th><th>Warmup ctx</th><th>Last tick</th><th></th></tr></thead>
            <tbody>
              ${sessions.map((s) => {
                const ret = s.live_return ?? 0;
                const warm = s.warmup_return ?? 0;
                return html`<tr key=${s.session_id}>
                  <td>${s.strategy_id}</td>
                  <td class="num">${s.symbol}</td>
                  <td><span class=${`tag ${s.status === "running" ? "ok" : "muted"}`}>${s.status}</span></td>
                  <td class="num">${s.last_bar_ms ? new Date(s.last_bar_ms).toISOString().slice(11, 16) : "—"}</td>
                  <td class="num">${s.last_price ? Number(s.last_price).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"}</td>
                  <td class="num">${s.live_fills ?? 0}</td>
                  <td class="num" style=${{ color: (s.live_pnl || 0) > 0 ? "var(--ok)" : ((s.live_pnl || 0) < 0 ? "var(--danger)" : "var(--text-dim)") }}>${(s.live_pnl || 0) >= 0 ? "+" : ""}$${Number(s.live_pnl || 0).toFixed(2)}</td>
                  <td class="num" style=${{ color: ret > 0 ? "var(--ok)" : (ret < 0 ? "var(--danger)" : "var(--text-dim)") }}>${(ret * 100).toFixed(3)}%</td>
                  <td class="num footer-note" style=${{ margin: 0 }} title="backtest over warmup history — context only">${(warm * 100).toFixed(2)}%</td>
                  <td class="num">${fmtTick(s.last_tick_at)}</td>
                  <td>${s.status === "running" ? html`<button class="ghost" onClick=${() => stop(s.session_id)}>stop</button>` : ""}</td>
                </tr>`;
              })}
            </tbody>
          </table>`}
      <div class="footer-note">Forward fills/equity update as new real 1-min bars arrive. xStock equity legs are spot · long-only · RTH-aware.</div>
    </div>
  `;
}

// ---- Strategy Desk — $100 on every bot & tool, backtest + paper, auto-refresh ----
const DESK_ALGOS = [
  { id: "pmm", label: "Pure Market Maker", params: { bid_spread_bps: "15", ask_spread_bps: "15", order_qty: "0.0004", max_inventory_qty: "0.0008" } },
  { id: "avellaneda_stoikov", label: "Avellaneda-Stoikov MM", params: { gamma_mode: "manual", gamma: "0.3", target_spread_bps: "15", k: "1.5", order_qty: "0.0004" } },
  { id: "funding_fade", label: "Funding Fade", params: { order_qty: "0.0008" } },
  { id: "trend_ema_cross", label: "Trend EMA Cross", params: { ema_fast: 13, ema_slow: 34, order_qty: "0.001" } },
  { id: "grid", label: "Grid Trader (algo)", params: { spacing_bps: "60", num_levels: 5, qty_per_level: "0.0002" } },
  { id: "twap", label: "TWAP Executor (algo)", params: { total_qty: "0.001", slice_count: 10 } },
];
const DESK_MULTI_SYMBOL_BOTS = new Set(["futures_combo", "rebalancer", "cross_asset_allocator"]);

function deskScaleParams(p, lo, hi) {
  const q = { ...p };
  const set = (k, v) => { if (k in q) q[k] = v; };
  set("investment_quote", "100"); set("total_investment", "100"); set("max_total_investment", "100");
  set("investment_quote_per_order", "20"); set("base_order_margin", "20"); set("safety_order_margin", "20");
  set("dca_order_margin", "20"); set("initial_margin", "50");
  set("total_qty", "0.001"); set("target_qty", "0.001"); set("qty", "0.001"); set("visible_qty", "0.0003");
  set("lower_price", String(lo)); set("upper_price", String(hi));
  set("symbol", "BTCUSDT"); set("perp_symbol", "BTCUSDT"); set("spot_symbol", "BTCUSDT");
  return q;
}

function StrategyDesk() {
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [cycle, setCycle] = useState(0);
  const [lastRun, setLastRun] = useState(null);
  const [error, setError] = useState("");
  const runningRef = React.useRef(false);

  async function runOnce() {
    setError("");
    const btcR = await api("/api/candles?symbol=BTCUSDT&category=linear&interval=D&limit=200");
    const btc = btcR.body?.bars || [];
    if (!btc.length) { setError("No BTC candles ingested — load data in Data Health first."); return; }
    const [nvdaR, googlR, aaplR] = await Promise.all([
      api("/api/candles?symbol=NVDAXUSDT&category=spot&interval=D&limit=200"),
      api("/api/candles?symbol=GOOGLXUSDT&category=spot&interval=D&limit=200"),
      api("/api/candles?symbol=AAPLXUSDT&category=spot&interval=D&limit=200"),
    ]);
    const nvda = nvdaR.body?.bars || [], googl = googlR.body?.bars || [], aapl = aaplR.body?.bars || [];
    const lo = Math.round(Math.min(...btc.map((b) => +b.low))), hi = Math.round(Math.max(...btc.map((b) => +b.high)));
    const tplResp = await api("/api/bots/templates");
    const tpls = Object.fromEntries((tplResp.body?.templates || []).map((t) => [t.bot_type, t]));
    const out = [];
    const pushPerf = (label, kind, symbol, mode, final, p, fills, status) => {
      const ret = p && p.total_return != null ? p.total_return : (final != null ? final / 100 - 1 : 0);
      out.push({ label, kind, symbol, mode, final: final != null ? Number(final) : null,
        ret, sharpe: p?.sharpe ?? null, maxdd: p?.max_drawdown ?? null, fills: fills ?? 0, status });
    };

    // --- ALGOS (paper runtime, $100, BTC) ---
    for (const a of DESK_ALGOS) {
      try {
        const { body: d } = await api("/api/paper/runtime/run", { method: "POST", body: JSON.stringify({
          symbol: "BTCUSDT", strategy_id: a.id, strategy_params: a.params, starting_equity: "100",
          fee_bps_taker: "5.5", fee_bps_maker: "1.0", slippage_bps_one_way: "2.0", interval_minutes: 1440,
          risk: { max_position_fraction: "1.0", max_daily_loss_fraction: "0.9", max_drawdown_kill_fraction: "0.9" },
          bars: btc, funding_rows: [],
        }) });
        pushPerf(a.label, "algo", "BTCUSDT", "paper", d?.final_equity, d?.performance, (d?.fills || []).length,
          d?.error ? "error" : (d?.risk_state?.killed ? "killed" : "ok"));
      } catch (e) { pushPerf(a.label, "algo", "BTCUSDT", "paper", null, null, 0, "error"); }
    }

    // --- BOTS (backtest, $100, BTC) ---
    for (const bt of Object.keys(tpls)) {
      if (DESK_MULTI_SYMBOL_BOTS.has(bt)) { pushPerf(tpls[bt].display_name || bt, "bot", "multi", "backtest", null, null, 0, "→ Portfolio"); continue; }
      try {
        const params = deskScaleParams(tpls[bt].default_params || {}, lo, hi);
        const { body: sp } = await api("/api/bots/specs", { method: "POST", body: JSON.stringify({ botType: bt, name: "desk-" + bt, symbols: ["BTCUSDT"], params }) });
        if (!sp?.botSpecId) { pushPerf(tpls[bt].display_name || bt, "bot", "BTCUSDT", "backtest", null, null, 0, "spec-fail"); continue; }
        const { body: d } = await api("/api/bots/runs/backtest", { method: "POST", body: JSON.stringify({
          botSpecId: sp.botSpecId, symbol: "BTCUSDT", starting_equity: "100",
          risk: { max_position_fraction: "1.0", max_total_exposure_fraction: "5.0" },
          bars: btc, funding_rows: [], requested_tier: "LOCAL ONLY", coverage: { has_l2: true }, interval_minutes: 1440,
        }) });
        pushPerf(tpls[bt].display_name || bt, "bot", "BTCUSDT", "backtest", d?.final_equity, d?.performance, (d?.fills || []).length,
          d?.status === "completed" ? "ok" : (d?.status || "error"));
      } catch (e) { pushPerf(tpls[bt].display_name || bt, "bot", "BTCUSDT", "backtest", null, null, 0, "error"); }
    }

    // --- MULTI-ASSET PORTFOLIO ($100, real BTC+xStocks, risk-parity) ---
    if (nvda.length && googl.length && aapl.length) {
      const leg = (s, ac, cat, b) => ({ symbol: s, asset_class: ac, category: cat, target_weight: "0.25", leverage: "1", bars: b });
      try {
        const { body: d } = await api("/api/portfolio/run", { method: "POST", body: JSON.stringify({
          legs: [leg("BTCUSDT", "crypto", "linear", btc), leg("NVDAXUSDT", "equity", "spot", nvda), leg("GOOGLXUSDT", "equity", "spot", googl), leg("AAPLXUSDT", "equity", "spot", aapl)],
          weighting: "risk_parity", total_equity: "100", rebalance_threshold: "0.05", interval_minutes: 1440,
          risk: { max_position_fraction: "0.6", max_total_exposure_fraction: "3.0", max_daily_loss_fraction: "0.3", max_drawdown_kill_fraction: "0.3" },
        }) });
        pushPerf("Risk-Parity Multi-Asset (BTC+NVDAx+GOOGLx+AAPLx)", "portfolio", "4 legs", "paper", d?.final_equity, d?.metrics, (d?.fills || []).length, d?.error ? "error" : "ok");
      } catch (e) { pushPerf("Risk-Parity Multi-Asset", "portfolio", "4 legs", "paper", null, null, 0, "error"); }
    }

    setRows(out);
    setLastRun(new Date().toLocaleTimeString());
    setCycle((c) => c + 1);
  }

  useEffect(() => {
    runningRef.current = running;
    if (!running) return;
    let stopped = false;
    const loop = async () => {
      while (!stopped && runningRef.current) {
        await runOnce();
        for (let i = 0; i < 20 && !stopped && runningRef.current; i++) await new Promise((r) => setTimeout(r, 1000));
      }
    };
    loop();
    return () => { stopped = true; };
  }, [running]);

  const ok = rows.filter((r) => r.status === "ok");
  const profitable = ok.filter((r) => (r.ret || 0) > 0);
  const best = ok.slice().sort((a, b) => (b.ret || 0) - (a.ret || 0))[0];
  const aggFinal = ok.reduce((s, r) => s + (r.final || 0), 0);
  const deployed = ok.length * 100;

  return html`
    <div class="page-title">
      <div>
        <h2>Strategy Desk — $100 on Every Bot & Tool</h2>
        <div class="sub">Runs $100 through every algo strategy, every bot, and the multi-asset portfolio on real Bybit data — backtest + paper, side by side.</div>
      </div>
      ${running
        ? html`<button class="danger" onClick=${() => setRunning(false)}>■ Turn Off Desk</button>`
        : html`<button onClick=${() => setRunning(true)}>▶ Start Desk (run until turned off)</button>`}
    </div>

    <div class="alert ${running ? "ok" : "info"}">
      <span class="alert-icon">${running ? "●" : "ⓘ"}</span>
      <div>${running
        ? html`<b>Desk LIVE</b> — re-running every ~20s. Cycle #${cycle}${lastRun ? `, last ${lastRun}` : ""}. Click “Turn Off Desk” to stop.`
        : html`Each strategy gets a fresh <b>$100</b>. This <b>replays real historical Bybit data</b> deterministically (real fills/fees/slippage/risk) — it is paper/backtest, not forward-live (forward-live needs the realtime feed + execution adapter, not yet built).`}</div>
    </div>
    ${error ? html`<div class="alert danger"><span class="alert-icon">✗</span><div>${error}</div></div>` : null}

    <${LiveTape} symbols=${[{ symbol: "BTCUSDT", category: "linear" }, { symbol: "AAPLXUSDT", category: "spot" }, { symbol: "NVDAXUSDT", category: "spot" }, { symbol: "GOOGLXUSDT", category: "spot" }]} />

    ${rows.length ? html`<div class="tiles">
      <div class="tile"><div class="tile-label">Strategies Run</div><div class="tile-value">${ok.length}</div><div class="tile-sub">of ${rows.length} attempted</div></div>
      <div class="tile ok"><div class="tile-label">Profitable</div><div class="tile-value">${profitable.length}</div><div class="tile-sub">$100 → up</div></div>
      <div class="tile"><div class="tile-label">Best</div><div class="tile-value">${best ? (best.ret * 100).toFixed(1) + "%" : "—"}</div><div class="tile-sub">${best ? best.label.slice(0, 22) : ""}</div></div>
      <div class="tile ${aggFinal > deployed ? "ok" : "danger"}"><div class="tile-label">$${deployed} deployed →</div><div class="tile-value">$${aggFinal.toFixed(0)}</div><div class="tile-sub">across all desks</div></div>
    </div>` : null}

    <div class="panel" style=${{ marginTop: 16 }}>
      <div class="panel-title">Live Strategy Book</div>
      ${rows.length === 0
        ? html`<div class="chart-empty">${running ? "Running first cycle…" : "Press ▶ Start Desk to deploy $100 across every bot and tool."}</div>`
        : html`<table>
            <thead><tr><th>Strategy</th><th>Type</th><th>Symbol</th><th>Mode</th><th>$100 →</th><th>Return</th><th>Sharpe</th><th>Max DD</th><th>Fills</th><th>Status</th></tr></thead>
            <tbody>
              ${rows.slice().sort((a, b) => (b.ret || -9) - (a.ret || -9)).map((r, i) => html`<tr key=${i}>
                <td>${r.label}</td>
                <td><span class=${`tag ${r.kind === "algo" ? "info" : (r.kind === "portfolio" ? "ok" : "muted")}`}>${r.kind}</span></td>
                <td class="num">${r.symbol}</td>
                <td>${r.mode}</td>
                <td class="num">${r.final != null ? "$" + r.final.toFixed(2) : "—"}</td>
                <td class="num" style=${{ color: r.ret > 0 ? "var(--ok)" : (r.ret < 0 ? "var(--danger)" : "var(--text-dim)") }}>${r.final != null ? (r.ret * 100).toFixed(2) + "%" : "—"}</td>
                <td class="num">${r.sharpe != null ? r.sharpe.toFixed(2) : "—"}</td>
                <td class="num">${r.maxdd != null ? (r.maxdd * 100).toFixed(1) + "%" : "—"}</td>
                <td class="num">${r.fills}</td>
                <td><span class=${`tag ${r.status === "ok" ? "ok" : (r.status === "killed" ? "danger" : "warn")}`}>${r.status}</span></td>
              </tr>`)}
            </tbody>
          </table>`}
    </div>
  `;
}

// ---- Multi-Asset / Multi-Token Portfolio Lab ----
function genAlignedBars(seed, p0, n, drift) {
  const t0 = Date.UTC(2026, 5, 1, 14, 0, 0);
  const out = [];
  let p = p0;
  for (let i = 0; i < n; i++) {
    p = p * (1 + drift) + Math.sin((i + seed) / 6) * p * 0.005;
    const o = p, c = p * 1.001, hi = Math.max(o, c) * 1.003, lo = Math.min(o, c) * 0.997;
    out.push({ ts: t0 + i * 3600000, open: o.toFixed(2), high: hi.toFixed(2), low: lo.toFixed(2), close: c.toFixed(2), volume: "100" });
    p = c;
  }
  return out;
}
// Default = the validated risk-parity multi-asset basket (BTC + 3 tokenized equities).
const PORTFOLIO_DEFAULT_LEGS = [
  { symbol: "BTCUSDT", weight: "0.25", leverage: "1", p0: 95000, drift: -0.0005 },
  { symbol: "NVDAXUSDT", weight: "0.25", leverage: "1", p0: 185, drift: 0.001 },
  { symbol: "GOOGLXUSDT", weight: "0.25", leverage: "1", p0: 210, drift: 0.0015 },
  { symbol: "AAPLXUSDT", weight: "0.25", leverage: "1", p0: 260, drift: 0.0008 },
];

function MultiAssetPortfolioLab() {
  const { set } = useXstocks();
  const [legs, setLegs] = useState(PORTFOLIO_DEFAULT_LEGS.map((l) => ({ ...l })));
  const [weighting, setWeighting] = useState("risk_parity");
  const [totalEquity, setTotalEquity] = useState("100000");
  const [threshold, setThreshold] = useState("0.05");
  const [lookback, setLookback] = useState("20");
  const [topN, setTopN] = useState("3");
  const [nBars, setNBars] = useState(80);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [useReal, setUseReal] = useState(false);
  const [realBars, setRealBars] = useState(null);   // {symbol: bars[]} when loaded
  const [loadingReal, setLoadingReal] = useState(false);

  const assetClassOf = (sym) => (isXstockSym(set, sym) || /XUSDT$/.test(String(sym || "")) ? "equity" : "crypto");
  const synthBars = useMemo(() => legs.map((l, i) => genAlignedBars(i * 2 + 1, Number(l.p0) || 100, nBars, Number(l.drift) || 0)), [legs, nBars]);
  const barsByLeg = legs.map((l, i) => (useReal && realBars && realBars[l.symbol]) ? realBars[l.symbol] : synthBars[i]);

  async function loadRealData() {
    setLoadingReal(true); setError("");
    try {
      const out = {};
      for (const l of legs) {
        const cat = assetClassOf(l.symbol) === "equity" ? "spot" : "linear";
        const { ok, body } = await api(`/api/candles?symbol=${encodeURIComponent(l.symbol)}&category=${cat}&interval=D&limit=400`);
        if (ok && body?.bars?.length) out[l.symbol] = body.bars;
      }
      const loaded = Object.keys(out);
      if (!loaded.length) { setError("No real candles found — ingest data in Data Health first."); setLoadingReal(false); return; }
      setRealBars(out); setUseReal(true);
    } catch (e) { setError(e.message); }
    setLoadingReal(false);
  }

  // Default to REAL Bybit candles on mount — never show synthetic to the user.
  useEffect(() => { loadRealData(); }, []);

  const updateLeg = (i, patch) => setLegs((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const addLeg = () => setLegs((ls) => [...ls, { symbol: "SOLUSDT", weight: "0", leverage: "1", p0: 150, drift: 0.002 }]);
  const removeLeg = (i) => setLegs((ls) => ls.filter((_, k) => k !== i));

  async function run() {
    setError(""); setRunning(true); setResult(null);
    try {
      const payloadLegs = legs.map((l, i) => {
        const ac = assetClassOf(l.symbol);
        return {
          symbol: l.symbol, asset_class: ac, category: ac === "equity" ? "spot" : "linear",
          target_weight: String(l.weight || "0"), leverage: ac === "equity" ? "1" : String(l.leverage || "1"),
          allow_short: false, bars: barsByLeg[i],
        };
      });
      const body = {
        legs: payloadLegs, weighting, total_equity: String(totalEquity),
        rebalance_threshold: String(threshold), lookback_bars: Number(lookback), top_n: Number(topN),
        interval_minutes: 60,
        risk: { max_position_fraction: "1.0", max_total_exposure_fraction: "5.0", max_daily_loss_fraction: "0.9", max_drawdown_kill_fraction: "0.5" },
      };
      const { ok, body: res } = await api("/api/portfolio/run", { method: "POST", body: JSON.stringify(body) });
      if (!ok || res?.error) { setError(JSON.stringify(res)); setRunning(false); return; }
      setResult(res);
    } catch (e) { setError(e.message); }
    setRunning(false);
  }

  const perf = result?.metrics || {};
  const eq = (result?.equity_curve || []).map(Number).filter(isFinite);
  const fills = result?.fills || [];
  const hasEquityLeg = legs.some((l) => assetClassOf(l.symbol) === "equity");

  return html`
    <div class="page-title">
      <div>
        <h2>Multi-Asset / Multi-Token Portfolio</h2>
        <div class="sub">One combined book across crypto tokens + tokenized equities (xStocks). Target-weight / inverse-vol / risk-parity / momentum, with combined risk + rebalancing.</div>
      </div>
    </div>

    <div class="alert info">
      <span class="alert-icon">ⓘ</span>
      <div>Every leg fills on its own bars into <b>one combined ledger</b> with shared risk gates — the model maps to a Bybit <b>Unified Trading Account</b>: crypto perps route to <code>category=linear</code>, crypto-spot & xStocks to <code>category=spot</code>, rebalances batch via <code>POST /v5/order/create-batch</code>. Equity legs are auto-constrained to spot · long-only · no-leverage.</div>
    </div>

    <div style=${{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 16 }}>
      <div>
        <div class="panel">
          <div class="panel-title">
            <span>Legs</span>
            <button class="ghost" onClick=${addLeg}>+ Add leg</button>
          </div>
          <${SymbolDatalist} id="pf-symbols" />
          <table>
            <thead><tr><th>Symbol</th><th>Class</th><th>Weight</th><th>Lev</th><th></th></tr></thead>
            <tbody>
              ${legs.map((l, i) => {
                const ac = assetClassOf(l.symbol);
                return html`<tr key=${i}>
                  <td><input list="pf-symbols" style=${{ width: 120 }} value=${l.symbol} onChange=${(e) => updateLeg(i, { symbol: e.target.value })} /></td>
                  <td><span class=${`tag ${ac === "equity" ? "info" : "muted"}`}>${ac}</span></td>
                  <td><input style=${{ width: 64 }} value=${l.weight} onChange=${(e) => updateLeg(i, { weight: e.target.value })} /></td>
                  <td><input style=${{ width: 48 }} value=${ac === "equity" ? "1" : l.leverage} disabled=${ac === "equity"} onChange=${(e) => updateLeg(i, { leverage: e.target.value })} /></td>
                  <td><button class="ghost" onClick=${() => removeLeg(i)}>✕</button></td>
                </tr>`;
              })}
            </tbody>
          </table>
          ${hasEquityLeg ? html`<div class="footer-note">Equity legs (xStocks) are spot · long-only · unleveraged · RTH-aware. Weights are used directly for <code>fixed</code>; other schemes compute weights from price history.</div>` : null}
        </div>

        <div class="panel">
          <div class="panel-title">Strategy</div>
          <div class="field"><label>Weighting Scheme</label>
            <select value=${weighting} onChange=${(e) => setWeighting(e.target.value)}>
              <option value="fixed">fixed (use leg weights)</option>
              <option value="equal">equal weight</option>
              <option value="inverse_vol">inverse volatility</option>
              <option value="risk_parity">risk parity</option>
              <option value="momentum">momentum rotation (top-N)</option>
            </select>
          </div>
          <div class="grid-3">
            <div class="field"><label>Total Equity</label><input value=${totalEquity} onChange=${(e) => setTotalEquity(e.target.value)} /></div>
            <div class="field"><label>Rebalance Δ</label><input value=${threshold} onChange=${(e) => setThreshold(e.target.value)} /></div>
            <div class="field"><label>Bars</label><input value=${nBars} onChange=${(e) => setNBars(Number(e.target.value) || 80)} /></div>
          </div>
          <div class="grid-2">
            <div class="field"><label>Lookback (vol/mom)</label><input value=${lookback} onChange=${(e) => setLookback(e.target.value)} /></div>
            <div class="field"><label>Top-N (momentum)</label><input value=${topN} onChange=${(e) => setTopN(e.target.value)} /></div>
          </div>
          <div class="row" style=${{ marginBottom: 8 }}>
            <label style=${{ flex: "0 0 auto", color: "var(--text-muted)", fontSize: 12 }}>
              <input type="checkbox" style=${{ width: 16, marginRight: 6 }} checked=${useReal} onChange=${(e) => setUseReal(e.target.checked)} />
              Use real Bybit data
            </label>
            <button class="secondary" onClick=${loadRealData} disabled=${loadingReal}>${loadingReal ? "Loading…" : "Load real candles"}</button>
          </div>
          <div class="footer-note" style=${{ margin: "0 0 8px" }}>
            Data source: <b>${useReal && realBars ? `REAL Bybit (${Object.keys(realBars).filter((s) => legs.some((l) => l.symbol === s)).length}/${legs.length} legs)` : "synthetic sample"}</b>
            ${useReal && realBars ? "" : " — click ‘Load real candles’ for live-data results"}
          </div>
          <button onClick=${run} disabled=${running}>${running ? "Running…" : "Build & Run Portfolio"}</button>
          ${error ? html`<div class="alert danger"><span class="alert-icon">✗</span><div>${error}</div></div>` : null}
        </div>
      </div>

      <div>
        <div class="panel">
          <div class="panel-title">Leg Candles (aligned timeline)</div>
          ${legs.map((l, i) => html`<div key=${i} style=${{ marginBottom: 10 }}>
            <div class="footer-note" style=${{ margin: "0 0 4px" }}>${l.symbol} <span class=${`tag ${assetClassOf(l.symbol) === "equity" ? "info" : "muted"}`}>${assetClassOf(l.symbol)}</span></div>
            <${CandleChart} bars=${barsByLeg[i]} height=${150} showVolume=${false} />
          </div>`)}
        </div>

        ${result ? html`
          <div class="panel">
            <div class="panel-title">
              <span>Portfolio Result</span>
              ${result.risk_state?.killed ? html`<span class="tag danger">KILLED · ${result.risk_state.kill_reason}</span>` : html`<span class="tag ok">Completed</span>`}
            </div>
            <div class="tiles">
              <div class="tile"><div class="tile-label">Final Equity</div><div class="tile-value">${Number(result.final_equity).toFixed(0)}</div></div>
              <div class="tile ${perf.total_return > 0 ? "ok" : (perf.total_return < 0 ? "danger" : "")}"><div class="tile-label">Total Return</div><div class="tile-value">${((perf.total_return || 0) * 100).toFixed(2)}%</div></div>
              <div class="tile"><div class="tile-label">Sharpe</div><div class="tile-value">${(perf.sharpe || 0).toFixed(2)}</div></div>
              <div class="tile warn"><div class="tile-label">Max DD</div><div class="tile-value">${((perf.max_drawdown || 0) * 100).toFixed(2)}%</div></div>
              <div class="tile"><div class="tile-label">Rebalances</div><div class="tile-value">${result.rebalances}</div></div>
              <div class="tile"><div class="tile-label">Fills</div><div class="tile-value">${fills.length}</div></div>
            </div>
            <div style=${{ marginTop: 14 }}>
              <div class="panel-title">Combined Equity Curve</div>
              <${LineChart} series=${[{ name: "Equity", color: "#7aa2f7", fill: "rgba(122,162,247,0.12)", values: eq }]} height=${170} />
            </div>
            ${result.risk_notes?.length ? html`<div class="alert warn"><span class="alert-icon">!</span><div>${result.risk_notes.join(" · ")}</div></div>` : null}
            <div style=${{ marginTop: 14 }}>
              <div class="panel-title">Positions</div>
              <table>
                <thead><tr><th>Symbol</th><th>Class</th><th>Side</th><th>Qty</th><th>Avg Entry</th><th>Realized PnL</th></tr></thead>
                <tbody>
                  ${Object.entries(result.positions || {}).map(([s, p]) => html`<tr key=${s}>
                    <td class="num">${s}</td>
                    <td><span class=${`tag ${p.asset_class === "equity" ? "info" : "muted"}`}>${p.asset_class}</span></td>
                    <td><span class=${`tag ${p.side === "long" ? "ok" : (p.side === "short" ? "danger" : "muted")}`}>${p.side}</span></td>
                    <td class="num">${Number(p.qty).toFixed(4)}</td>
                    <td class="num">${Number(p.avg_entry).toFixed(2)}</td>
                    <td class="num">${Number(p.realized_pnl).toFixed(2)}</td>
                  </tr>`)}
                </tbody>
              </table>
            </div>
            <div style=${{ marginTop: 14 }}>
              <div class="panel-title">Fills (latest 30)</div>
              <table>
                <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Tag</th></tr></thead>
                <tbody>
                  ${fills.slice(-30).map((f, i) => html`<tr key=${i}>
                    <td class="num">${String(f.ts).slice(5, 16)}</td>
                    <td class="num">${f.symbol}</td>
                    <td><span class=${`tag ${f.side === "buy" ? "ok" : "danger"}`}>${f.side}</span></td>
                    <td class="num">${Number(f.qty).toFixed(4)}</td>
                    <td class="num">${Number(f.price).toFixed(2)}</td>
                    <td class="footer-note" style=${{ margin: 0 }}>${f.tag}</td>
                  </tr>`)}
                </tbody>
              </table>
            </div>
          </div>` : null}
      </div>
    </div>
  `;
}

// ---- Main App ----
function App() {
  const [screen, setScreen] = useState("home");
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [editorMode, setEditorMode] = useState("json");
  const [jsonText, setJsonText] = useState("{}");
  const [yamlText, setYamlText] = useState("");
  const [validation, setValidation] = useState(null);
  const [validationError, setValidationError] = useState("");
  const [strategyVersionId, setStrategyVersionId] = useState("phase4-ui-v1");
  const [strategyId, setStrategyId] = useState("phase4-ui");
  const [coverageInput, setCoverageInput] = useState({
    symbol: "BTCUSDT",
    category: "linear",
    interval: "15",
    startTs: 1767225600000,
    endTs: 1767233700000
  });
  const [coverageResult, setCoverageResult] = useState(null);
  const [gapsResult, setGapsResult] = useState(null);
  const [runResult, setRunResult] = useState(null);
  const [runError, setRunError] = useState("");
  const [barsText, setBarsText] = useState("[]");
  const [fundingText, setFundingText] = useState("[]");
  const [paperState, setPaperState] = useState({
    accountId: "paper-acct-1",
    sessionId: "paper-session-1",
    symbol: "BTCUSDT",
    strategyVersionId: "phase4-ui-v1",
    price: "100",
    tsMs: Date.now()
  });
  const [paperResult, setPaperResult] = useState(null);
  const [paperError, setPaperError] = useState("");
  const [optimizerCandidatesText, setOptimizerCandidatesText] = useState(j([
    { params: { ema_fast: 20, ema_slow: 80 }, vector_metrics: { total_return: 0.23, max_drawdown: 0.11, trade_count: 34 } },
    { params: { ema_fast: 25, ema_slow: 90 }, vector_metrics: { total_return: 0.20, max_drawdown: 0.10, trade_count: 30 } },
    { params: { ema_fast: 30, ema_slow: 100 }, vector_metrics: { total_return: 0.16, max_drawdown: 0.08, trade_count: 25 } }
  ]));
  const [optimizerResult, setOptimizerResult] = useState(null);
  const [optimizerError, setOptimizerError] = useState("");
  const [riskInput, setRiskInput] = useState({
    total_return_after_fees_funding: 0.18,
    sharpe: 1.8,
    calmar: 1.4,
    max_drawdown: 0.12,
    consistency: 0.6,
    robustness: 0.55,
    live_paper_score: 0.0,
    liquidation_events: 0,
    overfit_penalty: 0.05,
    data_coverage_complete: true,
    approximate_fills: false
  });
  const [riskResult, setRiskResult] = useState(null);
  const [leaderboardTier, setLeaderboardTier] = useState("BACKTEST VERIFIED");
  const [leaderboardRows, setLeaderboardRows] = useState([]);
  const [verifyInput, setVerifyInput] = useState({
    runId: "",
    strategyVersionId: "phase4-ui-v1",
    submittedRunHash: "",
    submittedStrategyHash: "",
    requestedTier: "BACKTEST_VERIFIED",
    dataSnapshotId: "canonical-v1"
  });
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifyError, setVerifyError] = useState("");
  const [replayRunId, setReplayRunId] = useState("");
  const [replayData, setReplayData] = useState(null);
  const [replayError, setReplayError] = useState("");

  // Algo Bot Lab state
  const [strategies, setStrategies] = useState([]);
  const [selectedAlgo, setSelectedAlgo] = useState(null);
  const [algoParams, setAlgoParams] = useState("{}");
  const [algoSymbol, setAlgoSymbol] = useState("BTCUSDT");
  const [algoEquity, setAlgoEquity] = useState("100000");
  const [algoRisk, setAlgoRisk] = useState({
    max_position_fraction: "1.0",
    max_daily_loss_fraction: "0.10",
    max_drawdown_kill_fraction: "0.20",
    max_total_exposure_fraction: "5.0"
  });
  // NOTE: synthetic bars are NOT used as defaults anywhere — real Bybit candles are
  // loaded on mount (see effect below). This generator is kept only for the explicit
  // "Generate sample bars" sandbox button.
  const makeSampleBars = (n = 60) => {
    const out = [];
    let px = 30000;
    const start = Date.now() - n * 15 * 60 * 1000;
    for (let i = 0; i < n; i++) {
      const drift = (Math.sin(i / 7) * 50) + (Math.random() - 0.5) * 30;
      const open = px;
      const close = px + drift;
      const high = Math.max(open, close) + Math.random() * 20;
      const low = Math.min(open, close) - Math.random() * 20;
      out.push({ ts: start + i * 15 * 60 * 1000, open: open.toFixed(2), high: high.toFixed(2), low: low.toFixed(2), close: close.toFixed(2), volume: "1" });
      px = close;
    }
    return out;
  };
  const [algoBars, setAlgoBars] = useState("[]");

  // Bot OS v4.1 state
  const [botTemplates, setBotTemplates] = useState([]);
  const [selectedBot, setSelectedBot] = useState(null);
  const [botParams, setBotParams] = useState("{}");
  const [botBars, setBotBars] = useState("[]");
  const [requestedTier, setRequestedTier] = useState("LOCAL ONLY");
  const [l2Available, setL2Available] = useState(false);
  const [botRunResult, setBotRunResult] = useState(null);
  const [botRunError, setBotRunError] = useState("");
  const [recBars, setRecBars] = useState("[]");
  const [recFunding, setRecFunding] = useState("");
  const [recRiskTolerance, setRecRiskTolerance] = useState("moderate");
  const [recResult, setRecResult] = useState(null);
  const [recError, setRecError] = useState("");
  const [cockpitBotType, setCockpitBotType] = useState("futures_martingale");
  const [cockpitParams, setCockpitParams] = useState("{}");
  const [cockpitL2, setCockpitL2] = useState(false);
  const [cockpitResult, setCockpitResult] = useState(null);
  const [cockpitError, setCockpitError] = useState("");
  const [marketplaceRows, setMarketplaceRows] = useState([]);
  const [mpTier, setMpTier] = useState("BACKTEST VERIFIED");
  const [algoResult, setAlgoResult] = useState(null);
  const [algoError, setAlgoError] = useState("");
  const [algoRunning, setAlgoRunning] = useState(false);

  const health = useHealth();

  // Load REAL Bybit candles as the default everywhere (no synthetic/mock defaults),
  // and subscribe the symbol to the live feed so its latest bar stays <1 min fresh.
  useEffect(() => {
    api("/api/live/subscribe", { method: "POST", body: JSON.stringify({ items: [{ symbol: "BTCUSDT", category: "linear", interval: "1" }] }) }).catch(() => {});
    api("/api/candles?symbol=BTCUSDT&category=linear&interval=D&limit=200").then(({ ok, body }) => {
      if (ok && body?.bars?.length) {
        const t = j(body.bars);
        setBarsText(t); setAlgoBars(t); setBotBars(t); setRecBars(t);
        setCoverageInput((s) => ({ ...s, symbol: "BTCUSDT", category: "linear", interval: "1440",
          startTs: body.bars[0].ts, endTs: body.bars[body.bars.length - 1].ts }));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    api("/api/strategies/registry").then(({ body }) => {
      const list = body?.strategies || [];
      setStrategies(list);
      if (list.length) {
        setSelectedAlgo(list[0]);
        setAlgoParams(j(list[0].params));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedAlgo) setAlgoParams(j(selectedAlgo.params));
  }, [selectedAlgo?.id]);

  async function runAlgo() {
    setAlgoError("");
    setAlgoRunning(true);
    try {
      const params = safeParse(algoParams);
      const bars = safeParse(algoBars);
      if (!params || !bars) { setAlgoError("params or bars JSON invalid"); setAlgoRunning(false); return; }
      const payload = {
        symbol: algoSymbol,
        strategy_id: selectedAlgo.id,
        strategy_params: params,
        starting_equity: String(algoEquity),
        fee_bps_taker: "5.5",
        fee_bps_maker: "1.0",
        slippage_bps_one_way: "2.0",
        interval_minutes: 15,
        risk: algoRisk,
        bars,
        funding_rows: []
      };
      const { ok, body } = await api("/api/paper/runtime/run", { method: "POST", body: JSON.stringify(payload) });
      if (!ok || body?.error) { setAlgoError(JSON.stringify(body)); setAlgoRunning(false); return; }
      setAlgoResult(body);
    } catch (e) {
      setAlgoError(e.message);
    }
    setAlgoRunning(false);
  }

  const generateSampleBars = () => setAlgoBars(j(makeSampleBars(60)));

  // Bot OS handlers
  useEffect(() => {
    api("/api/bots/templates").then(({ body }) => {
      const list = body?.templates || [];
      setBotTemplates(list);
      if (list.length) {
        setSelectedBot(list[0]);
        setBotParams(j(list[0].default_params));
      }
    }).catch(() => {});
  }, []);

  async function runBot() {
    setBotRunError(""); setBotRunResult(null);
    try {
      const params = safeParse(botParams);
      const bars = safeParse(botBars);
      if (!params || !bars) { setBotRunError("params or bars invalid JSON"); return; }
      const specCreate = await api("/api/bots/specs", { method: "POST", body: JSON.stringify({
        botType: selectedBot.bot_type,
        name: selectedBot.display_name,
        symbols: [params.symbol || params.perp_symbol || "BTCUSDT"],
        params,
        risk: {},
        accounting: {},
      }) });
      const botSpecId = specCreate.body?.botSpecId;
      if (!botSpecId) { setBotRunError(`failed to create bot spec: ${j(specCreate.body)}`); return; }
      const payload = {
        botSpecId,
        symbol: params.symbol || params.perp_symbol || "BTCUSDT",
        starting_equity: "10000",
        risk: { max_position_fraction: "1.0", max_total_exposure_fraction: "5.0" },
        bars, funding_rows: [],
        requested_tier: requestedTier, coverage: { has_l2: l2Available },
        interval_minutes: 15,
      };
      const { body } = await api("/api/bots/runs/backtest", { method: "POST", body: JSON.stringify(payload) });
      setBotRunResult(body);
    } catch (e) { setBotRunError(e.message); }
  }

  async function runRecommend() {
    setRecError(""); setRecResult(null);
    try {
      const bars = safeParse(recBars);
      if (!bars) { setRecError("Bars JSON invalid"); return; }
      const payload = { bars, funding_rate_last: recFunding || null, data_complete: true, risk_tolerance: recRiskTolerance };
      const { body } = await api("/api/bots/recommendations/scan", { method: "POST", body: JSON.stringify(payload) });
      setRecResult(body);
    } catch (e) { setRecError(e.message); }
  }

  async function createFromRec(rec) {
    const { body } = await api("/api/bots/specs", { method: "POST", body: JSON.stringify({
      botType: rec.bot_type, name: `Rec ${rec.bot_type}`,
      symbols: [rec.params.symbol || rec.params.perp_symbol || "BTCUSDT"],
      params: rec.params,
    }) });
    setRecResult((s) => ({ ...s, last_created: body }));
  }

  async function runCockpit() {
    setCockpitError(""); setCockpitResult(null);
    try {
      const params = safeParse(cockpitParams);
      if (!params) { setCockpitError("Params JSON invalid"); return; }
      const payload = { spec: { bot_type: cockpitBotType, name: cockpitBotType, symbols: [params.symbol || params.perp_symbol || "BTCUSDT"], params }, coverage: { has_l2: cockpitL2 } };
      const { body } = await api("/api/bots/cockpit", { method: "POST", body: JSON.stringify(payload) });
      setCockpitResult(body);
    } catch (e) { setCockpitError(e.message); }
  }

  const refreshMarketplace = useCallback(async () => {
    const { body } = await api(`/api/bots/marketplace?tier=${encodeURIComponent(mpTier)}`);
    setMarketplaceRows(body?.cards || []);
  }, [mpTier]);
  useEffect(() => { if (screen === "marketplace") refreshMarketplace(); }, [screen, refreshMarketplace]);

  async function forkCard(cardId) {
    await api(`/api/bots/marketplace/${cardId}/fork`, { method: "POST", body: JSON.stringify({}) });
    refreshMarketplace();
  }

  useEffect(() => {
    api("/api/templates").then(({ body }) => {
      const list = body?.templates || [];
      setTemplates(list);
      if (list.length) {
        setSelectedTemplate(list[0]);
        const text = j(list[0].strategy);
        setJsonText(text);
        setYamlText(stringifyYaml(JSON.parse(text)));
      }
    }).catch(() => setValidationError("Failed to load templates."));
  }, []);

  function onSelectTemplate(template) {
    setSelectedTemplate(template);
    const text = j(template.strategy);
    setJsonText(text);
    setYamlText(stringifyYaml(JSON.parse(text)));
    setValidation(null);
    setValidationError("");
  }

  function syncFromJson(text) {
    setJsonText(text);
    const parsed = safeParse(text);
    if (parsed) { setYamlText(stringifyYaml(parsed)); setValidationError(""); }
    else setValidationError("JSON parse error.");
  }
  function syncFromYaml(text) {
    setYamlText(text);
    try {
      const parsed = parseYaml(text);
      setJsonText(j(parsed));
      setValidationError("");
    } catch (e) { setValidationError(`YAML parse error: ${e.message}`); }
  }

  async function saveVersion() {
    const dsl = safeParse(jsonText);
    if (!dsl) { setValidationError("Cannot save: JSON invalid."); return; }
    await api("/api/strategies", { method: "POST", body: JSON.stringify({ strategyId, name: dsl?.strategy?.name || "UI Strategy" }) });
    await api(`/api/strategies/${strategyId}/versions`, { method: "POST", body: JSON.stringify({ strategyVersionId, dsl, schemaVersion: "v1" }) });
    setValidationError("Saved strategy + version.");
  }

  async function validateStrategy() {
    setValidationError("");
    const strategy = safeParse(jsonText);
    if (!strategy) { setValidationError("Cannot validate: JSON invalid."); return; }
    const { body } = await api(`/api/strategies/${strategyVersionId}/validate`, {
      method: "POST",
      body: JSON.stringify({ mode: "historical_backtest", strategy, coverage: coverageInput })
    });
    setValidation(body);
  }

  async function checkCoverage() {
    const { body } = await api("/api/data/gaps", { method: "POST", body: JSON.stringify(coverageInput) });
    setCoverageResult(body);
  }

  async function runBacktest() {
    setRunError(""); setRunResult(null);
    const bars = safeParse(barsText), fundingRows = safeParse(fundingText);
    if (!bars || !fundingRows) { setRunError("bars or funding rows JSON invalid"); return; }
    // xStocks are spot, long-only — coerce category/side automatically.
    const isXs = isXstockSym(_xstockCache?.set || new Set(), coverageInput.symbol) || /XUSDT$/.test(String(coverageInput.symbol || ""));
    const category = isXs ? "spot" : coverageInput.category;
    const { ok, body } = await api("/api/backtests", {
      method: "POST",
      body: JSON.stringify({
        strategyVersionId, ...coverageInput, category, intervalMinutes: Number(coverageInput.interval),
        dataVersion: "phase4-v1", engineVersion: "quant-core-phase3-v2", seed: 42,
        bars, fundingRows: isXs ? [] : fundingRows, signalBarIndex: 0, side: "long", qty: "0.5", slippageBpsOneWay: "2"
      })
    });
    if (!ok) { setRunError(JSON.stringify(body)); return; }
    const details = await api(`/api/backtests/${body.runId}`);
    setRunResult(details.body);
  }

  async function initPaper() {
    setPaperError("");
    await api("/api/paper/accounts", { method: "POST", body: JSON.stringify({ accountId: paperState.accountId, startingBalance: "10000", quoteCurrency: "USDT" }) });
    await api("/api/paper/sessions", { method: "POST", body: JSON.stringify({
      sessionId: paperState.sessionId, accountId: paperState.accountId,
      strategyVersionId: paperState.strategyVersionId, symbol: paperState.symbol,
      maxDataAgeMs: 30000, requiredFreshTicks: 3
    }) });
    const session = await api(`/api/paper/sessions/${paperState.sessionId}`);
    setPaperResult(session.body);
  }
  async function sendTick() {
    setPaperError("");
    const tickRes = await api(`/api/paper/sessions/${paperState.sessionId}/tick`, { method: "POST", body: JSON.stringify({
      symbol: paperState.symbol, price: paperState.price, tsMs: Number(paperState.tsMs), nowMs: Date.now()
    }) });
    const session = await api(`/api/paper/sessions/${paperState.sessionId}`);
    setPaperResult({ tickRes: tickRes.body, ...session.body });
  }
  async function rebuildPaper() {
    const rebuild = await api(`/api/paper/sessions/${paperState.sessionId}/rebuild`, { method: "POST" });
    const session = await api(`/api/paper/sessions/${paperState.sessionId}`);
    setPaperResult({ rebuild: rebuild.body, ...session.body });
  }

  async function runOptimization() {
    setOptimizerError("");
    const candidates = safeParse(optimizerCandidatesText);
    if (!candidates) { setOptimizerError("Candidates JSON invalid"); return; }
    const run = await api("/api/optimizer/runs", { method: "POST", body: JSON.stringify({
      strategyVersionId, method: "grid", topN: 3, eventOnlyTemplate: false,
      thresholds: { allowed_return_drift: 0.005, allowed_drawdown_drift: 0.01, allowed_trade_count_drift: 2 },
      candidates
    }) });
    if (!run.body?.runId) { setOptimizerError(JSON.stringify(run.body)); return; }
    const details = await api(`/api/optimizer/runs/${run.body.runId}`);
    setOptimizerResult(details.body);
  }

  function evaluateRisk() {
    // pure client-side preview using the same logic the worker emits.
    const t = riskInput;
    const failures = [];
    if (t.max_drawdown > 0.30) failures.push("MAX_DRAWDOWN_CAP");
    if (t.liquidation_events !== 0) failures.push("LIQUIDATION_EVENTS_NONZERO");
    if (!t.data_coverage_complete) failures.push("DATA_COVERAGE_INCOMPLETE");
    if (t.overfit_penalty > 0.20) failures.push("OVERFIT_THRESHOLD_EXCEEDED");
    if (t.approximate_fills) failures.push("APPROXIMATE_FILLS_BLOCKED");
    const base = 0.20 * 50 + 0.15 * 50 + 0.15 * 50 + 0.15 * 50 + 0.10 * 50 + 0.10 * 50 + 0.15 * 50;
    setRiskResult({ base_score: base, hard_gates_passed: failures.length === 0, gate_failures: failures });
  }

  const refreshLeaderboard = useCallback(async () => {
    const { body } = await api(`/api/leaderboard?tier=${encodeURIComponent(leaderboardTier)}`);
    setLeaderboardRows(body?.rows || []);
  }, [leaderboardTier]);
  useEffect(() => { if (screen === "leaderboard") refreshLeaderboard(); }, [screen, refreshLeaderboard]);

  async function submitVerify() {
    setVerifyError(""); setVerifyResult(null);
    try {
      const { body } = await api("/api/passports/publish", {
        method: "POST",
        body: JSON.stringify(verifyInput)
      });
      setVerifyResult(body);
    } catch (e) { setVerifyError(e.message); }
  }

  const runGapScan = async () => {
    const { body } = await api("/api/data/gaps", { method: "POST", body: JSON.stringify(coverageInput) });
    setGapsResult(body);
  };

  const eligibility = validation?.eligibility_label ?? selectedTemplate?.eligibility ?? "HISTORICAL_FACTOR_OK";

  return html`
    <${Header} health=${health} />
    <div class="main">
      <${Sidebar} screen=${screen} setScreen=${setScreen} />
      <section class="content">
        ${screen === "home" && html`<${HomeDashboard} health=${health} templates=${templates} refreshHealth=${health.refresh} />`}
        ${screen === "builder" && html`<${StrategyBuilder}
          templates=${templates} selected=${selectedTemplate} onSelect=${onSelectTemplate}
          jsonText=${jsonText} yamlText=${yamlText} syncFromJson=${syncFromJson} syncFromYaml=${syncFromYaml}
          editorMode=${editorMode} setEditorMode=${setEditorMode}
          validation=${validation} validationError=${validationError}
          validateStrategy=${validateStrategy} saveVersion=${saveVersion}
          coverageInput=${coverageInput} setCoverageInput=${setCoverageInput}
          strategyId=${strategyId} setStrategyId=${setStrategyId}
          strategyVersionId=${strategyVersionId} setStrategyVersionId=${setStrategyVersionId} />`}
        ${screen === "arena" && html`<${BacktestArena}
          strategyVersionId=${strategyVersionId} coverageInput=${coverageInput} eligibility=${eligibility}
          runBacktest=${runBacktest} runResult=${runResult} runError=${runError}
          barsText=${barsText} setBarsText=${setBarsText} fundingText=${fundingText} setFundingText=${setFundingText}
          checkCoverage=${checkCoverage} coverageResult=${coverageResult} />`}
        ${screen === "botstudio" && html`<${BotTemplateStudio}
          botTemplates=${botTemplates} selectedBot=${selectedBot} setSelectedBot=${setSelectedBot}
          botParams=${botParams} setBotParams=${setBotParams}
          botBars=${botBars} setBotBars=${setBotBars}
          botRunResult=${botRunResult} botRunError=${botRunError} runBot=${runBot}
          requestedTier=${requestedTier} setRequestedTier=${setRequestedTier}
          l2Available=${l2Available} setL2Available=${setL2Available} />`}
        ${screen === "recommender" && html`<${StrategyRecommenderScreen}
          recBars=${recBars} setRecBars=${setRecBars}
          recFunding=${recFunding} setRecFunding=${setRecFunding}
          recRiskTolerance=${recRiskTolerance} setRecRiskTolerance=${setRecRiskTolerance}
          recResult=${recResult} runRecommend=${runRecommend} recError=${recError}
          createFromRec=${createFromRec} />`}
        ${screen === "cockpit" && html`<${RiskCockpitScreen}
          cockpitBotType=${cockpitBotType} setCockpitBotType=${setCockpitBotType}
          cockpitParams=${cockpitParams} setCockpitParams=${setCockpitParams}
          cockpitL2=${cockpitL2} setCockpitL2=${setCockpitL2}
          cockpitResult=${cockpitResult} runCockpit=${runCockpit} cockpitError=${cockpitError}
          botTemplates=${botTemplates} />`}
        ${screen === "xstocks" && html`<${XStocksLab} />`}
        ${screen === "desk" && html`<${StrategyDesk} />`}
        ${screen === "livepaper" && html`<${LivePaperScreen} />`}
        ${screen === "portfolio" && html`<${MultiAssetPortfolioLab} />`}
        ${screen === "marketplace" && html`<${MarketplaceScreen}
          marketplaceRows=${marketplaceRows} refreshMarketplace=${refreshMarketplace}
          mpTier=${mpTier} setMpTier=${setMpTier} forkCard=${forkCard} />`}
        ${screen === "algo" && html`<${AlgoBotLab}
          strategies=${strategies} selectedAlgo=${selectedAlgo} setSelectedAlgo=${setSelectedAlgo}
          algoParams=${algoParams} setAlgoParams=${setAlgoParams}
          algoBars=${algoBars} setAlgoBars=${setAlgoBars}
          algoSymbol=${algoSymbol} setAlgoSymbol=${setAlgoSymbol}
          algoEquity=${algoEquity} setAlgoEquity=${setAlgoEquity}
          algoRisk=${algoRisk} setAlgoRisk=${setAlgoRisk}
          runAlgo=${runAlgo} algoResult=${algoResult} algoError=${algoError} algoRunning=${algoRunning}
          generateSampleBars=${generateSampleBars} />`}
        ${screen === "paper" && html`<${PaperWarRoom}
          paperState=${paperState} setPaperState=${setPaperState}
          paperResult=${paperResult} paperError=${paperError}
          initPaper=${initPaper} sendTick=${sendTick} rebuildPaper=${rebuildPaper} />`}
        ${screen === "optimizer" && html`<${OptimizationLab}
          strategyVersionId=${strategyVersionId}
          optimizerCandidatesText=${optimizerCandidatesText} setOptimizerCandidatesText=${setOptimizerCandidatesText}
          runOptimization=${runOptimization} optimizerResult=${optimizerResult} optimizerError=${optimizerError} />`}
        ${screen === "risk" && html`<${RiskLab}
          riskInput=${riskInput} setRiskInput=${setRiskInput}
          riskResult=${riskResult} evaluateRisk=${evaluateRisk} />`}
        ${screen === "leaderboard" && html`<${Leaderboard}
          rows=${leaderboardRows} tier=${leaderboardTier} setTier=${setLeaderboardTier} refresh=${refreshLeaderboard} />`}
        ${screen === "verifier" && html`<${VerifierPassport}
          verifyInput=${verifyInput} setVerifyInput=${setVerifyInput}
          verifyResult=${verifyResult} verifyError=${verifyError} submit=${submitVerify} />`}
        ${screen === "replay" && html`<${ReplayDebugger}
          runId=${replayRunId} setRunId=${setReplayRunId}
          replay=${replayData} setReplay=${setReplayData}
          replayError=${replayError} setReplayError=${setReplayError} />`}
        ${screen === "data" && html`<${DataHealthConsole}
          health=${health} refresh=${health.refresh}
          coverageInput=${coverageInput} setCoverageInput=${setCoverageInput}
          gapsResult=${gapsResult} runGapScan=${runGapScan} />`}
      </section>
    </div>
  `;
}

createRoot(document.getElementById("root")).render(React.createElement(App));
