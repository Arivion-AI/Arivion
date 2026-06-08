"use client";

import { useState } from "react";

const STOCK_TOKEN_BASES = new Set(["AAPLX", "NVDAX", "TSLAX", "METAX", "AMZNX", "GOOGLX", "HOODX", "CRCLX", "COINX", "MCDX"]);
const QUOTES = ["USDT", "USDC", "USD", "DAI", "EUR"];

const CRYPTO_CDN = "https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color";
const STOCK_CDN = "https://assets.parqet.com/logos/symbol"; // by ticker, no auth
const STOCK_UNDERLYINGS = new Set(["TSLA", "AMZN", "PLTR", "NVDA", "AMD", "HOOD", "AAPL", "MSFT", "GOOGL", "META", "NFLX"]);
const CRYPTO_ALIASES: Record<string, string> = {
  WBTC: "btc",
  WETH: "eth",
  BTCB: "btc",
  ARB: "arb",
  AVAX: "avax",
  BNB: "bnb",
  DOGE: "doge",
  LINK: "link",
  SOL: "sol",
  WLD: "wld",
  USDT: "usdt",
  USDC: "usdc",
};

export function splitSymbol(symbol: string): { base: string; quote: string } {
  const s = (symbol || "").toUpperCase();
  for (const q of QUOTES) if (s.endsWith(q) && s.length > q.length) return { base: s.slice(0, -q.length), quote: q };
  return { base: s, quote: "" };
}

function iconUrls(base: string, kind?: string, underlying?: string): string[] {
  const b = base.toUpperCase();
  if (kind === "equity" || STOCK_TOKEN_BASES.has(b)) {
    const ul = underlying || (STOCK_TOKEN_BASES.has(b) ? b.slice(0, -1) : b.startsWith("D") && STOCK_UNDERLYINGS.has(b.slice(1)) ? b.slice(1) : b);
    return [`${STOCK_CDN}/${ul.toUpperCase()}`];
  }
  if (!b) return [];
  const normalized = CRYPTO_ALIASES[b] ?? b.toLowerCase();
  return [
    `${CRYPTO_CDN}/${normalized}.svg`,
    `/api/token-icon?symbol=${encodeURIComponent(b)}`,
  ];
}

/** Single circular glyph: real image only. If no provider has an icon, render nothing. */
function Glyph({ label, urls, size }: { label: string; urls: string[]; size: number }) {
  const [index, setIndex] = useState(0);
  const url = urls[index];
  if (!url) return null;
  return (
    <span
      title={label}
      style={{
        width: size, height: size, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "#0d1230", border: "1px solid rgba(255,255,255,.14)", overflow: "hidden", flexShrink: 0,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={label} width={size} height={size} style={{ width: "100%", height: "100%", objectFit: "contain" }} onError={() => setIndex((i) => i + 1)} loading="lazy" />
    </span>
  );
}

type Props = {
  symbol?: string;
  base?: string;
  quote?: string;
  kind?: string;       // 'crypto' | 'equity'
  underlying?: string;
  size?: number;
  pair?: boolean;      // show base + quote side by side (default true)
};

/** Token/stock icon. For a pair (e.g. BTCUSDT) renders the base + quote glyphs side by side
 *  (slightly overlapped). Stock-like symbols resolve to the underlying US-equity logo. */
export function TokenIcon({ symbol, base, quote, kind, underlying, size = 20, pair = true }: Props) {
  const parsed = symbol ? splitSymbol(symbol) : { base: base ?? "", quote: quote ?? "" };
  const b = (base ?? parsed.base).toUpperCase();
  const q = (quote ?? parsed.quote).toUpperCase();
  const baseUrls = iconUrls(b, kind, underlying);
  const quoteUrls = iconUrls(q, "crypto");
  const showQuote = pair && q && q !== b;

  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      <Glyph label={b} urls={baseUrls} size={size} />
      {showQuote && (
        <span style={{ marginLeft: -size * 0.32 }}>
          <Glyph label={q} urls={quoteUrls} size={size * 0.82} />
        </span>
      )}
    </span>
  );
}
