// §25 — framework-free holder for the current Privy access token. The client auth component sets
// it on login (getAccessToken); the API layer reads it to attach `x-privy-token` so the Next proxy
// can token-exchange it via /auth/session. No React/Privy import here, so it's safe to import from
// both client and server modules.
//
// CONTRACT: browser-only. This is module-global state; in a server (SSR / route handler) process it
// would be shared across every request/user, so it must never hold a per-user token there. The
// setter is hard-guarded to no-op off the browser and the getter returns null on the server, so an
// accidental server-side import can never leak one user's token to another.
let current: string | null = null;
export function setPrivyToken(t: string | null): void {
  if (typeof window === "undefined") return; // never store a per-user token in a server process
  current = t;
}
export function getPrivyToken(): string | null {
  return typeof window === "undefined" ? null : current;
}

// Privy access tokens expire (~1h). The auth component registers Privy's getAccessToken() here so
// the API layer can fetch a *fresh* token before each request (Privy refreshes it transparently
// when near expiry) instead of replaying the stale token captured at login. Registered only while
// authenticated; cleared on logout/unmount. Browser-only, same contract as above.
type TokenFetcher = () => Promise<string | null>;
let fetcher: TokenFetcher | null = null;

export function registerPrivyTokenFetcher(fn: TokenFetcher | null): void {
  if (typeof window === "undefined") return;
  fetcher = fn;
}

/** Return a fresh Privy access token, refreshing via the registered fetcher when available.
 *  Falls back to the last cached token if no fetcher is registered or the refresh throws. */
export async function getFreshPrivyToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (!fetcher) return current;
  try {
    current = await fetcher();
  } catch {
    /* keep the last-known token rather than dropping auth on a transient refresh error */
  }
  return current;
}
