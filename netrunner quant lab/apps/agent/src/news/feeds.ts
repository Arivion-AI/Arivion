import { config } from "../config.js";
import { logger } from "../logger.js";

// Phase 19 — token news from TRUSTED, OPEN RSS feeds (CoinDesk, Cointelegraph, CryptoSlate, Bitcoin
// Magazine, Decrypt — primary outlets, free, no API key). We fetch the feeds, filter items that
// mention the requested token (name + symbol aliases), and return recent, de-duplicated headlines.
// The text is UNTRUSTED data — the analyst/LLM that consumes it is instructed to treat it as data,
// never as instructions (the same injection posture as web research).

export interface NewsItem {
  title: string;
  source: string;
  published: string | null;
  published_ms: number;
  link: string;
  snippet: string;
}

export interface TokenNews {
  token: string;
  aliases: string[];
  sources_checked: number;
  sources_ok: number;
  matched: number;
  items: NewsItem[];
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ").trim();
}

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return m ? decode(m[1]) : "";
}

// Parse RSS <item> and Atom <entry> blocks from a feed body. Per-item <source> (Google News uses it)
// overrides the feed-level source so we attribute the real outlet.
function parseFeed(xml: string, source: string): NewsItem[] {
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/gi) ?? [];
  const out: NewsItem[] = [];
  for (const b of blocks) {
    const title = tag(b, "title");
    if (!title) continue;
    // Atom <link href="..."/> vs RSS <link>...</link>
    let link = tag(b, "link");
    if (!link) link = (/<link[^>]*href="([^"]+)"/i.exec(b)?.[1]) ?? "";
    const dateStr = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date");
    const ms = dateStr ? new Date(dateStr).getTime() : NaN;
    const desc = tag(b, "description") || tag(b, "summary") || tag(b, "content");
    const itemSource = tag(b, "source") || source;
    out.push({ title, source: itemSource, link, published: dateStr || null, published_ms: Number.isFinite(ms) ? ms : 0, snippet: desc.slice(0, 280) });
  }
  return out;
}

// Google News RSS search — free, open, no key; per-query coverage for ANY token (the long tail the
// major-outlet feeds miss). Each item carries the real outlet in <source>.
function googleNewsUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} crypto`)}&hl=en-US&gl=US&ceid=US:en`;
}

async function fetchFeed(url: string): Promise<NewsItem[]> {
  // A browser-like UA — some outlets (Cloudflare) reject generic agents.
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; DualityCopilot/1.0; +research)", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    redirect: "follow", signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`${resp.status}`);
  return parseFeed(await resp.text(), hostOf(url));
}

// Build match aliases from a free-text token query (+ optional symbol). e.g. ("Arbitrum","ARBUSDT")
// -> ["ARBITRUM","ARB"]. Aliases shorter than 2 chars are dropped to avoid false positives.
export function tokenAliases(query: string, symbol?: string): string[] {
  const set = new Set<string>();
  const add = (s: string) => { const v = s.trim(); if (v.length >= 2) set.add(v); };
  add(query.trim());
  if (symbol) add(symbol.toUpperCase().replace(/USDT$/, "").replace(/[^A-Z0-9]/g, ""));
  // a multi-word name's first word too (e.g. "Arbitrum One" -> "Arbitrum")
  const first = query.trim().split(/\s+/)[0];
  if (first && first !== query.trim()) add(first);
  return [...set];
}

function matches(text: string, aliases: string[]): boolean {
  for (const a of aliases) {
    const re = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

// Fetch recent news mentioning the token across the trusted feeds.
export async function fetchTokenNews(input: { query: string; symbol?: string; limit?: number }): Promise<TokenNews> {
  const aliases = tokenAliases(input.query, input.symbol);
  const limit = input.limit ?? config.newsMaxItems;
  // Curated trusted feeds (primary outlets) + a Google News per-token search (long-tail coverage for
  // any token, incl. mid-caps like Arbitrum that the headline feeds rarely carry).
  const feeds = [...config.newsFeeds, googleNewsUrl(input.query)];
  const settled = await Promise.allSettled(feeds.map((u) => fetchFeed(u)));
  let ok = 0;
  const all: NewsItem[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") { ok++; all.push(...r.value); }
    else logger.warn("news feed fetch failed", { feed: feeds[i], message: String(r.reason) });
  });
  const hit = all.filter((it) => matches(`${it.title} ${it.snippet}`, aliases));
  const seen = new Set<string>();
  const deduped = hit.filter((it) => { const k = (it.link || it.title).toLowerCase(); return seen.has(k) ? false : (seen.add(k), true); });
  deduped.sort((a, b) => b.published_ms - a.published_ms);
  return { token: input.query, aliases, sources_checked: feeds.length, sources_ok: ok, matched: deduped.length, items: deduped.slice(0, limit) };
}
