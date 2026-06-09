/* §25 P1.3 — Privy login UI for the Netrunner frontend (Next.js).
 *
 * DROP-IN (not compiled until enabled — rename to privy-auth.tsx after step 1):
 *   1. npm install @privy-io/react-auth
 *   2. set NEXT_PUBLIC_PRIVY_APP_ID (browser) + NETRUNNERS_API_URL (server proxy target)
 *   3. wrap the app in <NetrunnersPrivyProvider> (e.g. in src/app/layout.tsx) and render
 *      <NetrunnersAuthBar/>; route all API calls through `netrunnersFetch` so the browser's Privy
 *      access token rides as `x-privy-token` — the proxy exchanges it via /auth/session (already
 *      implemented in src/app/api/netrunners/[...path]/route.ts) and forwards the internal token.
 *
 * The browser never holds the internal owner token; the proxy does. Logout calls /auth/logout
 * (revokes outstanding tokens server-side) then Privy logout.
 */
"use client";

import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { defineChain } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { useCallback, useEffect } from "react";
import { getFreshPrivyToken, registerPrivyTokenFetcher, setPrivyToken } from "@/lib/netrunners/privy-token";

// This app executes on TESTNET chains only — Arbitrum Sepolia (chain 421614, primary testnet
// execution) and Robinhood Chain Testnet (chain 46630, stock-token demo). Arbitrum One (42161) is
// real-market-data ONLY and is intentionally never a wallet/execution chain here.
// Robinhood Chain Testnet is an Arbitrum Orbit L2 not shipped in viem/chains, so we define it.
const robinhoodChainTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.chain.robinhood.com"],
      webSocket: ["wss://feed.testnet.chain.robinhood.com"],
    },
  },
  blockExplorers: {
    default: { name: "Robinhood Testnet Explorer", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  testnet: true,
});

// Default execution chain is Arbitrum Sepolia; Robinhood Chain Testnet is selectable for the
// stock-token demo flows.
const DEFAULT_CHAIN = arbitrumSepolia;
const SUPPORTED_CHAINS = [arbitrumSepolia, robinhoodChainTestnet];

export { setPrivyToken };

/** fetch wrapper: attaches a *fresh* Privy access token so the Next proxy can token-exchange it.
 *  Refreshes the token before the request (Privy rotates ~hourly) and, if the proxy still returns
 *  401 (stale-token exchange failed), forces one more refresh and retries once. */
export async function netrunnersFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string | null): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) headers.set("x-privy-token", token);
    else headers.delete("x-privy-token");
    return fetch(input, { ...init, headers, cache: "no-store" });
  };
  const res = await send(await getFreshPrivyToken());
  if (res.status !== 401) return res;
  return send(await getFreshPrivyToken());
}

export function NetrunnersPrivyProvider({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) {
    // Fail visibly in dev rather than silently running unauthenticated.
    return <>{children}</>;
  }
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        // Testnet execution only — Arbitrum Sepolia by default, Robinhood Chain Testnet supported.
        defaultChain: DEFAULT_CHAIN,
        supportedChains: SUPPORTED_CHAINS,
        appearance: { theme: "dark" },
      }}
    >
      {children}
    </PrivyProvider>
  );
}

export function NetrunnersAuthBar() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();

  // Register Privy's getAccessToken() as the fresh-token source while authenticated so the API
  // layer can refresh on demand instead of replaying the login-time token. Cleared on logout/unmount.
  useEffect(() => {
    registerPrivyTokenFetcher(authenticated ? () => getAccessToken() : null);
    return () => registerPrivyTokenFetcher(null);
  }, [authenticated, getAccessToken]);

  const refreshToken = useCallback(async () => {
    const t = await getAccessToken();
    setPrivyToken(t ?? null);
    return t;
  }, [getAccessToken]);

  const onLogin = useCallback(async () => {
    await login();
    await refreshToken();
  }, [login, refreshToken]);

  const onLogout = useCallback(async () => {
    // Revoke server-side first (bumps auth:ver -> outstanding owner tokens die), then Privy logout.
    try { await netrunnersFetch("/api/netrunners/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    setPrivyToken(null);
    await logout();
  }, [logout]);

  if (!ready) return <span>…</span>;
  if (!authenticated) {
    return <button onClick={onLogin}>Log in / Connect wallet</button>;
  }
  const label = user?.email?.address ?? user?.wallet?.address ?? "signed in";
  return (
    <span>
      {label} <button onClick={onLogout}>Log out</button>
    </span>
  );
}
