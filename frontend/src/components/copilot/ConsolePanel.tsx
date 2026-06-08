"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copilotGet, copilotPost, streamRun, type CopilotEvent, type ThreadResponse } from "@/lib/copilot/api";
import { Card, KV, Pill, Empty } from "./ui";
import { EquityChart, type ChartFill } from "@/components/netrunners/EquityChart";

type ChatMsg = { role: "user" | "assistant"; content: string };
type Step = {
  step_id?: string;
  tool?: string;
  state?: string;
  rationale?: string;
  message?: string;
  honesty?: Record<string, unknown>;
  result?: unknown;
  duration_ms?: number;
  elapsed_ms?: number;
  cost_micro_usd?: number;
};
type TruthCard = Record<string, string>;
type CostCard = {
  provider?: string;
  model?: string;
  providerMode?: string;
  costMicroUsd?: number;
  meteringQuality?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  managedBalanceMicroUsd?: number;
};
type PendingApproval = { runId: string; stepId: string; tool?: string };
type FeedItem =
  | { id: string; type: "chat"; role: ChatMsg["role"]; content: string }
  | { id: string; type: "run"; runId: string; label: string }
  | { id: string; type: "step"; runId: string; step: Step; index: number }
  | { id: string; type: "approval"; pending: PendingApproval }
  | { id: string; type: "truth"; truth: TruthCard }
  | { id: string; type: "cost"; cost: CostCard };

const THREAD_KEY = "duality_copilot_thread";
const usd = (m?: number) => (m == null ? "$0.000000" : `$${(m / 1_000_000).toFixed(6)}`);

function feedFromMessages(messages: ChatMsg[]): FeedItem[] {
  return messages.map((m, i) => ({ id: `history-${i}`, type: "chat", role: m.role, content: m.content }));
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 1).slice(0, 420);
  } catch {
    return "";
  }
}

function Sparkline({ values, hot = false }: { values: number[]; hot?: boolean }) {
  const points = values
    .map((v, i) => `${(i / Math.max(1, values.length - 1)) * 112},${34 - v * 28}`)
    .join(" ");
  return (
    <svg className="cp-spark" viewBox="0 0 112 38" aria-hidden="true">
      <path d="M0 32H112" />
      <polyline className={hot ? "hot" : ""} points={points} />
    </svg>
  );
}

type BacktestChartData = {
  symbol: string;
  strategy: string;
  equity: number[];
  bars: { ts: number }[];
  fills: ChartFill[];
  sampledFrom?: number;
  finalEquity?: number;
  startingEquity?: number;
  fillsCount?: number;
  resultTier?: string;
  performance: Record<string, unknown>;
  fillModel: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map(num).filter((v): v is number => v !== undefined) : [];
}

