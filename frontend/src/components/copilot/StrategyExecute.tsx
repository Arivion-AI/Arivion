"use client";

// Compact pop-up widget (NOT a page): a LIVE cross-chain strategy as a neat card stack. One $5 plan —
// Arbitrum LP + GMX perp + bridge to Base + Base LP — funded by ONE MetaMask signature (move USDC to
// the agent's session account, no Flask), then executed by the agent via 1Shot (gas in USDC).
//
// AGENT-BUILT BY DESIGN: the user never gets a hardcoded plan — an agent assembles `plan` and hands it
// in. Until that plan arrives (and while we read the wallet balance + agent account), the widget shows
// skeleton placeholders. `DEFAULT_PLAN` is only the isolated-test fallback when no `plan` prop is given.
// Isolated test surface — does not touch the main agent.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { createPublicClient, http, parseAbi, getAddress, formatUnits } from "viem";
import { arbitrum, base } from "viem/chains";
import { TokenIcon } from "@/components/netrunners/TokenIcon";
import { netrunnersGet, netrunnersPost } from "@/lib/netrunners/api";
import { authorizeAgent } from "@/lib/wallet/smart-account";

const ARB_USDC = getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
const BASE_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
// Balance chains shown in the hero. Funding (step 1) happens on Arbitrum; Base is where bridged USDC lands.
const BAL_CHAINS = [
  { id: 42161, label: "Arbitrum", chain: arbitrum, usdc: ARB_USDC },
  { id: 8453, label: "Base", chain: base, usdc: BASE_USDC },
];
const ERC20 = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

type StepState = "idle" | "active" | "submitted" | "confirmed" | "failed";
type StepType = "fund" | "deploy" | "move";
export interface PlanStep {
  id: string; kind: string; title: string; type: StepType;
  chain: "arbitrum" | "base" | "arbitrum→base"; chainId: number; spendUsd: number; feeUsd: number;
  base?: string; quote?: string; symbol?: string; glyph?: "usdc" | "wallet" | "bridge";
  venue: string; rationale: string;
}

const BUDGET = 5;
// spend = capital handled by the step; fee = est. 1Shot/bridge gas (paid in USDC). The bridge MOVES
// $2 to Base (not extra capital) — so "deploying" counts deploy-type steps only (arb LP + GMX + base LP = $5).
// chainId is where THIS step's tx lands (the bridge burns on Arbitrum = 42161), used for the explorer link.
const DEFAULT_PLAN: PlanStep[] = [
  { id: "fund", kind: "fund", type: "fund", title: "Authorize agent (Advanced Permissions)", chain: "arbitrum", chainId: 42161, spendUsd: 5, feeUsd: 0.01, glyph: "wallet", venue: "MetaMask Smart Account · ERC-7715",
    rationale: "You grant ONE scoped MetaMask Advanced Permission (erc20-token-periodic, ≤ $5/day) in MetaMask's native popup — no USDC moves. The agent redeems it via 1Shot to spend within scope; your main wallet stays in your control." },
  { id: "arb-lp", kind: "lp_deposit", type: "deploy", title: "Provide LP · ETH / USDC", chain: "arbitrum", chainId: 42161, spendUsd: 1.5, feeUsd: 0.015, base: "ETH", quote: "USDC", venue: "Uniswap v3 · 0.05%",
    rationale: "Single-sided USDC into the ETH/USDC pool on Arbitrum, via 1Shot — gas in USDC." },
  { id: "gmx", kind: "gmx_order", type: "deploy", title: "Open perp · ETH", chain: "arbitrum", chainId: 42161, spendUsd: 1, feeUsd: 0.02, symbol: "ETH", venue: "GMX v2 · long",
    rationale: "A small ETH long on GMX v2 for directional exposure alongside the fee-earning LPs." },
  { id: "bridge", kind: "cctp_burn", type: "move", title: "Bridge USDC → Base", chain: "arbitrum→base", chainId: 42161, spendUsd: 1.5, feeUsd: 0.016, glyph: "bridge", venue: "Circle CCTP · fast",
    rationale: "Move $1.5 USDC to Base: burn on Arbitrum, Circle mints native USDC on Base (~8–20s). Relayed via 1Shot." },
  { id: "base-lp", kind: "lp_deposit", type: "deploy", title: "Provide LP · ETH / USDC", chain: "base", chainId: 8453, spendUsd: 1.4, feeUsd: 0.01, base: "ETH", quote: "USDC", venue: "Uniswap v3 · Base",
    rationale: "Deploy the bridged USDC into the ETH/USDC pool on Base (low-cost L2), via 1Shot." },
];

