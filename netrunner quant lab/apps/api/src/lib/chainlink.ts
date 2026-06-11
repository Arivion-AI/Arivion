// Unified on-chain Data Feed layer.
//  • Crypto (ETH/BTC/USDC/…): GENUINE Chainlink AggregatorV3 feeds on Arbitrum Sepolia (421614) — read
//    latestRoundData()/decimals() via JSON-RPC, with the canonical consumer validity checks.
//  • Equities (TSLA/AMZN/…): Chainlink ships NO tokenized-equity feed on these testnets, so the internal
//    stock market is priced by the DualityStockVault oracle on Robinhood Chain (46630). That oracle is
//    AggregatorV3-COMPATIBLE (8-decimal USD price + updatedAt + on-chain staleness), so we read it through
//    the SAME ChainlinkPrice interface and label it `chainlink_aggv3_standin` (a documented Chainlink
//    Data Streams stand-in) — never as a genuine Chainlink feed. Same code path, honest provenance.

import { Contract, JsonRpcProvider } from "ethers";

const ARB_SEPOLIA_RPC = () => process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";

// Verified Arbitrum Sepolia aggregator proxies (8-decimal USD feeds).
export const CHAINLINK_FEEDS: Record<string, string> = {
  "ETH/USD": "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165",
  "BTC/USD": "0x56a43EB56Da12C0dc1D972ACb089c06a5dEF8e69",
  "USDC/USD": "0x0153002d20B96532C639313c2d54c3dA09109309",
  "LINK/USD": "0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298",
  "ARB/USD": "0xD1092a65338d049DB68D7Be6bD89d17a0929945e",
  "DAI/USD": "0xb113F5A928BCfF189C998ab20d753a47F9dE5A61",
  "USDT/USD": "0x80EDee6f667eCc9f63a0a6f55578F870651f06A4",
};

const SEL_DECIMALS = "0x313ce567";       // decimals()
const SEL_LATEST_ROUND = "0xfeaf968c";   // latestRoundData()

