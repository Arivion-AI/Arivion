// Framework-free holder for the internal owner JWT obtained from SIWE sign-in (POST /auth/session).
// Replaces the old Privy-access-token holder: after the MetaMask SIWE handshake the browser holds
// the owner token DIRECTLY and attaches it as `x-owner-token` so the Next proxy forwards it as a
// Bearer (no server-side token-exchange anymore). The owner token is long-lived (12h) and revocable
// server-side via /auth/logout (bumps auth:ver), so persisting it in localStorage is safe and keeps
// the session across reloads.
//
// CONTRACT: browser-only. Module-global state; in a server (SSR / route handler) process it would be
// shared across every request/user, so the setter no-ops off the browser and the getter returns null
// there — an accidental server-side import can never leak one user's token to another.

const STORAGE_KEY = "arivion.ownerToken";
let current: string | null = null;
let hydrated = false;

function hydrate(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    current = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    current = null;
  }
}

export function setOwnerToken(t: string | null): void {
  if (typeof window === "undefined") return; // never store a per-user token in a server process
  current = t;
  try {
    if (t) window.localStorage.setItem(STORAGE_KEY, t);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private-mode / storage disabled: keep the in-memory token */
  }
}

export function getOwnerToken(): string | null {
  if (typeof window === "undefined") return null;
  hydrate();
  return current;
}

export function clearOwnerToken(): void {
  setOwnerToken(null);
}

export function hasOwnerSession(): boolean {
  return Boolean(getOwnerToken());
}
