"use client";

// Minimal 1Shot live-proof page. One button runs the full delegated-execution pipeline on Arbitrum
// One via MetaMask: connect + SIWE -> build EIP-7702 smart account -> sign a scoped delegation to the
// 1Shot relayer -> sign the 7702 authorization -> submit a tiny USDC self-transfer (only the ~$0.015
// fee actually leaves) -> poll status. Proves whether the 1Shot relayer redeems on-chain.

import { useCallback, useEffect, useState } from "react";
import { getAddress } from "viem";
import { siweSignIn, isWalletRuntimeAvailable } from "@/lib/netrunners/metamask-auth";
import { hasOwnerSession } from "@/lib/netrunners/session";
import { runOneShotLiveTest, runBackendOneShotTest, pollOneShotStatus, type OneShotTestResult } from "@/lib/wallet/smart-account";

const STATUS_LABEL: Record<number, string> = { 100: "pending", 110: "submitted", 200: "confirmed", 400: "rejected", 500: "reverted" };

export default function OneShotTestPage() {
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<OneShotTestResult | null>(null);
  const [status, setStatus] = useState<{ code?: number; hash?: string; raw?: string } | null>(null);

  const push = useCallback((m: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()}  ${m}`]), []);

  useEffect(() => { if (hasOwnerSession()) setAddress("(session active)"); }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    try { const a = await siweSignIn(); setAddress(getAddress(a)); push(`Signed in: ${a}`); }
    catch (e) { push(`Connect failed: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }, [push]);

  // Reliable canonical proof: runs the full pipeline server-side (signer-agnostic local signer), which
  // works without MetaMask's delegation-signing restriction. Confirms on-chain by the USDC delta.
  const runBackend = useCallback(async () => {
    if (!hasOwnerSession()) { push("Connect / sign in first."); return; }
    setBusy(true); setResult(null); setStatus(null);
    push("Running canonical 1Shot pipeline (MetaMask SA → EIP-7710 delegation → estimate7710 → send)…");
    const r = await runBackendOneShotTest(0.05);
    if (!r.ok) { push(`Failed: ${r.error}`); setBusy(false); return; }
    setResult({ ok: true, taskId: r.taskId, feeUsdc: r.feeUsdc, selfTransferUsdc: 0.05 });
    push(`Submitted · taskId ${r.taskId} · fee ${r.feeUsdc} USDC (gas paid in USDC).`);
    if (r.landed) { setStatus({ code: 200 }); push(`LANDED on-chain ✓ USDC Δ ${r.deltaUsdc} (the relayer fee). 1Shot is working.`); }
    else push("Submitted but not yet confirmed on-chain — check the relay tasks / arbiscan.");
    setBusy(false);
  }, [push]);

  // Browser MetaMask path (ERC-7715 / Advanced Permissions territory). MetaMask blocks dapps from
  // signing raw delegations for internal accounts, so this needs Flask/ERC-7715 to work.
  const runMetaMask = useCallback(async () => {
    if (!address || address.startsWith("(")) { push("Connect MetaMask first."); return; }
    setBusy(true); setResult(null); setStatus(null);
    push("Browser path: building 7702 SA + delegation (MetaMask will prompt to sign)…");
    const r = await runOneShotLiveTest(address as `0x${string}`, 0.05);
    setResult(r);
    if (!r.ok) { push(`Submit failed: ${r.error}`); setBusy(false); return; }
    push(`Submitted to 1Shot · taskId ${r.taskId} · fee ≈ ${r.feeUsdc} USDC.`);
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const s = await pollOneShotStatus(r.taskId!).catch(() => ({ live: undefined, ledger: null }));
      const code = s.ledger?.status; const hash = s.ledger?.tx_hash;
      setStatus({ code, hash, raw: JSON.stringify(s.live).slice(0, 200) });
      if (code != null) push(`status: ${STATUS_LABEL[code] ?? code}${hash ? ` · tx ${hash}` : ""}`);
      if (code != null && code >= 200) break;
    }
    setBusy(false);
  }, [address, push]);

  if (typeof window !== "undefined" && !isWalletRuntimeAvailable()) {
    return <main style={wrap}><h1 style={h1}>1Shot live test</h1><p>Requires HTTPS + MetaMask (injected wallet).</p></main>;
  }

  return (
    <main style={wrap}>
      <h1 style={h1}>1Shot relayer · live proof</h1>
      <p style={{ color: "#9aa", maxWidth: 640 }}>
        Runs a real Arbitrum One delegated execution through the 1Shot permissionless relayer with gas
        paid in USDC. Submits a tiny <b>0.05 USDC self-transfer</b> — only the ~$0.015 relayer fee
        actually leaves your wallet. MetaMask will prompt to sign a delegation and a 7702 authorization.
      </p>

      <div style={{ display: "flex", gap: 12, margin: "18px 0", flexWrap: "wrap" }}>
        <button style={btn} onClick={connect} disabled={busy}>{address && !address.startsWith("(") ? `Connected ${address.slice(0, 6)}…${address.slice(-4)}` : "Connect MetaMask"}</button>
        <button style={{ ...btn, background: "#16a34a" }} onClick={runBackend} disabled={busy || !address}>{busy ? "Running…" : "Run 1Shot test (canonical · ≤0.5 USDC)"}</button>
        <button style={btn} onClick={runMetaMask} disabled={busy || !address} title="Needs MetaMask Flask / ERC-7715 — MetaMask blocks dapps from signing delegations for normal accounts">Browser MetaMask path (ERC-7715)</button>
      </div>

      {result?.ok ? (
        <div style={card}>
          <div><b>TaskId:</b> <span style={mono}>{result.taskId}</span></div>
          <div><b>Relayer:</b> <span style={mono}>{result.relayerTarget}</span></div>
          <div><b>Fee:</b> {result.feeUsdc} USDC · <b>Self-transfer:</b> {result.selfTransferUsdc} USDC</div>
          {status?.code != null ? <div><b>Status:</b> {STATUS_LABEL[status.code] ?? status.code}{status.hash ? <> · <a style={{ color: "#6cf" }} href={`https://arbiscan.io/tx/${status.hash}`} target="_blank" rel="noreferrer">tx ↗</a></> : null}</div> : null}
        </div>
      ) : null}

      <pre style={logBox}>{log.join("\n") || "Logs will appear here."}</pre>
    </main>
  );
}

const wrap: React.CSSProperties = { minHeight: "100vh", background: "#0a0a0a", color: "#e5e7eb", padding: 32, fontFamily: "ui-monospace, monospace" };
const h1: React.CSSProperties = { fontSize: 22, marginBottom: 8 };
const btn: React.CSSProperties = { padding: "10px 16px", borderRadius: 8, border: "1px solid #333", background: "#1f2937", color: "#fff", cursor: "pointer" };
const card: React.CSSProperties = { border: "1px solid #234", borderRadius: 10, padding: 16, margin: "12px 0", lineHeight: 1.8, fontSize: 14 };
const mono: React.CSSProperties = { fontFamily: "ui-monospace, monospace", color: "#9cf" };
const logBox: React.CSSProperties = { marginTop: 16, background: "#000", border: "1px solid #222", borderRadius: 8, padding: 14, fontSize: 12, color: "#8f8", whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto" };
