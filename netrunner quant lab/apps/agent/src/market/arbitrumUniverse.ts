import { config } from "../config.js";
import { getGmxTokens } from "../onchain/gmx/client.js";
import { logger } from "../logger.js";

// ARBITRUM COIN UNIVERSE — the allowlist that scopes every crypto coin-listing surface (movers,
// laggards, market overview/breadth, screener) to coins you can actually get exposure to ON ARBITRUM.
// It is built ENTIRELY from GMX v2's live Arbitrum token list — 100% of its listed tokens, no
// exclusions (XAUT, GLV, wrapped forms all kept) and nothing hardcoded. GMX is the only integrated
// venue today; other-DEX breadth (GeckoTerminal/Uniswap) is intentionally deferred until those lanes
// are wired in. Bybit supplies the 24h price tape; the intersection of (this universe) ∩ (Bybit
// tickers) is what we surface — symbols that never match a Bybit base (GLV vault tokens, wrapped/
// versioned forms) simply drop out at the intersection, so keeping them costs nothing.

const TTL_MS = config.arbUniverseTtlMs;
// Last-known-good: if a refresh fails we keep serving the previous live set rather than emptying the
// movers/laggards (honest-by-construction — a dark source never fabricates, but it also never erases
// what we already learned from a prior successful fetch).
let cache: { at: number; set: Set<string> } | null = null;

// The set of base symbols (uppercase) tradeable on Arbitrum — 100% of GMX's listed tokens.
export async function getArbitrumUniverse(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.set;
  try {
    const idx = await getGmxTokens();
    const set = new Set<string>([...idx.bySym.keys()].map((s) => s.toUpperCase()));
    if (set.size) {
      cache = { at: Date.now(), set };
      return set;
    }
  } catch (e) {
    logger.warn("arbitrum universe: GMX token list unavailable", { message: (e as Error).message });
  }
  // GMX dark: serve the last good set if we have one, else an empty set (the filter falls open so we
  // never silently hide the whole market on a transient outage).
  if (cache) {
    logger.warn("arbitrum universe: GMX dark, serving last-known-good set", { size: cache.set.size });
    return cache.set;
  }
  logger.warn("arbitrum universe: GMX dark on cold start, filter will fall open this cycle");
  return new Set<string>();
}