function findEquityNode(value: unknown, depth = 0): Record<string, unknown> | null {
  const node = record(value);
  if (!node || depth > 5) return null;
  if (Array.isArray(node.equity_curve) || Array.isArray(node.equity)) return node;
  for (const child of Object.values(node)) {
    const found = findEquityNode(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeChartFills(value: unknown): ChartFill[] {
  if (!Array.isArray(value)) return [];
  const parsed: ChartFill[] = [];
  for (const fill of value) {
    const row = record(fill) ?? {};
    const ts = row.ts ?? row.time ?? row.timestamp;
    const price = row.price ?? row.fill_price;
    const qty = row.qty ?? row.quantity;
    if (ts == null || price == null || qty == null) continue;
    parsed.push({
      ts: String(ts),
      side: String(row.side ?? "buy"),
      qty: String(qty),
      price: String(price),
      fee: row.fee == null ? undefined : String(row.fee),
      is_maker: Boolean(row.is_maker),
    });
  }
  return parsed;
}

function normalizeChartBars(value: unknown, count: number): { ts: number }[] {
  const rows = Array.isArray(value) ? value : [];
  if (rows.length > 0) {
    return rows.slice(0, count).map((bar, i) => {
      const row = record(bar);
      return { ts: num(row?.ts ?? row?.time ?? row?.timestamp ?? row?.t) ?? i };
    });
  }
  return Array.from({ length: count }, (_, i) => ({ ts: i }));
}

function extractBacktestChart(step: Step): BacktestChartData | null {
  const raw = record(step.result);
  const chart = record(raw?.chart_preview) ?? record(raw?.chart) ?? null;
  const source = chart ?? findEquityNode(step.result);
  if (!source) return null;
  const equity = numbers(source.equity_curve ?? source.equity);
  if (equity.length < 2) return null;
  const performance = record(source.performance) ?? record(raw?.performance) ?? record(source.metrics) ?? record(raw?.metrics) ?? {};
  const fillModel = record(source.fill_model) ?? record(raw?.fill_model) ?? {};
  const startingEquity = num(source.starting_equity ?? source.start_equity) ?? equity[0];
  return {
    symbol: String(source.symbol ?? raw?.symbol ?? "backtest"),
    strategy: String(source.strategy ?? source.strategy_id ?? raw?.strategy_id ?? step.tool ?? "backtest"),
    equity,
    bars: normalizeChartBars(source.bars, equity.length),
    fills: normalizeChartFills(source.fills),
    sampledFrom: num(source.sampled_from),
    finalEquity: num(source.final_equity) ?? equity[equity.length - 1],
    startingEquity,
    fillsCount: num(source.fills_count) ?? normalizeChartFills(source.fills).length,
    resultTier: String(source.result_tier ?? raw?.result_tier ?? step.honesty?.result_tier ?? ""),
    performance,
    fillModel,
  };
}

function metric(data: BacktestChartData, key: string, digits = 2): string {
  const value = num(data.performance[key]);
  if (value === undefined) return "--";
  if (key.includes("return") || key.includes("drawdown") || key === "win_rate") return `${(value * 100).toFixed(digits)}%`;
  return value.toFixed(digits);
}

function BacktestResultCard({ data }: { data: BacktestChartData }) {
  const start = data.startingEquity ?? data.equity[0] ?? 0;
  const final = data.finalEquity ?? data.equity[data.equity.length - 1] ?? start;
  const ret = start ? ((final - start) / start) * 100 : 0;
  const fillMode = String(data.fillModel.mode ?? data.fillModel.execution_fidelity ?? "bar_based");
  return (
    <div className="cp-backtest-card">
      <div className="cp-result-head">
        <div>
          <div className="cp-eye">Actual backtest result</div>
          <div className="cp-result-title">{data.symbol} · {data.strategy}</div>
        </div>
        <div className="cp-row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {data.resultTier ? <Pill tone="violet">{data.resultTier}</Pill> : null}
          <Pill tone={ret >= 0 ? "teal" : "red"}>{ret >= 0 ? "+" : ""}{ret.toFixed(2)}%</Pill>
        </div>
      </div>
      <div className="cp-backtest-chart">
        <EquityChart
          equity={data.equity}
          fills={data.fills}
          bars={data.bars}
          startEquity={start}
          height={210}
        />
      </div>
      <div className="cp-backtest-metrics">
        <div><span>Final equity</span><b>${final.toFixed(2)}</b></div>
        <div><span>Max drawdown</span><b>{metric(data, "max_drawdown")}</b></div>
        <div><span>Sharpe</span><b>{metric(data, "sharpe")}</b></div>
        <div><span>Profit factor</span><b>{metric(data, "profit_factor")}</b></div>
        <div><span>Fills</span><b>{data.fillsCount ?? data.fills.length}</b></div>
        <div><span>Fill model</span><b>{fillMode}</b></div>
      </div>
      {data.sampledFrom && data.sampledFrom > data.equity.length ? (
        <div className="cp-backtest-note">Chart sampled {data.equity.length} points from {data.sampledFrom} real equity points.</div>
      ) : null}
    </div>
  );
}

function PhasePill({ state }: { state?: string }) {
  const normalized = state ?? "running";
  const tone =
    normalized === "completed" ? "teal" :
    normalized === "error" ? "red" :
    normalized === "awaiting_approval" ? "orange" :
    normalized === "running" ? "teal" : "muted";
  return <Pill tone={tone} glow={normalized === "running"}>{normalized.replaceAll("_", " ")}</Pill>;
}

function honestyChips(honesty?: Record<string, unknown>) {
  if (!honesty) return [];
  const preferred = ["result_tier", "fill_model", "coverage", "coverage_proof", "verified", "execution_fidelity", "risk_class"];
  const entries = preferred
    .filter((key) => honesty[key] != null)
    .map((key) => [key, honesty[key]] as const);
  const fallback = Object.entries(honesty).slice(0, 4);
  return (entries.length ? entries : fallback).slice(0, 4);
}

function TraceStepCard({ item }: { item: Extract<FeedItem, { type: "step" }> }) {
  const { step, index } = item;
  const state = step.state ?? "running";
  const tool = step.tool ?? step.step_id ?? "copilot.step";
  const detail = step.rationale ?? step.message ?? "Waiting for the agent bus to emit detail.";
  const duration = step.duration_ms ?? step.elapsed_ms;
  const cost = step.cost_micro_usd;
  const chips = honestyChips(step.honesty);
  const backtest = extractBacktestChart(step);

  return (
    <div className={`cp-trace-card ${state}`}>
      <div className="cp-trace-index">{String(index + 1).padStart(2, "0")}</div>
      <div className="cp-trace-main">
        <div className="cp-trace-top">
          <div>
            <div className="cp-trace-tool">{tool}</div>
            <div className="cp-trace-detail">{detail}</div>
          </div>
          <PhasePill state={state} />
        </div>
        {backtest ? (
          <BacktestResultCard data={backtest} />
        ) : (
          <div className="cp-trace-facts">
            <div>
              <span>Duration</span>
              <b>{duration == null ? "--" : `${duration}ms`}</b>
            </div>
            <div>
              <span>Step cost</span>
              <b>{cost == null ? "--" : usd(cost)}</b>
            </div>
            <div>
              <span>Artifact</span>
              <b>{step.result == null ? "none" : "available"}</b>
            </div>
          </div>
        )}
        {chips.length > 0 && (
          <div className="cp-honesty-row">
            {chips.map(([key, value]) => <span key={key}>{key}: <b>{String(value)}</b></span>)}
          </div>
        )}
        {step.honesty && Object.keys(step.honesty).length > 0 && <pre className="cp-trace-json">{compactJson(step.honesty)}</pre>}
      </div>
    </div>
  );
}

function RunStartCard({ item }: { item: Extract<FeedItem, { type: "run" }> }) {
  return (
    <div className="cp-run-card">
      <div>
        <div className="cp-eye">Run trace attached to chat</div>
        <div className="cp-run-title">{item.label}</div>
      </div>
      <div className="cp-run-id">{item.runId.slice(0, 18)}...</div>
    </div>
  );
}

function CostTraceCard({ cost }: { cost: CostCard }) {
  const tokenBars = [
    { label: "in", value: cost.inputTokens ?? 0 },
    { label: "cached", value: cost.cachedInputTokens ?? 0 },
    { label: "out", value: cost.outputTokens ?? 0 },
  ];
  const max = Math.max(1, ...tokenBars.map((b) => b.value));
  return (
    <div className="cp-result-card cost">
      <div className="cp-result-head">
        <div>
          <div className="cp-eye">Metering card</div>
          <div className="cp-result-title">{cost.provider ?? "provider"}/{cost.model ?? "model"}</div>
        </div>
        <Pill tone={cost.meteringQuality === "actual" ? "teal" : "orange"}>{cost.meteringQuality ?? "estimated"}</Pill>
      </div>
      <div className="cp-token-bars">
        {tokenBars.map((bar) => (
          <div key={bar.label}>
            <span>{bar.label}</span>
            <i style={{ width: `${Math.max(8, (bar.value / max) * 100)}%` }} />
            <b>{bar.value}</b>
          </div>
        ))}
      </div>
      <div className="cp-result-foot">
        <span>cost {usd(cost.costMicroUsd)}</span>
        <span>remaining {usd(cost.managedBalanceMicroUsd)}</span>
      </div>
    </div>
  );
}

function TruthTraceCard({ truth }: { truth: TruthCard }) {
  const rows: [string, string | undefined][] = [
    ["Result tier", truth.result_tier],
    ["Fill model", truth.fill_model_mode],
    ["Coverage", truth.coverage],
    ["Execution fidelity", truth.execution_fidelity],
    ["Verified", truth.verified],
    ["Risk class", truth.risk_class],
    ["Hard blocks", truth.hard_blocks],
  ];
  const contract = rows.map(([, value], i) => (value && value !== "unknown" && value !== "no" ? 0.45 + i * 0.06 : 0.18));
  return (
    <div className="cp-result-card truth">
      <div className="cp-result-head">
        <div>
          <div className="cp-eye">Honesty contract</div>
          <div className="cp-result-title">{truth.agent_action ?? "Result truth card"}</div>
        </div>
        <Pill tone={truth.verified === "yes" ? "teal" : "orange"}>{truth.result_tier ?? "tier pending"}</Pill>
      </div>
      <div className="cp-truth-layout">
        <Sparkline values={contract} hot={truth.verified !== "yes"} />
        <div>
          {rows.filter(([, v]) => v).slice(0, 5).map(([k, v]) => (
            <div key={k} className="cp-truth-row"><span>{k}</span><b>{v}</b></div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ApprovalTraceCard({ pending, active, onApprove }: { pending: PendingApproval; active: boolean; onApprove: () => void }) {
  return (
    <div className={`cp-approval-card ${active ? "active" : ""}`}>
      <div>
        <div className="cp-eye">Approval gate</div>
        <div className="cp-result-title">{pending.tool ?? "gated tool"}</div>
        <div className="cp-trace-detail">Step {pending.stepId} paused until you approve.</div>
      </div>
      <button className="cp-btn orange" disabled={!active} onClick={onApprove}>
        {active ? "Approve" : "Approved"}
      </button>
    </div>
  );
}

// Render assistant text with clickable links: markdown [label](url) keeps its label; a BARE http(s)
// URL renders as a compact "hostname ↗" anchor (so a long Google-News/source URL doesn't dump raw
// text). New tab, noopener. Everything else passes through as plain text.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>)\]]+)/g;
function hostLabel(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "") + " ↗"; } catch { return url; }
}
function renderRichText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const mdLabel = m[1];
    const url = m[2] ?? m[3];
    nodes.push(
      <a key={`lnk-${k++}`} href={url} target="_blank" rel="noopener noreferrer" className="cp-link">
        {mdLabel ?? hostLabel(url)}
      </a>,
    );
    last = LINK_RE.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function ChatBubble({ role, content }: { role: ChatMsg["role"]; content: string }) {
  return (
    <div className={`cp-msg ${role}`}>
      <span className="cp-msg-role">{role === "user" ? "You" : "Copilot"}</span>
      {role === "assistant" ? renderRichText(content) : content}
    </div>
  );
}

export default function ConsolePanel({ onActivity }: { onActivity?: () => void }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [, setMessages] = useState<ChatMsg[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [input, setInput] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [truth, setTruth] = useState<TruthCard | null>(null);
  const [cost, setCost] = useState<CostCard | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [category, setCategory] = useState<"spot" | "linear" | "xstock">("linear");
  const [autonomy, setAutonomy] = useState("L1");
  const streamRef = useRef<{ abort: () => void } | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const feedSeqRef = useRef(0);
  const traceIndexRef = useRef(0);

  const nextFeedId = useCallback((prefix: string) => `${prefix}-${Date.now()}-${++feedSeqRef.current}`, []);
  const appendFeed = useCallback((item: FeedItem) => setFeed((f) => [...f, item]), []);
  const appendChat = useCallback((msg: ChatMsg) => {
    setMessages((m) => [...m, msg]);
    appendFeed({ id: nextFeedId(`chat-${msg.role}`), type: "chat", role: msg.role, content: msg.content });
  }, [appendFeed, nextFeedId]);

  const ensureThread = useCallback(async (): Promise<string | null> => {
    if (threadId) return threadId;
    const stored = typeof window !== "undefined" ? localStorage.getItem(THREAD_KEY) : null;
    if (stored) {
      const r = await copilotGet<{ messages: ChatMsg[] }>(`/threads/${stored}/messages`);
      if (r) {
        const hydrated = r.messages ?? [];
        setThreadId(stored);
        setMessages(hydrated);
        setFeed(feedFromMessages(hydrated));
        return stored;
      }
    }
    const t = await copilotPost<ThreadResponse>("/threads", { title: "Copilot session" });
    if (t?.id) {
      setThreadId(t.id);
      try { localStorage.setItem(THREAD_KEY, t.id); } catch { /* ignore */ }
    }
    return t?.id ?? null;
  }, [threadId]);

  function newSession() {
    streamRef.current?.abort();
    try { localStorage.removeItem(THREAD_KEY); } catch { /* ignore */ }
    setThreadId(null);
    setMessages([]);
    setFeed([]);
    setSteps([]);
    setTruth(null);
    setCost(null);
    setPending(null);
    setRunId(null);
    traceIndexRef.current = 0;
  }

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { if (mounted) void ensureThread(); });
    return () => {
      mounted = false;
      streamRef.current?.abort();
    };
  }, [ensureThread]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [feed, running]);

  const handleEvent = useCallback((rid: string, ev: CopilotEvent) => {
    switch (ev.event) {
      case "run.step": {
        const step = ev.data as Step;
        const index = traceIndexRef.current++;
        setSteps((s) => [...s, step]);
        appendFeed({ id: nextFeedId("step"), type: "step", runId: rid, step, index });
        break;
      }
      case "approval.required": {
        const approval = { runId: rid, stepId: String(ev.data.step_id), tool: ev.data.tool as string };
        setPending(approval);
        appendFeed({ id: nextFeedId("approval"), type: "approval", pending: approval });
        break;
      }
      case "truth_card": {
        const next = ev.data as TruthCard;
        setTruth(next);
        appendFeed({ id: nextFeedId("truth"), type: "truth", truth: next });
        break;
      }
      case "cost": {
        const next = ev.data as CostCard;
        setCost(next);
        appendFeed({ id: nextFeedId("cost"), type: "cost", cost: next });
        break;
      }
      case "message":
        appendChat({ role: "assistant", content: String(ev.data.content ?? "") });
        break;
      case "run.done":
      case "run.error":
        setRunning(false);
        onActivity?.();
        break;
    }
  }, [appendChat, appendFeed, nextFeedId, onActivity]);

  const consume = useCallback((rid: string, label: string) => {
    setRunId(rid);
    setRunning(true);
    setSteps([]);
    setTruth(null);
    setCost(null);
    setPending(null);
    traceIndexRef.current = 0;
    appendFeed({ id: nextFeedId("run"), type: "run", runId: rid, label });
    streamRef.current?.abort();
    streamRef.current = streamRun(rid, (ev) => handleEvent(rid, ev));
  }, [appendFeed, handleEvent, nextFeedId]);

  async function sendChat() {
    const text = input.trim();
    if (!text) return;
    const tid = await ensureThread();
    if (!tid) return;
    appendChat({ role: "user", content: text });
    setInput("");
    const r = await copilotPost<{ runId: string }>(`/threads/${tid}/message`, { content: text });
    if (r?.runId) consume(r.runId, "Chat turn");
  }

  async function runBuildBacktest() {
    const tid = await ensureThread();
    if (!tid) return;
    appendChat({ role: "user", content: `Build and backtest ${symbol} (${category}, ${autonomy})` });
    const r = await copilotPost<{ runId: string }>("/playbooks/build_and_backtest_bot", { threadId: tid, symbol, category, autonomy });
    if (r?.runId) consume(r.runId, `${symbol} build and backtest`);
  }

  async function approve() {
    if (!pending) return;
    await copilotPost(`/runs/${pending.runId}/approve`, { stepId: pending.stepId });
    setPending(null);
    setRunning(true);
  }

  const completed = steps.filter((s) => s.state === "completed").length;
  const traceHealth = useMemo(() => {
    const valueFor = (state?: string) => {
      if (state === "completed") return 0.9;
      if (state === "running") return 0.65;
      if (state === "awaiting_approval") return 0.48;
      if (state === "error" || state === "blocked") return 0.18;
      return 0.35;
    };
    return steps.map((s) => valueFor(s.state)).slice(-18);
  }, [steps]);

  const truthRows: [string, string | undefined][] = truth ? [
    ["Result tier", truth.result_tier], ["Fill model", truth.fill_model_mode],
    ["Maker fills optimistic", truth.maker_fills_optimistic], ["Liquidity-free bound", truth.liquidity_free_upper_bound],
    ["Coverage", truth.coverage], ["Execution fidelity", truth.execution_fidelity],
    ["Verified", truth.verified], ["Risk class", truth.risk_class], ["Hard blocks", truth.hard_blocks],
    ["Agent action", truth.agent_action], ["LLM cost", truth.llm_cost_usd],
  ] : [];

  return (
    <>
      <div className="cp-col-8">
        <Card eye="Live agent transcript" title="Command Console" accent="orange"
          right={<div className="cp-row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {running ? <Pill tone="teal" glow>live run</Pill> : <Pill tone="muted">idle</Pill>}
            <button className="cp-btn ghost cp-btn-compact" onClick={newSession}>New</button>
          </div>}>
          <div className="cp-console-head">
            <div>
              <div className="cp-eye">Active run</div>
              <div className="cp-console-run">{runId ? `${runId.slice(0, 22)}...` : "no run attached"}</div>
            </div>
            <div className="cp-console-signal">
              {traceHealth.length > 1
                ? <Sparkline values={traceHealth} hot={Boolean(pending)} />
                : <div className="cp-console-placeholder">No run data yet</div>}
            </div>
            <div className="cp-console-counters">
              <span><b>{steps.length}</b> steps</span>
              <span><b>{completed}</b> done</span>
              <span><b>{pending ? 1 : 0}</b> gates</span>
            </div>
          </div>

          <div className="cp-conversation">
            {feed.length === 0 && (
              <div className="cp-zero-state">
                <div className="cp-zero-title">Copilot is ready.</div>
                <div className="cp-zero-grid">
                  <button onClick={() => setInput("Find a verified BTCUSDT bot setup and explain the honesty fields.")}>verified BTC setup</button>
                  <button onClick={() => setInput("What changed in the last run and what should I test next?")}>summarize last run</button>
                  <button onClick={() => setInput("Scan memory for playbooks that worked in high volatility regimes.")}>recall high-vol policy</button>
                </div>
              </div>
            )}
            {feed.map((item) => {
              if (item.type === "chat") return <ChatBubble key={item.id} role={item.role} content={item.content} />;
              if (item.type === "run") return <RunStartCard key={item.id} item={item} />;
              if (item.type === "step") return <TraceStepCard key={item.id} item={item} />;
              if (item.type === "approval") {
                const active = pending?.runId === item.pending.runId && pending.stepId === item.pending.stepId;
                return <ApprovalTraceCard key={item.id} pending={item.pending} active={active} onApprove={() => void approve()} />;
              }
              if (item.type === "cost") return <CostTraceCard key={item.id} cost={item.cost} />;
              return <TruthTraceCard key={item.id} truth={item.truth} />;
            })}
            {running && (
              <div className="cp-msg assistant live">
                <span className="cp-msg-role">Copilot</span>
                <span className="cp-typing"><i /><i /><i /></span>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="cp-composer">
            <textarea className="cp-textarea" rows={2} value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); } }}
              placeholder="Message Copilot" />
            <button className="cp-btn orange" disabled={running} onClick={() => void sendChat()}>Send</button>
          </div>
        </Card>
      </div>

      <div className="cp-col-4">
        <Card eye="Playbook launcher" title="Build & Backtest" accent="violet">
          <label className="cp-label">Symbol</label>
          <input className="cp-input" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
          <div className="cp-row cp-form-split">
            <div>
              <label className="cp-label">Category</label>
              <select className="cp-select" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
                <option value="linear">linear</option>
                <option value="spot">spot</option>
                <option value="xstock">xstock</option>
              </select>
            </div>
            <div>
              <label className="cp-label">Autonomy</label>
              <select className="cp-select" value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
                <option value="L1">L1 - approve</option>
                <option value="L2">L2 - auto</option>
              </select>
            </div>
          </div>
          <button className="cp-btn teal cp-run-button" disabled={running} onClick={() => void runBuildBacktest()}>
            Run playbook
          </button>
          <div className="cp-side-graph">
            <div><span>Run output</span><b>{running ? "streaming trace" : "equity chart appears in chat"}</b></div>
            <div><span>Data source</span><b>real backtest payload</b></div>
          </div>
        </Card>

        <div style={{ height: 14 }} />
        <Card eye="Latest meter" title="Cost Card" accent="teal">
          {cost ? (
            <>
              <KV k="Model" v={`${cost.provider}/${cost.model}`} />
              <KV k="Mode" v={cost.providerMode} />
              <KV k="Cost" v={usd(cost.costMicroUsd)} />
              <KV k="Tokens" v={`${cost.inputTokens ?? 0}/${cost.cachedInputTokens ?? 0}/${cost.outputTokens ?? 0}`} />
              <KV k="Credit" v={usd(cost.managedBalanceMicroUsd)} />
            </>
          ) : <Empty>No model call yet.</Empty>}
        </Card>

        <div style={{ height: 14 }} />
        <Card eye="Latest truth" title="Truth Card" accent="orange">
          {truth ? truthRows.slice(0, 7).map(([k, v]) => (
            <KV key={k} k={k} v={
              k === "Verified" ? <Pill tone={v === "yes" ? "teal" : "red"}>{v ?? "?"}</Pill> :
              k === "Result tier" ? <Pill tone="violet">{v ?? "?"}</Pill> : (v ?? "unknown")
            } />
          )) : <Empty>Completing a backtest will pin the truth card here.</Empty>}
        </Card>
      </div>
    </>
  );
}
