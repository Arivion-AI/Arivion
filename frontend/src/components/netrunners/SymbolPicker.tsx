"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { netrunnersGet } from "@/lib/netrunners/api";
import { TokenIcon } from "./TokenIcon";

export type SymbolMeta = {
  symbol: string;
  category: string;       // 'linear' | 'spot' | 'dex' | 'testnet'
  kind: string;           // 'crypto' | 'equity' | 'pool' | 'test_stock'
  base: string;
  quote: string;
  underlying?: string;
  name?: string;
  has_data?: boolean;
  data_source?: "bybit" | "dex" | "testnet";
  pool_id?: string;
  chain_id?: number;
  venue_id?: string;
  venue_name?: string;
  token_address?: string;
  latest_close?: string | null;
  latest_liquidity?: string | null;
};

let cache: SymbolMeta[] | null = null;
let inflight: Promise<SymbolMeta[]> | null = null;
async function loadSymbols(): Promise<SymbolMeta[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = netrunnersGet<{ symbols?: SymbolMeta[] }>("/api/symbols").then((r) => {
      cache = (r?.symbols ?? []);
      return cache;
    });
  }
  return inflight;
}

let onchainCache: SymbolMeta[] | null = null;
let onchainInflight: Promise<SymbolMeta[]> | null = null;

type DexPool = {
  pool_id: string;
  chain_id: number;
  venue_id?: string;
  venue_name?: string;
  token0_symbol?: string;
  token1_symbol?: string;
  latest_close?: string | null;
  latest_liquidity?: string | null;
  latest_candle_at?: string | null;
  status?: string;
};

type ChainToken = {
  chain_id: number;
  address: string;
  symbol: string;
  name: string;
  kind?: string;
  underlying_symbol?: string;
  is_test_asset?: boolean;
  metadata_json?: Record<string, unknown>;
};

async function loadOnchainAssets(): Promise<SymbolMeta[]> {
  if (onchainCache) return onchainCache;
  if (!onchainInflight) {
    onchainInflight = Promise.all([
      netrunnersGet<{ pools?: DexPool[] }>("/api/dex/pools?limit=120"),
      netrunnersGet<{ tokens?: ChainToken[] }>("/api/chains/46630/tokens"),
    ]).then(([poolRes, tokenRes]) => {
      const pools = (poolRes?.pools ?? []).map((p) => {
        const base = p.token0_symbol || "TOKEN0";
        const quote = p.token1_symbol || "TOKEN1";
        return {
          symbol: `${base}/${quote}`,
          category: "dex",
          kind: "pool",
          base,
          quote,
          name: p.venue_name ? `${p.venue_name} pool` : "DEX pool",
          has_data: Boolean(p.latest_candle_at || p.latest_close),
          data_source: "dex" as const,
          pool_id: p.pool_id,
          chain_id: Number(p.chain_id),
          venue_id: p.venue_id,
          venue_name: p.venue_name,
          latest_close: p.latest_close ?? null,
          latest_liquidity: p.latest_liquidity ?? null,
        };
      });
      const tokens = (tokenRes?.tokens ?? []).map((t) => ({
        symbol: t.symbol,
        category: "testnet",
        kind: String(t.kind ?? "testnet"),
        base: t.symbol,
        quote: "TEST",
        underlying: t.underlying_symbol ?? String(t.metadata_json?.underlying_symbol ?? t.symbol),
        name: t.name,
        has_data: false,
        data_source: "testnet" as const,
        token_address: t.address,
        chain_id: Number(t.chain_id),
      }));
      onchainCache = [...pools, ...tokens];
      return onchainCache;
    }).catch(() => {
      onchainCache = [];
      return onchainCache;
    });
  }
  return onchainInflight;
}

type Props = {
  value: string;
  onChange: (symbol: string, meta?: SymbolMeta) => void;
  variant?: "dark" | "light";
};

const TABS = [
  { id: "data", label: "Has Data" },
  { id: "dex", label: "DEX Pools" },
  { id: "testnet", label: "Testnet" },
  { id: "all", label: "All" },
  { id: "stocks", label: "Stocks" },
  { id: "perps", label: "Perps" },
] as const;

