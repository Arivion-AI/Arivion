export const dynamic = "force-dynamic";

type DexPair = {
  baseToken?: { symbol?: string };
  quoteToken?: { symbol?: string };
  info?: { imageUrl?: string };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
};

type DexProfile = {
  icon?: string;
  tokenAddress?: string;
  chainId?: string;
  url?: string;
};

const DEX_BASE = "https://api.dexscreener.com";
const CACHE_SECONDS = 60 * 60 * 12;

function cleanSymbol(raw: string | null): string {
  return (raw ?? "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\/USD.*/i, "")
    .replace(/USDT?$/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 24);
}

function imageResponse(url: string): Response {
  return Response.redirect(url, 307);
}

async function searchDexScreener(symbol: string): Promise<string | null> {
  const res = await fetch(`${DEX_BASE}/latest/dex/search?q=${encodeURIComponent(symbol)}`, {
    headers: { accept: "application/json" },
    next: { revalidate: CACHE_SECONDS },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { pairs?: DexPair[] };
  const pairs = (json.pairs ?? [])
    .filter((p) => String(p.baseToken?.symbol ?? "").toUpperCase() === symbol && p.info?.imageUrl)
    .sort((a, b) => Number(b.liquidity?.usd ?? b.volume?.h24 ?? 0) - Number(a.liquidity?.usd ?? a.volume?.h24 ?? 0));
  return pairs[0]?.info?.imageUrl ?? null;
}

type CgCoin = { id?: string; symbol?: string; large?: string; thumb?: string };

// CoinGecko search returns icon URLs directly and covers most listed assets — the catch-all for
// newer tokens (HYPE, TAO, …) that the static icon set and DexScreener pair search both miss.
async function coingeckoIcon(symbol: string): Promise<string | null> {
  const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`, {
    headers: { accept: "application/json" },
    next: { revalidate: CACHE_SECONDS },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { coins?: CgCoin[] };
  const coins = json.coins ?? [];
  const exact = coins.find((c) => String(c.symbol ?? "").toUpperCase() === symbol);
  const pick = exact ?? coins[0];
  return pick?.large ?? pick?.thumb ?? null;
}

async function latestProfileIcon(symbol: string): Promise<string | null> {
  const res = await fetch(`${DEX_BASE}/token-profiles/latest/v1`, {
    headers: { accept: "application/json" },
    next: { revalidate: CACHE_SECONDS },
  });
  if (!res.ok) return null;
  const profiles = (await res.json()) as DexProfile[];
  const maybe = profiles.find((p) => {
    const text = `${p.url ?? ""} ${p.tokenAddress ?? ""}`.toUpperCase();
    return Boolean(p.icon) && text.includes(symbol);
  });
  return maybe?.icon ?? null;
}

export async function GET(req: Request): Promise<Response> {
  const symbol = cleanSymbol(new URL(req.url).searchParams.get("symbol"));
  if (!symbol || symbol.length < 2) return new Response(null, { status: 404 });

  try {
    const icon = (await searchDexScreener(symbol)) ?? (await coingeckoIcon(symbol)) ?? (await latestProfileIcon(symbol));
    if (!icon) return new Response(null, { status: 404, headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}` } });
    const url = new URL(icon);
    if (!["https:", "http:"].includes(url.protocol)) return new Response(null, { status: 404 });
    const response = imageResponse(url.toString());
    response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
    return response;
  } catch {
    return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=3600" } });
  }
}
