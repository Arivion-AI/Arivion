export const dynamic = "force-dynamic";

type Pair = {
  ticker_id?: string;
  base_currency?: string;
  target_currency?: string;
  product_type?: string;
  price?: string | number;
  liquidity?: string | number;
  open_interest?: string | number;
  funding_rate?: string | number;
};

const BASES = ["https://arbitrum.gmxapi.io/v1", "https://arbitrum.gmxapi.ai/v1"];

async function fetchPairs(): Promise<Pair[]> {
  let last = "";
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/pairs`, { cache: "no-store", headers: { accept: "application/json" } });
      if (!res.ok) {
        last = `${res.status} ${await res.text().catch(() => "")}`;
        continue;
      }
      const json = await res.json();
      return Array.isArray(json) ? json as Pair[] : [];
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(last || "GMX pairs unavailable");
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").toUpperCase();
  const limit = Math.max(10, Math.min(150, Number(url.searchParams.get("limit") ?? 80) || 80));
  const pairs = await fetchPairs();
  const rows = pairs
    .filter((p) => {
      const text = `${p.ticker_id ?? ""} ${p.base_currency ?? ""} ${p.target_currency ?? ""}`.toUpperCase();
      return !q || text.includes(q);
    })
    .sort((a, b) => Number(b.open_interest ?? b.liquidity ?? 0) - Number(a.open_interest ?? a.liquidity ?? 0))
    .slice(0, limit);
  return Response.json({ source: "gmx_api", pairs: rows });
}