const CHAIN_LABEL: Record<string, string> = { arbitrum: "Arbitrum", base: "Base", "arbitrum→base": "Arb → Base" };
// Per-chain block explorer for the step's tx link.
const explorerTx = (chainId: number, hash: string) => `${chainId === 8453 ? "https://basescan.org" : "https://arbiscan.io"}/tx/${hash}`;
const STATE_PILL: Record<StepState, { cls: string; label: string }> = {
  idle: { cls: "", label: "queued" }, active: { cls: "live", label: "signing…" },
  submitted: { cls: "live", label: "relaying…" }, confirmed: { cls: "ok", label: "done" }, failed: { cls: "warn", label: "failed" },
};

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

// Circle's brand mark — used to label the CCTP bridge leg as a first-class, recognizable provider.
function CircleMark({ size = 26 }: { size?: number }) {
  return (
    <span className="nx-xc-circle" style={{ width: size, height: size }} aria-label="Circle CCTP">
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="none">
        <circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="2.1" />
        <path d="M12 7.3v9.4M9.2 9.1a3.6 3.6 0 0 1 0 5.8M14.8 9.1a3.6 3.6 0 0 0 0 5.8" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function StepIcon({ step }: { step: PlanStep }) {
  if (step.glyph === "bridge") return <CircleMark size={26} />;
  if (step.base && step.quote) return <TokenIcon base={step.base} quote={step.quote} size={26} pair />;
  if (step.symbol) return <TokenIcon base={step.symbol} size={26} pair={false} />;
  return <span className="nx-xm-glyph">{step.glyph === "wallet" ? "◈" : "$"}</span>;
}

export default function StrategyExecute({ open, onClose, userWallet, plan: planProp, loading }: { open: boolean; onClose: () => void; userWallet?: string; plan?: PlanStep[]; loading?: boolean }) {
  const [agent, setAgent] = useState<string | null>(null);
  const [feeByChain, setFeeByChain] = useState<Record<number, number>>({}); // live per-chain 1Shot fee (USDC/tx)
  const [balances, setBalances] = useState<Record<number, number | null>>({}); // USDC per chain
  const [balLoading, setBalLoading] = useState(false);
  const [selChain, setSelChain] = useState(42161); // which chain's balance is highlighted
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [txs, setTxs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [authMode, setAuthMode] = useState<"granted" | null>(null); // set once the user grants the ERC-7715 permission
  const [executing, setExecuting] = useState(false);
  const [planRun, setPlanRun] = useState(false);
  const [msg, setMsg] = useState("Review the plan, then authorize with one signature.");

  // The agent supplies the plan; the test surface falls back to DEFAULT_PLAN (always available
  // synchronously). `building` renders skeleton placeholders ONLY while a parent is still assembling an
  // agent plan (`loading` prop). The balance loads independently and never blocks the plan/CTA.
  const plan = planProp ?? DEFAULT_PLAN;
  const building = !!loading && !planProp;

  // Est. fees = sum over relayed steps of THAT step's chain quote (Arb steps use the Arb quote, the Base
  // step uses the Base quote) — a true per-chain merge of the two 1Shot responses, not one quote ×N.
  const haveQuotes = Object.keys(feeByChain).length > 0;
  const stepFee = useCallback((s: PlanStep) => (s.type === "fund" ? s.feeUsd : (feeByChain[s.chainId] ?? s.feeUsd)), [feeByChain]);
  const estFees = useMemo(
    () => plan.filter((s) => s.type !== "fund").reduce((sum, s) => sum + (feeByChain[s.chainId] ?? s.feeUsd), 0),
    [feeByChain, plan],
  );
  // Signatures are real: the user signs exactly ONE thing (the authorize/fund step). 0 until done.
  const signed = states.fund === "confirmed" || states.fund === "submitted" || txs.fund ? 1 : 0;
  // Funding happens on Arbitrum, so the low-balance warning is keyed to the Arbitrum balance.
  const lowBalance = balances[42161] != null && (balances[42161] as number) < BUDGET;

  useEffect(() => {
    if (!open) return;
    setAuthMode(null);
    netrunnersGet<{ accounts: Record<string, string> }>("/api/agents/accounts")
      .then((r) => setAgent(r?.accounts?.agent ?? null))
      .catch(() => {});
    // Live per-CHAIN fee quotes from 1Shot (relayer_getFeeData per chain) — fetched for every chain the
    // plan touches and merged, since Arbitrum (~0.0149) and Base (~0.01) quote differently.
    const planChains = Array.from(new Set(plan.filter((s) => s.type !== "fund").map((s) => s.chainId)));
    Promise.all(planChains.map((cid) =>
      netrunnersGet<{ chainId: number; estFeeUsdc: number | null }>(`/api/relay/capabilities?chainId=${cid}`)
        .then((r) => (r?.estFeeUsdc != null ? [cid, r.estFeeUsdc] as const : null))
        .catch(() => null),
    )).then((rows) => {
      const next: Record<number, number> = {};
      for (const row of rows) if (row) next[row[0]] = row[1];
      if (Object.keys(next).length) setFeeByChain(next);
    });
  }, [open]);

  // Read the user's live USDC balance on BOTH chains (Arbitrum + Base) — shown as two selectable tiles.
  // Runs independently of the plan; if no wallet is connected we show "—" (never blocks the widget).
  useEffect(() => {
    if (!open) return;
    if (!userWallet) { setBalances({}); setBalLoading(false); return; }
    let cancelled = false;
    setBalLoading(true);
    const addr = getAddress(userWallet);
    Promise.all(BAL_CHAINS.map((c) =>
      createPublicClient({ chain: c.chain, transport: http() })
        .readContract({ address: c.usdc, abi: ERC20, functionName: "balanceOf", args: [addr] })
        .then((b) => [c.id, Number(formatUnits(b as bigint, 6))] as const)
        .catch(() => [c.id, 0] as const),
    )).then((rows) => { if (!cancelled) setBalances(Object.fromEntries(rows)); })
      .finally(() => { if (!cancelled) setBalLoading(false); });
    return () => { cancelled = true; };
  }, [open, userWallet]);

  const refreshStatus = useCallback(async () => {
    // chain_id is a Postgres bigint → arrives as a STRING; coerce before comparing to the step's number.
    const r = await netrunnersGet<{ tasks: Array<{ kind: string; status: number; tx_hash?: string; chain_id?: number | string }> }>("/api/relay/tasks").catch(() => null);
    if (!r?.tasks) return;
    setStates((prev) => {
      const next = { ...prev };
      for (const s of plan) {
        if (s.type === "fund") continue; // funding is the user's grant, not a relayed task
        // Match strictly by kind AND chain — the two LP steps share kind "lp_deposit" but land on
        // different chains, so NO loose cross-chain fallback (that made both show the same status).
        const t = r.tasks.find((x) => x.kind === s.kind && Number(x.chain_id) === s.chainId);
        if (t) { next[s.id] = t.status >= 200 ? (t.status === 200 ? "confirmed" : "failed") : "submitted"; if (t.tx_hash) setTxs((p) => ({ ...p, [s.id]: t.tx_hash! })); }
      }
      return next;
    });
    // Step 1 (authorize) shows the on-chain "pull" tx — the first execution under the grant — as its link.
    const pullTx = r.tasks.find((x) => x.kind === "pull_budget")?.tx_hash;
    if (pullTx) setTxs((p) => (p.fund ? p : { ...p, fund: pullTx }));
  }, [plan]);
  useEffect(() => { if (!open) return; void refreshStatus(); const id = setInterval(() => void refreshStatus(), 5000); return () => clearInterval(id); }, [open, refreshStatus]);

  const set = (id: string, s: StepState) => setStates((p) => ({ ...p, [id]: s }));

  // Step 1 = authorize the agent via ERC-7715 Advanced Permissions (`wallet_grantPermissions`), the
  // MetaMask Smart Accounts Kit feature. The user approves a SCOPED erc20-token-periodic permission
  // (≤ budget/day) to the agent in MetaMask's NATIVE popup — MetaMask handles the Smart Account upgrade
  // + delegation signing internally (sidestepping the stable-wallet "internal account" block). NO USDC
  // moves; the agent redeems the granted permission via the 1Shot relayer (gas in USDC). Requires
  // MetaMask Flask 13.5+ (ERC-7715 is experimental and not in stable MetaMask).
  const authorizeAndFund = useCallback(async () => {
    if (!userWallet) { setMsg("Connect MetaMask first."); return; }
    setBusy(true); set("fund", "active"); setMsg("Approve the Advanced Permissions request in MetaMask…");
    try {
      const res = await authorizeAgent(getAddress(userWallet), { dailyUsdcCap: BUDGET, sessionHours: 24 });
      if (!res.ok) throw new Error(res.error ?? "Authorization failed.");
      setAuthMode("granted");
      set("fund", "confirmed");
      setMsg(`Authorized via MetaMask Advanced Permissions — the agent holds a scoped Smart Account permission (≤ ${fmtUsd(BUDGET)}/day) redeemed through 1Shot (gas in USDC). No more signatures.`);
    } catch (e) {
      const m = (e as Error).message;
      set("fund", "failed");
      setMsg(`Authorization failed: ${m}${/wallet_grantPermissions|not supported|method|undefined/i.test(m) ? " — Advanced Permissions needs MetaMask Flask 13.5+." : ""}`);
    } finally { setBusy(false); }
  }, [userWallet]);

  // After authorization, run the plan: STAGE A (pull the budget into the agent by redeeming the grant)
  // then STAGE B (the agent executes the venue legs via 1Shot). Steps reflect live via /api/relay/tasks.
  const runPlan = useCallback(async () => {
    setExecuting(true); setMsg("Pulling the budget to the agent, then executing the legs via 1Shot…");
    try {
      const r = await netrunnersPost<{ ok?: boolean; legs?: Array<{ leg: string; ok?: boolean; skipped?: string; error?: string }>; note?: string }>(
        "/api/exec/run-plan", { confirm: "RUN_PLAN_MAINNET", budgetUsd: BUDGET },
      );
      const summary = (r?.legs ?? []).map((l) => `${l.leg}:${l.ok ? "ok" : l.skipped ? "skipped" : (l.error?.slice(0, 40) ?? "fail")}`).join(" · ");
      setMsg(r?.ok ? `Legs submitted — watch them land below. ${summary}` : `Some legs need attention: ${summary}`);
      setPlanRun(true);
      void refreshStatus();
    } catch (e) { setMsg(`Execution failed: ${(e as Error).message}`); }
    finally { setExecuting(false); }
  }, [refreshStatus]);

  const funded = states.fund === "confirmed";

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    // Same chrome as the NexaBoard widget detail modal: `nexa` (display:contents) carries the theme
    // fonts/vars, then nx-modal-back/nx-modal/nx-modal-head/nx-modal-body.
    <div className="nexa" style={{ display: "contents" }}>
      <div className="nx-modal-back" onClick={onClose}>
        <div className="nx-modal" onClick={(e) => e.stopPropagation()}>
          <div className="nx-modal-head">
            <span className="nx-w-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></svg></span>
            <div>
              <div className="nx-modal-title">Cross-chain strategy</div>
              <div className="nx-w-kind">Execute · {fmtUsd(BUDGET)} budget · {funded ? "running" : building ? "preparing" : "ready"}</div>
            </div>
            {authMode ? <span className="nx-xc-auth-badge" title="ERC-7715 Advanced Permissions (MetaMask Smart Accounts Kit, Flask). You granted a scoped erc20-token-periodic permission (no USDC moved); the agent redeems it via the 1Shot relayer (gas in USDC).">Advanced Permissions · 1Shot</span> : null}
            <button className="nx-modal-x" onClick={onClose} aria-label="Close">✕</button>
          </div>

          <div className="nx-modal-body">
            {/* Balance hero — live USDC on BOTH chains as selectable tiles (Arbitrum = funding source, Base = bridge destination). */}
            <div className="nx-xc-bal2">
              <div className="nx-xc-bal2-head">
                <span className="nx-xc-bal-label">Your USDC</span>
                <span className="nx-xc-bal-wallet">{userWallet ? short(userWallet) : "not connected"}</span>
              </div>
              <div className="nx-xc-bal2-row">
                {BAL_CHAINS.map((c) => {
                  const v = balances[c.id];
                  const sel = selChain === c.id;
                  const low = c.id === 42161 && v != null && v < BUDGET;
                  return (
                    <button key={c.id} type="button" className={`nx-xc-bal2-tile ${sel ? "on" : ""} ${low ? "low" : ""}`} onClick={() => setSelChain(c.id)} aria-pressed={sel}>
                      <span className="nx-xc-bal2-chain"><TokenIcon base="USDC" size={18} pair={false} />{c.label}</span>
                      {balLoading
                        ? <span className="nx-xc-sk-line w70" />
                        : v == null
                          ? <span className="nx-xc-bal2-val nx-xc-bal-dim">—</span>
                          : <span className="nx-xc-bal2-val">{v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <small>USDC</small></span>}
                      <span className="nx-xc-bal2-note">{c.id === 42161 ? (low ? `below ${fmtUsd(BUDGET)} budget` : "funding source") : "bridge destination"}</span>
                    </button>
                  );
                })}
              </div>
              {!userWallet ? <span className="nx-xc-bal-warn nx-xc-bal2-warn">connect MetaMask to read balances</span> : null}
            </div>

            {/* Spend & cost as polished stat tiles (live: deployed/signed update as the agent executes). */}
            <div className="nx-xc-stats">
              <div className="nx-xc-stat">
                <span className="nx-xc-stat-k">You fund</span>
                <span className="nx-xc-stat-v">{fmtUsd(BUDGET)}</span>
                <span className="nx-xc-stat-s">one signature</span>
              </div>
              <div className="nx-xc-stat">
                <span className="nx-xc-stat-k">DCA</span>
                <span className="nx-xc-stat-v">{fmtUsd(BUDGET)} <small>/ day</small></span>
                <span className="nx-xc-stat-s">recurring · ERC-7715 periodic</span>
              </div>
              <div className="nx-xc-stat">
                <span className="nx-xc-stat-k">Est. fees</span>
                <span className="nx-xc-stat-v">~{fmtUsd(estFees)}</span>
                <span className="nx-xc-stat-s">{haveQuotes ? "live 1Shot · merged per-chain" : "estimate · gas in USDC"}</span>
              </div>
              <div className="nx-xc-stat">
                <span className="nx-xc-stat-k">Signatures</span>
                <span className="nx-xc-stat-v">{signed} <small>/ 1</small></span>
                <span className="nx-xc-stat-s">{signed ? "done" : "fund step only"}</span>
              </div>
            </div>

            <div>
              <div className="nx-md-h">{building ? "Agent is assembling the plan…" : `Plan · ${plan.length} steps`}</div>
              <div className="nx-xs-steps">
                {building
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} className="nx-xs-step nx-xc-skrow">
                        <span className="nx-xs-n">{i + 1}</span>
                        <span className="nx-xc-sk-dot" />
                        <div className="nx-xs-mid"><span className="nx-xc-sk-line w70" /><span className="nx-xc-sk-line w40" /></div>
                        <span className="nx-xc-sk-line w50" />
                      </div>
                    ))
                  : plan.map((s, i) => {
                      const st = states[s.id] ?? "idle";
                      const pill = STATE_PILL[st];
                      return (
                        <div key={s.id} className={`nx-xs-step ${st}`}>
                          <span className="nx-xs-n">{i + 1}</span>
                          <span className="nx-xs-ico"><StepIcon step={s} /></span>
                          <div className="nx-xs-mid">
                            <b>{s.title}</b>
                            <em>{s.glyph === "bridge" ? <>Bridge with Circle CCTP · {CHAIN_LABEL[s.chain]}</> : <>{s.venue} · {CHAIN_LABEL[s.chain]}</>}</em>
                          </div>
                          <div className="nx-xs-cost">
                            <span className="nx-xs-spend">{s.type === "move" ? "moves " : ""}{fmtUsd(s.spendUsd)}</span>
                            <span className="nx-xs-fee">~{fmtUsd(stepFee(s))} {s.type === "fund" ? "ETH gas" : `gas · USDC${haveQuotes ? ` · ${CHAIN_LABEL[s.chain]}` : ""}`}</span>
                          </div>
                          <span className={`nx-lt-pill ${pill.cls}`}>
                            {txs[s.id] ? <a className="nx-xs-tx" href={explorerTx(s.chainId, txs[s.id])} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title={`View on ${s.chainId === 8453 ? "BaseScan" : "Arbiscan"}`}>{pill.label} ↗</a> : pill.label}
                          </span>
                        </div>
                      );
                    })}
              </div>
            </div>

            <div className="nx-xs-foot">
              <p className="nx-status"><i className={busy ? "spin" : ""} />{msg}</p>
              <button className="nx-lt-primary nx-xs-cta" disabled={busy || executing || building || !userWallet || planRun} onClick={() => void (funded ? runPlan() : authorizeAndFund())}>
                {planRun ? "Plan running ✓" : executing ? "Executing…" : funded ? `Execute ${fmtUsd(BUDGET)} plan →` : busy ? "Awaiting approval…" : building ? "Preparing…" : `Authorize agent · ${fmtUsd(BUDGET)} permission`}
              </button>
              {!userWallet ? <p className="nx-wc-muted nx-xs-note">Connect MetaMask to authorize.</p> : null}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
