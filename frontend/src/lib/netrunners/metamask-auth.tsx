/* MetaMask Sign-In-With-Ethereum (EIP-4361) auth for the Netrunner frontend.
 *
 * Replaces the Privy edge. Flow: connect MetaMask (injected) -> GET /auth/nonce -> build an EIP-4361
 * message -> personal_sign -> POST /auth/session { message, signature } -> receive the internal
 * owner JWT -> store it (session.ts). Every API call then rides the owner token as `x-owner-token`
 * and the Next proxy forwards it as a Bearer. The owner JWT + revocation machinery downstream is
 * unchanged — only the front door (verification) moved from Privy ES256 to SIWE.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import { NETRUNNERS_PROXY_PREFIX } from "@/lib/netrunners/config";
import { clearOwnerToken, getOwnerToken, setOwnerToken } from "@/lib/netrunners/session";
import { connectInjectedWallet, hasInjectedWallet, signWalletMessage } from "@/lib/wallet/evm";

const ADDR_KEY = "arivion.address";
// Arbitrum One — the SIWE message states the chain truthfully; the backend doesn't gate on it.
const SIWE_CHAIN_ID = 42161;

export function isWalletRuntimeAvailable(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && hasInjectedWallet();
}

/** Run the full connect + SIWE handshake. Returns the authenticated address, or throws. */
export async function siweSignIn(): Promise<string> {
  const rawAddress = await connectInjectedWallet();
  const address = getAddress(rawAddress);

  // 1) one-time nonce from the Lab API (through the proxy).
  const nonceRes = await fetch(`${NETRUNNERS_PROXY_PREFIX}/auth/nonce`, { cache: "no-store" });
  if (!nonceRes.ok) throw new Error("Could not fetch sign-in nonce.");
  const { nonce } = (await nonceRes.json()) as { nonce?: string };
  if (!nonce) throw new Error("Malformed nonce response.");

  // 2) EIP-4361 message + personal_sign (via the shared injected-wallet helper).
  const message = createSiweMessage({
    address,
    chainId: SIWE_CHAIN_ID,
    domain: window.location.host,
    nonce,
    uri: window.location.origin,
    version: "1",
    statement: "Sign in to Arivion. This signature proves wallet ownership; it does not authorize any transaction.",
  });
  const signature = await signWalletMessage(address, message);

  // 3) exchange for the internal owner JWT.
  const sessRes = await fetch(`${NETRUNNERS_PROXY_PREFIX}/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature }),
    cache: "no-store",
  });
  if (!sessRes.ok) {
    const body = (await sessRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(`Sign-in failed: ${body.error ?? sessRes.status}`);
  }
  const { ownerToken } = (await sessRes.json()) as { ownerToken?: string };
  if (!ownerToken) throw new Error("Sign-in returned no token.");
  setOwnerToken(ownerToken);
  try { window.localStorage.setItem(ADDR_KEY, address); } catch { /* ignore */ }
  return address;
}

export async function siweSignOut(): Promise<void> {
  // Revoke server-side first (bumps auth:ver -> outstanding owner tokens die), then drop locally.
  try {
    await netrunnersFetch(`${NETRUNNERS_PROXY_PREFIX}/auth/logout`, { method: "POST" });
  } catch { /* ignore */ }
  clearOwnerToken();
  try { window.localStorage.removeItem(ADDR_KEY); } catch { /* ignore */ }
}

/** fetch wrapper: attaches the owner JWT as `x-owner-token`. On 401 the token is stale/revoked —
 *  clear it so the UI prompts a fresh sign-in. */
export async function netrunnersFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const tok = getOwnerToken();
  if (tok) headers.set("x-owner-token", tok);
  const res = await fetch(input, { ...init, headers, cache: "no-store" });
  if (res.status === 401) clearOwnerToken();
  return res;
}

// --- React context ---------------------------------------------------------------------------
interface AuthState {
  ready: boolean;
  authenticated: boolean;
  address: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function NetrunnersWalletProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    // Rehydrate an existing session on mount.
    if (getOwnerToken()) {
      try { setAddress(window.localStorage.getItem(ADDR_KEY)); } catch { /* ignore */ }
    }
    setReady(true);
  }, []);

  const signIn = useCallback(async () => {
    const addr = await siweSignIn();
    setAddress(addr);
  }, []);

  const signOut = useCallback(async () => {
    await siweSignOut();
    setAddress(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ ready, authenticated: Boolean(address), address, signIn, signOut }),
    [ready, address, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useNetrunnersAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (ctx) return ctx;
  // Fallback for components rendered outside the provider (keeps them resilient).
  return { ready: true, authenticated: false, address: null, signIn: async () => {}, signOut: async () => {} };
}

export function NetrunnersAuthBar() {
  if (typeof window !== "undefined" && !isWalletRuntimeAvailable()) {
    return <span>Wallet auth requires HTTPS + MetaMask</span>;
  }
  return <NetrunnersAuthBarInner />;
}

function NetrunnersAuthBarInner() {
  const { ready, authenticated, address, signIn, signOut } = useNetrunnersAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onLogin = useCallback(async () => {
    setBusy(true); setErr(null);
    try { await signIn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [signIn]);

  const onLogout = useCallback(async () => {
    setBusy(true);
    try { await signOut(); } finally { setBusy(false); }
  }, [signOut]);

  if (!ready) return <span>…</span>;
  if (!authenticated) {
    return (
      <span>
        <button onClick={onLogin} disabled={busy}>{busy ? "Signing in…" : "Connect MetaMask"}</button>
        {err ? <span style={{ marginLeft: 8, color: "#f87171" }}>{err}</span> : null}
      </span>
    );
  }
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "signed in";
  return (
    <span>
      {short} <button onClick={onLogout} disabled={busy}>Log out</button>
    </span>
  );
}