/** Searchable popup over the FULL market universe with token/stock icons. */
export function SymbolPicker({ value, onChange, variant = "dark" }: Props) {
  const [open, setOpen] = useState(false);
  const [bybit, setBybit] = useState<SymbolMeta[]>(cache ?? []);
  const [onchain, setOnchain] = useState<SymbolMeta[]>(onchainCache ?? []);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("data");
  const ref = useRef<HTMLDivElement>(null);
  const light = variant === "light";

  useEffect(() => {
    void loadSymbols().then((rows) => setBybit(rows.map((s) => ({ ...s, data_source: "bybit" as const }))));
    void loadOnchainAssets().then(setOnchain);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const all = useMemo(() => [...bybit, ...onchain], [bybit, onchain]);
  const current = useMemo(() => all.find((s) => s.symbol === value || s.pool_id === value), [all, value]);

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    let rows = all;
    if (tab === "dex") rows = onchain.filter((s) => s.data_source === "dex");
    else if (tab === "testnet") rows = onchain.filter((s) => s.data_source === "testnet");
    if (tab === "stocks") rows = rows.filter((s) => s.kind === "equity");
    else if (tab === "perps") rows = rows.filter((s) => s.kind === "crypto");
    else if (tab === "data") rows = rows.filter((s) => s.has_data);
    if (needle) rows = rows.filter((s) => s.symbol.toUpperCase().includes(needle) || s.base.toUpperCase().includes(needle) || (s.name ?? "").toUpperCase().includes(needle) || (s.underlying ?? "").toUpperCase().includes(needle) || (s.pool_id ?? "").toUpperCase().includes(needle));
    // data-having first, then alpha
    return [...rows].sort((a, b) => Number(b.has_data) - Number(a.has_data) || a.symbol.localeCompare(b.symbol)).slice(0, 120);
  }, [all, onchain, q, tab]);

  const bg = light ? "#e7dcc6" : "var(--navy-2, #1b214b)";
  const border = light ? "#cfc4a8" : "var(--navy-line, #2a3060)";
  const fg = light ? "var(--ink,#1b1b1b)" : "var(--white,#eef)";

  return (
    <div style={{ width: "100%" }}>
      <button type="button" onClick={() => setOpen(true)} className="mono"
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderRadius: 8, background: bg, border: `1px solid ${border}`, color: fg, cursor: "pointer", fontSize: 12, textAlign: "left" }}>
        <TokenIcon symbol={value} kind={current?.kind} underlying={current?.underlying} size={18} />
        <span style={{ flex: 1, fontWeight: 700 }}>{value || "Select symbol"}</span>
        {current && <span style={{ fontSize: 9, color: light ? "var(--muted-ink,#6b6552)" : "var(--muted,#8a90c0)" }}>{current.data_source === "dex" ? "DEX" : current.kind === "equity" ? "xStock" : current.category}</span>}
        <span style={{ color: light ? "var(--muted-ink,#6b6552)" : "var(--orange,#f97316)", fontSize: 10 }}>▾</span>
      </button>

      {open && (
        // centered modal overlay
        <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "rgba(6,8,20,.66)", backdropFilter: "blur(3px)" }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div ref={ref} style={{ width: "min(560px, 94vw)", maxHeight: "82vh", display: "flex", flexDirection: "column",
            background: "#141a3a", border: "1px solid var(--navy-line,#2a3060)", borderRadius: 14, boxShadow: "0 24px 80px rgba(0,0,0,.6)", padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <div className="dsp" style={{ color: "var(--white)", fontSize: 16, letterSpacing: ".04em", flex: 1 }}>Select Asset</div>
              <div className="mono" style={{ color: "var(--muted,#8a90c0)", fontSize: 10, marginRight: 10 }}>{bybit.length} Bybit · {onchain.length} on-chain</div>
              <button type="button" onClick={() => setOpen(false)} className="mono" style={{ width: 26, height: 26, borderRadius: 7, border: "1px solid var(--navy-line,#2a3060)", background: "transparent", color: "var(--white)", cursor: "pointer" }}>✕</button>
            </div>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search — BTC, AAPL, SOL, ETH, TSLA…" className="mono"
              style={{ width: "100%", padding: "11px 13px", borderRadius: 9, background: "#0d1230", border: "1px solid var(--navy-line,#2a3060)", color: "var(--white)", fontSize: 13, outline: "none" }} />
            <div style={{ display: "flex", gap: 6, margin: "10px 0" }}>
              {TABS.map((t) => (
                <button key={t.id} type="button" onClick={() => setTab(t.id)} className="mono"
                  style={{ flex: 1, padding: "7px 6px", borderRadius: 7, fontSize: 11, cursor: "pointer",
                    background: tab === t.id ? "var(--navy-2,#1b214b)" : "transparent",
                    border: `1px solid ${tab === t.id ? "var(--orange,#f97316)" : "var(--navy-line,#2a3060)"}`, color: "var(--white)" }}>{t.label}</button>
              ))}
            </div>
            <div style={{ flex: 1, overflowY: "auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              {filtered.length === 0 && <div className="mono" style={{ gridColumn: "1 / 3", color: "var(--muted,#8a90c0)", padding: 14, fontSize: 12 }}>No matches.</div>}
              {filtered.map((s) => (
                <button key={`${s.data_source ?? "bybit"}:${s.pool_id ?? s.token_address ?? s.symbol}`} type="button" onClick={() => { onChange(s.symbol, s); setOpen(false); setQ(""); }} className="mono"
                  style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 9px", borderRadius: 8, cursor: "pointer",
                    background: s.symbol === value ? "var(--navy-2,#1b214b)" : "transparent", border: `1px solid ${s.symbol === value ? "var(--orange,#f97316)" : "transparent"}`, color: "var(--white)", fontSize: 12, textAlign: "left" }}>
                  <TokenIcon symbol={s.symbol} kind={s.kind} underlying={s.underlying} size={22} />
                  <span style={{ display: "flex", flexDirection: "column", overflow: "hidden", flex: 1 }}>
                    <span style={{ fontWeight: 700 }}>{s.symbol}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--muted,#8a90c0)", fontSize: 9 }}>{s.name || s.base} · {s.data_source === "dex" ? `${s.venue_name ?? "DEX"} · ${s.pool_id?.slice(0, 18) ?? ""}` : s.data_source === "testnet" ? `chain ${s.chain_id} testnet` : s.kind === "equity" ? "xStock" : s.category}</span>
                  </span>
                  {s.has_data
                    ? <span title="candle data available" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--teal,#16e0b0)", flexShrink: 0 }} />
                    : <span title="no local candle data" style={{ width: 7, height: 7, borderRadius: "50%", background: "#3a4180", flexShrink: 0 }} />}
                </button>
              ))}
            </div>
            <div className="mono" style={{ marginTop: 8, color: "var(--muted,#8a90c0)", fontSize: 9, display: "flex", gap: 12 }}>
              <span><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "var(--teal,#16e0b0)", marginRight: 4 }} />has candle data</span>
              <span>showing {filtered.length} of {all.length}</span>
              <span>DEX/testnet actions are guarded; mainnet execution stays disabled</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