// Public testnet RPCs (e.g. sepolia-rollup.arbitrum.io) reject requests with no User-Agent (HTTP 403),
// which would silently break every feed read. Always send a UA + accept header.
async function ethCall(to: string, data: string): Promise<string> {
  const res = await fetch(ARB_SEPOLIA_RPC(), {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json", "user-agent": "duality-lab/chainlink" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} for eth_call`);
  const j = (await res.json()) as { result?: string; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message || "eth_call error");
  if (!j.result || j.result === "0x") throw new Error("empty eth_call result (feed may be wrong address/chain)");
  return j.result;
}

// Decode a 32-byte hex word as a signed int256 (Chainlink answer is int256, not uint).
function toSignedBigInt(word: string): bigint {
  const v = BigInt("0x" + word);
  return v >> 255n ? v - (1n << 256n) : v;
}

const STALE_AFTER_SECONDS = Number(process.env.CHAINLINK_STALE_SECONDS ?? 3 * 3600);
const PRICE_TTL_MS = Number(process.env.CHAINLINK_CACHE_MS ?? 30_000);

// decimals() is immutable per aggregator → cache forever. Prices → short TTL to avoid RPC spam.
const decimalsCache = new Map<string, number>();
const priceCache = new Map<string, { at: number; value: ChainlinkPrice }>();

async function feedDecimals(feed: string): Promise<number> {
  const cached = decimalsCache.get(feed);
  if (cached != null) return cached;
  const d = parseInt(await ethCall(feed, SEL_DECIMALS), 16);
  if (!Number.isFinite(d) || d <= 0 || d > 36) throw new Error(`bad decimals() for feed ${feed}`);
  decimalsCache.set(feed, d);
  return d;
}

export function normalizeSymbol(input: string): string {
  const s = input.trim().toUpperCase().replace(/USDT?$/i, "").replace(/[^A-Z0-9]/g, "");
  return CHAINLINK_FEEDS[`${s}/USD`] ? `${s}/USD` : (CHAINLINK_FEEDS[input.toUpperCase()] ? input.toUpperCase() : `${s}/USD`);
}

export interface ChainlinkPrice {
  symbol: string;
  feed: string;
  chainId: number;
  priceUsd: number;
  decimals: number;
  roundId: string;
  answeredInRound: string;
  updatedAt: string;
  stale: boolean;
  source: "chainlink" | "chainlink_aggv3_standin";
}

export async function readChainlink(symbolOrPair: string): Promise<ChainlinkPrice> {
  const pair = normalizeSymbol(symbolOrPair);
  const feed = CHAINLINK_FEEDS[pair];
  if (!feed) throw new Error(`no Chainlink feed for ${pair} on Arbitrum Sepolia (available: ${Object.keys(CHAINLINK_FEEDS).join(", ")})`);

  const cached = priceCache.get(pair);
  if (cached && Date.now() - cached.at < PRICE_TTL_MS) return cached.value;

  const decimals = await feedDecimals(feed);
  const r = (await ethCall(feed, SEL_LATEST_ROUND)).slice(2); // strip 0x; 5 × 32-byte words
  if (r.length < 320) throw new Error(`malformed latestRoundData() for ${pair}`);
  const roundId = BigInt("0x" + r.slice(0, 64));
  const answer = toSignedBigInt(r.slice(64, 128));
  const updatedAt = Number(BigInt("0x" + r.slice(192, 256)));
  const answeredInRound = BigInt("0x" + r.slice(256, 320));
  // Canonical Chainlink consumer checks — never trust a non-positive answer or an incomplete round.
  if (answer <= 0n) throw new Error(`invalid Chainlink answer (<= 0) for ${pair}`);
  if (updatedAt === 0) throw new Error(`incomplete Chainlink round for ${pair} (updatedAt = 0)`);
  if (answeredInRound < roundId) throw new Error(`stale Chainlink round for ${pair} (answeredInRound < roundId)`);

  const priceUsd = Number(answer) / 10 ** decimals;
  const value: ChainlinkPrice = {
    symbol: pair, feed, chainId: 421614, priceUsd, decimals,
    roundId: roundId.toString(), answeredInRound: answeredInRound.toString(),
    updatedAt: new Date(updatedAt * 1000).toISOString(),
    stale: Date.now() / 1000 - updatedAt > STALE_AFTER_SECONDS, // testnet feeds update slower
    source: "chainlink",
  };
  priceCache.set(pair, { at: Date.now(), value });
  return value;
}

/** Best-effort USD reference for a symbol — returns the full feed read or null (never throws).
 *  Use this to ANNOTATE/validate execution against the on-chain oracle without breaking the flow. */
export async function chainlinkReference(symbolOrPair: string): Promise<ChainlinkPrice | null> {
  try { return await readChainlink(symbolOrPair); } catch { return null; }
}

export async function readChainlinkMany(symbols: string[]): Promise<{ prices: ChainlinkPrice[]; errors: Record<string, string> }> {
  const prices: ChainlinkPrice[] = [];
  const errors: Record<string, string> = {};
  await Promise.all(symbols.map(async (s) => {
    try { prices.push(await readChainlink(s)); } catch (e) { errors[s] = (e as Error).message; }
  }));
  return { prices, errors };
}

// ---- Internal stock market: Chainlink AggregatorV3-compatible stand-in (Robinhood Chain 46630) -------
// The DualityStockVault prices each tokenized equity in 8-decimal USD with an on-chain updatedAt and a
// staleness flag — the same shape Chainlink exposes — so we read it through the ChainlinkPrice interface.

const RH_CHAIN_ID = 46630;
const RH_RPC = () => process.env.ROBINHOOD_TESTNET_ALCHEMY_RPC_URL || process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const STOCK_VAULT = () => process.env.DUALITY_STOCK_VAULT_ADDRESS || "";
const VAULT_PRICE_ABI = ["function priceOf(string) view returns (uint256 priceUsd1e8, uint64 updatedAt, bool fresh)"];

// The deployed Robinhood-testnet stock set (mirrors apps/agent ROBINHOOD_STOCKS).
export const STOCK_FEED_SYMBOLS = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];

export function normalizeStockSymbol(input: string): string {
  let s = input.trim().toUpperCase().replace(/\/USD$/, "").replace(/[^A-Z]/g, "");
  if (s.startsWith("D") && STOCK_FEED_SYMBOLS.includes(s.slice(1))) s = s.slice(1); // dTSLA -> TSLA
  return s;
}

export function isStockSymbol(input: string): boolean {
  return STOCK_FEED_SYMBOLS.includes(normalizeStockSymbol(input));
}

const stockPriceCache = new Map<string, { at: number; value: ChainlinkPrice }>();

export async function readStockFeed(symbol: string): Promise<ChainlinkPrice> {
  const sym = normalizeStockSymbol(symbol);
  if (!STOCK_FEED_SYMBOLS.includes(sym)) throw new Error(`no stock feed for ${sym} (available: ${STOCK_FEED_SYMBOLS.join(", ")})`);
  const vault = STOCK_VAULT();
  if (!vault) throw new Error("stock vault not configured (DUALITY_STOCK_VAULT_ADDRESS)");

  const cached = stockPriceCache.get(sym);
  if (cached && Date.now() - cached.at < PRICE_TTL_MS) return cached.value;

  const provider = new JsonRpcProvider(RH_RPC(), RH_CHAIN_ID, { staticNetwork: true });
  const c = new Contract(vault, VAULT_PRICE_ABI, provider);
  const [priceUsd1e8, updatedAt, fresh] = (await c.priceOf(sym)) as [bigint, bigint, boolean];
  if (priceUsd1e8 <= 0n) throw new Error(`invalid stock oracle price (<= 0) for ${sym}`);
  const upd = Number(updatedAt);
  const value: ChainlinkPrice = {
    symbol: `${sym}/USD`, feed: vault, chainId: RH_CHAIN_ID,
    priceUsd: Number(priceUsd1e8) / 1e8, decimals: 8,
    roundId: String(upd), answeredInRound: String(upd),
    updatedAt: new Date(upd * 1000).toISOString(),
    stale: !fresh, source: "chainlink_aggv3_standin",
  };
  stockPriceCache.set(sym, { at: Date.now(), value });
  return value;
}

export async function readStockFeedMany(symbols: string[] = STOCK_FEED_SYMBOLS): Promise<{ prices: ChainlinkPrice[]; errors: Record<string, string> }> {
  const prices: ChainlinkPrice[] = [];
  const errors: Record<string, string> = {};
  await Promise.all(symbols.map(async (s) => {
    try { prices.push(await readStockFeed(s)); } catch (e) { errors[s] = (e as Error).message; }
  }));
  return { prices, errors };
}

/** Unified Data Feed resolver: equities → vault AggregatorV3 stand-in; everything else → Chainlink. */
export async function readFeed(symbolOrPair: string): Promise<ChainlinkPrice> {
  return isStockSymbol(symbolOrPair) ? readStockFeed(symbolOrPair) : readChainlink(symbolOrPair);
}

/** Best-effort unified reference (crypto Chainlink OR equity stand-in) — never throws. */
export async function feedReference(symbolOrPair: string): Promise<ChainlinkPrice | null> {
  try { return await readFeed(symbolOrPair); } catch { return null; }
}
