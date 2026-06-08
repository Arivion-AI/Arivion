"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PropsWithChildren, useEffect, useMemo, useState } from "react";
import { netrunnersGet, netrunnersPost, type ConcurrencyStats, type HealthResponse } from "@/lib/netrunners/api";
import { NetrunnersAuthBar } from "@/lib/netrunners/privy-auth";
import { connectInjectedWallet, hasInjectedWallet, signWalletMessage, switchOrAddChain, type WalletChain } from "@/lib/wallet/evm";

type TopbarState = {
  health: HealthResponse | null;
  concurrency: ConcurrencyStats | null;
  staleMs: number;
};

type ChainsResponse = {
  chains?: WalletChain[];
  featureFlags?: Record<string, string>;
};

type WalletNonceResponse = {
  message?: string;
  nonce?: string;
};

const NAV_ITEMS = [
  { href: "/netrunners/copilot", label: "Copilot" },
  { href: "/netrunners/markets", label: "Markets" },
  { href: "/netrunners/live-trade", label: "GMX Live" },
];

function ageToDisplay(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function NetrunnersShell({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const [state, setState] = useState<TopbarState>({
    health: null,
    concurrency: null,
    staleMs: 0,
  });
  const [chains, setChains] = useState<WalletChain[]>([]);
  const [selectedChainId, setSelectedChainId] = useState("421614");
  const [walletAddress, setWalletAddress] = useState("");
  const [walletStatus, setWalletStatus] = useState("checking wallet");

  useEffect(() => {
    setWalletStatus(hasInjectedWallet() ? "wallet ready" : "no wallet");
  }, []);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const started = Date.now();
      const [health, concurrency] = await Promise.all([
        netrunnersGet<HealthResponse>("/health"),
        netrunnersGet<ConcurrencyStats>("/api/concurrency/stats"),
      ]);
      if (!mounted) {
        return;
      }
      setState({
        health,
        concurrency,
        staleMs: Date.now() - started,
      });
    }

    load();
    const interval = setInterval(load, 8000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    netrunnersGet<ChainsResponse>("/api/chains").then((r) => {
      const rows = (r?.chains ?? []).filter((chain) => chain.capabilities?.wallet_balances || chain.capabilities?.gmx_live_trading);
      setChains(rows);
      if (rows.length && !rows.some((row) => String(row.chainId) === selectedChainId)) {
        setSelectedChainId(String(rows[0].chainId));
      }
    });
  }, [selectedChainId]);

  const isLive = useMemo(() => {
    if (!state.health) {
      return false;
    }
    return state.staleMs < 15_000;
  }, [state.health, state.staleMs]);

  async function linkWallet() {
    const chain = chains.find((row) => String(row.chainId) === selectedChainId);
    if (!chain) {
      setWalletStatus("chain unavailable");
      return;
    }
    try {
      setWalletStatus("switching chain");
      await switchOrAddChain(chain);
      const address = await connectInjectedWallet();
      setWalletStatus("sign nonce");
      const nonce = await netrunnersPost<WalletNonceResponse, Record<string, unknown>>("/api/wallets/nonce", {
        address,
        chainId: chain.chainId,
      });
      if (!nonce?.message) throw new Error("Backend did not return a nonce message.");
      const signature = await signWalletMessage(address, nonce.message);
      const verified = await netrunnersPost<{ wallet?: { wallet_address?: string } }, Record<string, unknown>>("/api/wallets/verify", {
        address,
        chainId: chain.chainId,
        message: nonce.message,
        signature,
      });
      const linked = verified?.wallet?.wallet_address ?? address;
      setWalletAddress(linked);
      setWalletStatus(`linked ${linked.slice(0, 6)}...${linked.slice(-4)}`);
    } catch (error) {
      setWalletStatus((error as Error).message.slice(0, 42));
    }
  }

  return (
    <div className="netrunners-root">
      <div className="netrunners-shell">
        <div className="netrunners-grid">
          <header className="nt-topbar">
            <div className="nt-wordmark">
              DUALITY
              <small>NETRUNNER · QUANT LAB</small>
            </div>
            <div className="nt-tridot" aria-hidden="true">
              <i />
              <i className="fill" />
              <i />
            </div>
            <nav className="nt-nav" aria-label="Netrunners pages">
              {NAV_ITEMS.map((item) => {
                const isOn = pathname === item.href || (pathname === "/netrunners" && item.href === "/netrunners/copilot");
                return (
                  <Link key={item.href} href={item.href} className={isOn ? "on" : ""}>
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="nt-statuschip">
              <span className={`nt-live-led ${isLive ? "" : "degraded"}`} />
              SSE LIVE · {ageToDisplay(state.staleMs)}
            </div>
            <div className="nt-statuschip">
              DEFCON {isLive ? "1" : "2"} · OWNER {state.concurrency?.owner_inflight ?? 0}/{state.concurrency?.owner_cap ?? 0}
            </div>
            <div className="nt-statuschip nt-wallet-chip">
              <select
                aria-label="Wallet chain"
                value={selectedChainId}
                onChange={(e) => setSelectedChainId(e.target.value)}
              >
                {chains.length === 0 ? <option value={selectedChainId}>TESTNET</option> : chains.map((chain) => (
                  <option key={chain.chainId} value={chain.chainId}>{chain.chainId === 46630 ? "RH TEST" : chain.name.replace("Arbitrum ", "ARB ")}</option>
                ))}
              </select>
              <button type="button" onClick={linkWallet}>{walletAddress ? "WALLET LINKED" : "LINK WALLET"}</button>
              <span>{walletStatus}</span>
            </div>
            <div className="nt-statuschip">
              <NetrunnersAuthBar />
            </div>
          </header>
          {children}
        </div>
      </div>
    </div>
  );
}
