"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtUsd, getStockOhlcvEnsured, netrunnersGetResult, netrunnersPostResult, netrunnersSend, type CandleBar } from "@/lib/netrunners/api";
import { CandleChart } from "@/components/netrunners/CandleChart";
import { TokenIcon } from "@/components/netrunners/TokenIcon";

type OrderLeg = { symbol: string; usdg?: number; stock?: number };
type OrderRow = { id: string; kind: string; side: string; legs: OrderLeg[]; trigger_price_1e8?: string | null; comparator?: string | null; trigger_symbol?: string | null; state: string; created_by: string; fill_tx?: string | null; last_error?: string | null; created_at: string };
type DcaRow = { id: string; legs: OrderLeg[]; usdg_per_run: string; interval_seconds: string; next_run_at: string; runs_done: number; max_runs?: number | null; state: string; created_by: string; last_tx?: string | null };
type OrderEventRow = { id: string; order_id?: string | null; bot_id?: string | null; action: string; detail?: string | null; tx?: string | null; ts: string };
type OrdersResp = { ok: boolean; orders: OrderRow[]; bots: DcaRow[]; events: OrderEventRow[] };
type OrderActionResp = { ok?: boolean; note?: string; error?: string };

const INTERVAL_OPTIONS: Array<{ label: string; seconds: number }> = [
  { label: "Hourly", seconds: 3600 },
  { label: "Daily", seconds: 86400 },
  { label: "Weekly", seconds: 604800 },
  { label: "1 min (demo)", seconds: 60 },
];

function whoBadge(by?: string): string { return by === "copilot" ? "Arivion" : "You"; }
function legAmt(o: OrderRow): string {
  if (o.kind === "basket") return `$${o.legs.reduce((s, l) => s + (l.usdg ?? 0), 0)}`;
  const l = o.legs[0];
  return l?.usdg != null ? `$${l.usdg}` : l?.stock != null ? `${l.stock} sh` : "";
}
function intervalLabel(sec: number): string {
  const o = INTERVAL_OPTIONS.find((x) => x.seconds === sec);
  if (o) return o.label;
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  return `${sec}s`;
}

type StockRow = {
  symbol: string;
  stockToken: string;
  priceUsd: string;
  updatedAt: number;
  ageSeconds: number | null;
  fresh: boolean;
  balance: string;
  valueUsd: string;
  totalSupply: string;
  quoteBuyUsd100: string;
  truth?: Record<string, unknown>;
};

type StockState = {
  ok: boolean;
  error?: string;
  reason?: string;
  configured: boolean;
  executionEnabled: boolean;
  chainId: number;
  agent?: string;
  vault?: string;
  collateral?: string;
  usdBalance?: string;
  gasBalance?: string;
  marketOpen?: boolean;
  rthOnly?: boolean;
  maxPriceStalenessSeconds?: string;
  stocks: StockRow[];
  truth?: Record<string, unknown>;
};

type TradeResult = {
  ok?: boolean;
  error?: string;
  symbol?: string;
  usdgSpent?: string;
  stockReceived?: string;
  stockSold?: string;
  usdgReceived?: string;
  priceUsd?: string;
  stockToken?: string;
  agent?: string;
  txs?: Record<string, string>;
  explorer?: string;
  truth?: Record<string, unknown>;
};

type Variant = "page" | "embedded";

const FALLBACK_STOCKS: StockRow[] = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"].map((symbol) => ({
  symbol,
  stockToken: "",
  priceUsd: "0",
  updatedAt: 0,
  ageSeconds: null,
  fresh: false,
  balance: "0",
  valueUsd: "0",
  totalSupply: "0",
  quoteBuyUsd100: "0",
}));

const STOCK_NAMES: Record<string, string> = {
  TSLA: "Tesla",
  AMZN: "Amazon",
  PLTR: "Palantir",
  NFLX: "Netflix",
  AMD: "AMD",
  NVDA: "NVIDIA",
  AAPL: "Apple",
  MSFT: "Microsoft",
  HOOD: "Robinhood",
};

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function shortAddr(addr?: string): string {
  if (!addr) return "--";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function ageLabel(seconds: number | null): string {
  if (seconds == null) return "no oracle update";
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
}

function actionError(data: TradeResult | null, status: number): string {
  return data?.error || `request failed (${status})`;
}

function stockName(symbol: string): string {
  return STOCK_NAMES[symbol] ?? symbol;
}

function StockSearchModal({
  rows,
  onPick,
  onClose,
}: {
  rows: StockRow[];
  onPick: (symbol: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = rows.filter((row) => {
    const q = query.trim().toUpperCase();
    return !q || row.symbol.includes(q) || stockName(row.symbol).toUpperCase().includes(q);
  });
  return (
    <div className="rh-market-modal" role="dialog" aria-modal="true">
      <div className="rh-market-picker">
        <div className="rh-market-picker-head">
          <div><span>Market Search</span><b>Robinhood-chain stock tokens</b></div>
          <button onClick={onClose} aria-label="Close">x</button>
        </div>
        <input autoFocus placeholder="Search TSLA, AMZN, PLTR..." value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="rh-market-picker-list">
          {filtered.map((row) => (
            <button key={row.symbol} onClick={() => { onPick(row.symbol); onClose(); }}>
              <TokenIcon symbol={row.symbol} kind="equity" size={28} pair={false} />
              <span><b>{row.symbol}</b><em>{stockName(row.symbol)} token</em></span>
              <strong>{fmtUsd(n(row.priceUsd))}</strong>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function StockMarketsTerminal({
  variant = "page",
  onCopilot,
}: {
  variant?: Variant;
  onCopilot?: (prompt: string) => void;
}) {
  const [state, setState] = useState<StockState | null>(null);
  const [status, setStatus] = useState("Loading RH-chain markets...");
  const [selected, setSelected] = useState("TSLA");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [usdAmount, setUsdAmount] = useState("100");
  const [stockAmount, setStockAmount] = useState("0.25");
  const [bars, setBars] = useState<CandleBar[]>([]);
  const [chartStatus, setChartStatus] = useState("Loading stock candles...");
  const [trading, setTrading] = useState(false);
  const [result, setResult] = useState<TradeResult | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Order entry + open orders/bots.
  const [tab, setTab] = useState<"market" | "limit" | "dca" | "basket">("market");
  const [timeframe, setTimeframe] = useState<"1M" | "3M" | "1Y" | "ALL">("3M");
  const [limitPrice, setLimitPrice] = useState("");
  const [limitUsd, setLimitUsd] = useState("100");
  const [dcaUsd, setDcaUsd] = useState("25");
  const [dcaInterval, setDcaInterval] = useState(86400);
  const [dcaMaxRuns, setDcaMaxRuns] = useState("");
  const [basketLegs, setBasketLegs] = useState<Array<{ symbol: string; usd: string }>>([{ symbol: "TSLA", usd: "50" }, { symbol: "AMZN", usd: "50" }]);
  const [orders, setOrders] = useState<OrdersResp | null>(null);
  const [orderMsg, setOrderMsg] = useState("");

  const loadOrders = useCallback(async () => {
    const r = await netrunnersGetResult<OrdersResp>("/api/exec/orders");
    if (r.ok && r.data) setOrders(r.data);
  }, []);
  useEffect(() => {
    void loadOrders();
    const t = window.setInterval(() => void loadOrders(), 15000);
    return () => window.clearInterval(t);
  }, [loadOrders]);

  const load = useCallback(async () => {
    setStatus("Reading vault, USDG and stock balances...");
    const res = await netrunnersGetResult<StockState>("/api/exec/stocks");
    if (!res.ok || !res.data) {
      setState(res.data);
      const why = [res.data?.error, res.data?.reason].filter(Boolean).join(" · ");
      setStatus(`${why || "Stock execution API unavailable"} (HTTP ${res.status})`);
      return;
    }
    setState(res.data);
    setStatus(res.data.ok ? "Live testnet state loaded from contracts." : res.data.error || "Stock markets not configured.");
    if (!res.data.stocks.some((s) => s.symbol === selected) && res.data.stocks[0]) setSelected(res.data.stocks[0].symbol);
  }, [selected]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const t = window.setInterval(() => void load(), 25000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [load]);

  useEffect(() => {
    let mounted = true;
    const task = window.setTimeout(() => {
      setChartStatus(`Loading ${selected} candles...`);
      getStockOhlcvEnsured(selected, 120).then((r) => {
        if (!mounted) return;
        setBars(r.bars ?? []);
        setChartStatus(r.error ? r.error : `${r.bars?.length ?? 0} daily candles via stock data bridge`);
      });
    }, 0);
    return () => { mounted = false; window.clearTimeout(task); };
  }, [selected]);

  const rows = state?.stocks?.length ? state.stocks : FALLBACK_STOCKS;
  const row = rows.find((s) => s.symbol === selected) ?? rows[0] ?? FALLBACK_STOCKS[0];
  const price = n(row?.priceUsd);
  const portfolioValue = rows.reduce((sum, s) => sum + n(s.valueUsd), 0);
  const estimatedStock = price > 0 ? n(usdAmount) / price : 0;
  const estimatedUsd = price > 0 ? n(stockAmount) * price : 0;
  const stale = row ? !row.fresh : true;
  const canTrade = !!row && state?.configured && !trading && !stale && n(side === "buy" ? usdAmount : stockAmount) > 0;
  const tfBars = useMemo(() => {
    if (timeframe === "ALL") return bars;
    const days = timeframe === "1M" ? 22 : timeframe === "3M" ? 66 : 252;
    return bars.slice(-days);
  }, [bars, timeframe]);

  async function placeLimit() {
    if (!row) return;
    setOrderMsg("Placing limit order…");
    const r = await netrunnersPostResult<OrderActionResp, Record<string, unknown>>("/api/exec/orders", {
      kind: "limit", side, triggerPrice: Number(limitPrice || price),
      legs: [side === "buy" ? { symbol: row.symbol, usdg: Number(limitUsd) } : { symbol: row.symbol, stock: Number(stockAmount) }],
    });
    setOrderMsg(r.data?.note ?? (r.ok ? "Limit order placed." : r.data?.error ?? "Failed to place order."));
    await loadOrders();
  }
  async function startDca() {
    if (!row) return;
    setOrderMsg("Starting DCA bot…");
    const r = await netrunnersPostResult<OrderActionResp, Record<string, unknown>>("/api/exec/dca", {
      legs: [{ symbol: row.symbol, usdg: Number(dcaUsd) }], intervalSeconds: dcaInterval,
      maxRuns: dcaMaxRuns ? Number(dcaMaxRuns) : undefined,
    });
    setOrderMsg(r.ok ? `DCA bot started — buys $${dcaUsd} of d${row.symbol} every ${intervalLabel(dcaInterval)}.` : r.data?.error ?? "Failed to start bot.");
    await loadOrders();
  }
  async function placeBasket() {
    const legs = basketLegs.map((l) => ({ symbol: l.symbol.trim().toUpperCase(), usdg: Number(l.usd) })).filter((l) => l.symbol && l.usdg > 0);
    if (!legs.length) { setOrderMsg("Add at least one basket leg."); return; }
    setOrderMsg("Queuing basket…");
    const r = await netrunnersPostResult<OrderActionResp, Record<string, unknown>>("/api/exec/orders", { kind: "basket", side: "buy", legs });
    setOrderMsg(r.ok ? "Basket queued — fills on the next engine tick (~30s)." : r.data?.error ?? "Failed to queue basket.");
    await loadOrders();
  }
  async function cancelOrder(id: string) { await netrunnersSend(`/api/exec/orders/${id}`, "DELETE"); await loadOrders(); }
  async function setBotState(id: string, action: "pause" | "resume" | "stop") {
    if (action === "stop") await netrunnersSend(`/api/exec/dca/${id}`, "DELETE");
    else await netrunnersSend(`/api/exec/dca/${id}`, "PATCH", { action });
    await loadOrders();
  }

  async function executeTrade() {
    if (!row) return;
    setTrading(true);
    setResult(null);
    setStatus(side === "buy" ? `Buying ${row.symbol} on RH testnet...` : `Selling ${row.symbol} on RH testnet...`);
    const res = side === "buy"
      ? await netrunnersPostResult<TradeResult, Record<string, unknown>>("/api/exec/stock-buy", { symbol: row.symbol, usdgAmount: Number(usdAmount) })
      : await netrunnersPostResult<TradeResult, Record<string, unknown>>("/api/exec/stock-sell", { symbol: row.symbol, stockAmount: Number(stockAmount) });
    setTrading(false);
    setResult(res.data);
    setStatus(res.ok ? "Testnet transaction confirmed. Refreshing balances..." : actionError(res.data, res.status));
    if (res.ok) await load();
  }

  function askCopilot() {
    const prompt = [
      `Use Robinhood-chain Markets state for ${row.symbol}.`,
      `Price ${fmtUsd(price)}, fresh=${row.fresh}, my d${row.symbol} balance=${Number(row.balance).toFixed(5)}, USDG=${Number(state?.usdBalance ?? 0).toFixed(2)}.`,
      "Build or revise the stock sleeve from TSLA/AMZN/PLTR/NFLX/AMD and only execute on-chain if I explicitly confirm testnet execution.",
    ].join(" ");
    onCopilot?.(prompt);
  }

  return (
    <section className={`rh-market ${variant === "embedded" ? "embedded" : ""}`}>
      {pickerOpen ? <StockSearchModal rows={rows} onPick={setSelected} onClose={() => setPickerOpen(false)} /> : null}
      <div className="rh-market-hero">
        <div>
          <div className="rh-market-eyebrow"><b /> Robinhood Chain Markets</div>
          <h1>Tokenized stocks spot desk</h1>
          <p>Oracle-priced testnet mint/redeem for d-stock tokens using MockUSDG collateral. The copilot reads this same state before proposing or executing stock sleeves.</p>
        </div>
        <div className="rh-market-proof">
          <span>{state?.configured ? "Contracts linked" : "Contracts missing"}</span>
          <b>{state?.executionEnabled ? "Testnet actions on" : "Execution disabled"}</b>
          <em>{status}</em>
        </div>
      </div>

      <div className="rh-market-grid">
        <div className="rh-market-list">
          <div className="rh-market-card-head">
            <span>Markets</span>
            <button onClick={() => setPickerOpen(true)}>Search</button>
          </div>
          {rows.map((s) => (
            <button key={s.symbol} className={`rh-market-row ${selected === s.symbol ? "on" : ""}`} onClick={() => setSelected(s.symbol)}>
              <TokenIcon symbol={s.symbol} kind="equity" size={26} pair={false} />
              <span><b>{s.symbol}</b><em>{stockName(s.symbol)}</em></span>
              <strong>{fmtUsd(n(s.priceUsd))}</strong>
              <i className={s.fresh ? "fresh" : ""}>{s.fresh ? "fresh" : "stale"}</i>
            </button>
          ))}
        </div>

        <div className="rh-market-main">
          <div className="rh-market-selected">
            <button className="rh-market-symbol" onClick={() => setPickerOpen(true)}>
              <TokenIcon symbol={row.symbol} kind="equity" size={38} pair={false} />
              <span><b>{row.symbol}</b><em>{stockName(row.symbol)} / d{row.symbol}</em></span>
            </button>
            <div className="rh-market-price">
              <strong>{fmtUsd(price)}</strong>
              <span>{row.fresh ? "oracle fresh" : "oracle stale"} - {ageLabel(row.ageSeconds)}</span>
            </div>
          </div>
          <div className="rh-market-chart">
            <div className="rh-market-tf">
              {(["1M", "3M", "1Y", "ALL"] as const).map((tf) => (
                <button key={tf} className={timeframe === tf ? "on" : ""} onClick={() => setTimeframe(tf)}>{tf}</button>
              ))}
            </div>
            {tfBars.length > 1 ? <CandleChart bars={tfBars} height={variant === "embedded" ? 260 : 340} /> : <div className="rh-market-chart-empty">No candle data</div>}
            <div className="rh-market-chart-meta">
              <span>{chartStatus}</span>
              <b>{bars.length ? `${new Date((bars[bars.length - 1].ts || 0) * 1000).toISOString().slice(0, 10)} latest` : "—"}</b>
            </div>
          </div>
          <div className="rh-market-facts">
            <div><span>Agent wallet</span><b>{shortAddr(state?.agent)}</b></div>
            <div><span>Vault</span><b>{shortAddr(state?.vault)}</b></div>
            <div><span>Token</span><b>{shortAddr(row.stockToken)}</b></div>
            <div><span>Total supply</span><b>{Number(row.totalSupply).toFixed(4)}</b></div>
            <div><span>Market gate</span><b>{state?.marketOpen === false ? "closed" : "open"}</b></div>
            <div><span>Price SLA</span><b>{state?.maxPriceStalenessSeconds ? `${state.maxPriceStalenessSeconds}s` : "--"}</b></div>
          </div>
        </div>

        <div className="rh-market-ticket">
          <div className="rh-market-card-head">
            <span>Order ticket</span>
            <button onClick={() => void load()}>Refresh</button>
          </div>
          <div className="rh-ord-tabs">
            {(["market", "limit", "dca", "basket"] as const).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => { setTab(t); if (t === "limit" && !limitPrice && price > 0) setLimitPrice(price.toFixed(2)); }}>{t}</button>
            ))}
          </div>
          {tab === "market" || tab === "limit" ? (
            <div className="rh-market-toggle">
              <button className={side === "buy" ? "on" : ""} onClick={() => setSide("buy")}>Buy</button>
              <button className={side === "sell" ? "on" : ""} onClick={() => setSide("sell")}>Sell</button>
            </div>
          ) : null}

          {tab === "market" ? (
            <>
              {side === "buy" ? (
                <label className="rh-market-field"><span>Spend MockUSDG</span><input value={usdAmount} inputMode="decimal" onChange={(e) => setUsdAmount(e.target.value)} /><em>Est. receive {estimatedStock.toFixed(6)} d{row.symbol}</em></label>
              ) : (
                <label className="rh-market-field"><span>Sell d{row.symbol}</span><input value={stockAmount} inputMode="decimal" onChange={(e) => setStockAmount(e.target.value)} /><em>Est. receive {fmtUsd(estimatedUsd)} USDG</em></label>
              )}
              <button className="rh-market-exec" disabled={!canTrade} onClick={() => void executeTrade()}>{trading ? "Submitting…" : side === "buy" ? `Buy d${row.symbol}` : `Sell d${row.symbol}`}</button>
              {stale ? <p className="rh-market-warning">Oracle for {row.symbol} is stale — fills are blocked until the price keeper refreshes.</p> : null}
              {result ? (
                <div className={`rh-market-result ${result.ok ? "ok" : "bad"}`}>
                  <b>{result.ok ? "Executed on testnet" : "Execution failed"}</b>
                  <span>{result.ok ? (result.stockReceived ? `received ${Number(result.stockReceived).toFixed(6)} d${result.symbol}` : `received ${Number(result.usdgReceived ?? 0).toFixed(2)} USDG`) : result.error}</span>
                  {result.explorer ? <a href={result.explorer} target="_blank" rel="noreferrer">Open explorer</a> : null}
                </div>
              ) : null}
            </>
          ) : null}

          {tab === "limit" ? (
            <>
              <label className="rh-market-field"><span>Trigger price (USD)</span><input value={limitPrice} inputMode="decimal" placeholder={price.toFixed(2)} onChange={(e) => setLimitPrice(e.target.value)} /><em>Fills when oracle {side === "buy" ? "≤" : "≥"} ${Number(limitPrice || price).toFixed(2)}</em></label>
              {side === "buy" ? (
                <label className="rh-market-field"><span>Spend MockUSDG</span><input value={limitUsd} inputMode="decimal" onChange={(e) => setLimitUsd(e.target.value)} /></label>
              ) : (
                <label className="rh-market-field"><span>Sell d{row.symbol}</span><input value={stockAmount} inputMode="decimal" onChange={(e) => setStockAmount(e.target.value)} /></label>
              )}
              <button className="rh-market-exec" disabled={!state?.configured} onClick={() => void placeLimit()}>Place {side} limit</button>
            </>
          ) : null}

          {tab === "dca" ? (
            <>
              <label className="rh-market-field"><span>Buy each run (MockUSDG)</span><input value={dcaUsd} inputMode="decimal" onChange={(e) => setDcaUsd(e.target.value)} /></label>
              <label className="rh-market-field"><span>Interval</span><select value={dcaInterval} onChange={(e) => setDcaInterval(Number(e.target.value))}>{INTERVAL_OPTIONS.map((o) => <option key={o.seconds} value={o.seconds}>{o.label}</option>)}</select></label>
              <label className="rh-market-field"><span>Max runs (blank = unlimited)</span><input value={dcaMaxRuns} inputMode="numeric" onChange={(e) => setDcaMaxRuns(e.target.value)} /></label>
              <button className="rh-market-exec" disabled={!state?.configured} onClick={() => void startDca()}>Start DCA bot · d{row.symbol}</button>
            </>
          ) : null}

          {tab === "basket" ? (
            <>
              {basketLegs.map((leg, i) => (
                <div className="rh-ord-leg" key={i}>
                  <input className="rh-ord-leg-sym" value={leg.symbol} placeholder="TSLA" onChange={(e) => setBasketLegs((b) => b.map((x, j) => (j === i ? { ...x, symbol: e.target.value } : x)))} />
                  <input className="rh-ord-leg-usd" value={leg.usd} inputMode="decimal" placeholder="50" onChange={(e) => setBasketLegs((b) => b.map((x, j) => (j === i ? { ...x, usd: e.target.value } : x)))} />
                  <button onClick={() => setBasketLegs((b) => b.filter((_, j) => j !== i))} aria-label="remove leg">×</button>
                </div>
              ))}
              <button className="rh-ord-addleg" onClick={() => setBasketLegs((b) => [...b, { symbol: "", usd: "25" }])}>+ Add stock</button>
              <button className="rh-market-exec" disabled={!state?.configured} onClick={() => void placeBasket()}>Buy basket ({basketLegs.length})</button>
            </>
          ) : null}

          <div className="rh-market-ticket-kv">
            <div><span>USDG balance</span><b>{Number(state?.usdBalance ?? 0).toFixed(2)}</b></div>
            <div><span>d{row.symbol} balance</span><b>{Number(row.balance).toFixed(6)}</b></div>
          </div>
          <button className="rh-market-copilot" disabled={!onCopilot} onClick={askCopilot}>Send this market to Copilot</button>
          {orderMsg ? <p className="rh-ord-msg">{orderMsg}</p> : null}
        </div>

        <div className="rh-market-portfolio">
          <div className="rh-market-card-head"><span>Portfolio</span><b>Chain {state?.chainId ?? 46630}</b></div>
          <div className="rh-market-balance"><span>MockUSDG</span><strong>{Number(state?.usdBalance ?? 0).toFixed(2)}</strong></div>
          <div className="rh-market-balance"><span>Stock value</span><strong>{fmtUsd(portfolioValue)}</strong></div>
          <div className="rh-market-holdings">
            {rows.map((s) => (
              <div key={s.symbol}>
                <TokenIcon symbol={s.symbol} kind="equity" size={20} pair={false} />
                <span>{s.symbol}</span>
                <b>{Number(s.balance).toFixed(5)}</b>
                <em>{fmtUsd(n(s.valueUsd))}</em>
              </div>
            ))}
          </div>
          <div className="rh-ord-panel">
            <div className="rh-ord-head"><span>Open orders &amp; bots</span></div>
            {(orders?.orders ?? []).filter((o) => o.state === "pending" || o.state === "filling").length === 0 &&
             (orders?.bots ?? []).filter((b) => b.state === "active" || b.state === "paused").length === 0 ? (
              <div className="rh-ord-empty">No open orders or bots — use the Limit, DCA or Basket tabs.</div>
            ) : null}
            {(orders?.orders ?? []).filter((o) => o.state === "pending" || o.state === "filling").map((o) => (
              <div className="rh-ord-item" key={o.id}>
                <div className="rh-ord-item-main">
                  <b>{o.kind === "basket" ? `Basket · ${o.legs.length} legs` : `${o.side} limit · ${o.legs[0]?.symbol ?? ""}`}</b>
                  <em>{o.trigger_price_1e8 != null ? `${o.comparator === "gte" ? "≥" : "≤"} $${(Number(o.trigger_price_1e8) / 1e8).toFixed(2)}` : "fills next tick"} · {legAmt(o)}</em>
                </div>
                <span className={`rh-ord-by ${o.created_by}`}>{whoBadge(o.created_by)}</span>
                <button onClick={() => void cancelOrder(o.id)}>Cancel</button>
              </div>
            ))}
            {(orders?.bots ?? []).filter((b) => b.state === "active" || b.state === "paused").map((b) => (
              <div className="rh-ord-item" key={b.id}>
                <div className="rh-ord-item-main">
                  <b>DCA · {b.legs.map((l) => l.symbol).join("+")}</b>
                  <em>${Number(b.usdg_per_run).toFixed(0)} / {intervalLabel(Number(b.interval_seconds))} · {b.runs_done}{b.max_runs ? `/${b.max_runs}` : ""} runs · {b.state}</em>
                </div>
                <span className={`rh-ord-by ${b.created_by}`}>{whoBadge(b.created_by)}</span>
                <button onClick={() => void setBotState(b.id, b.state === "paused" ? "resume" : "pause")}>{b.state === "paused" ? "Resume" : "Pause"}</button>
                <button onClick={() => void setBotState(b.id, "stop")}>Stop</button>
              </div>
            ))}
            {(orders?.events ?? []).length ? (
              <div className="rh-ord-events">
                <span>Recent fills</span>
                {(orders?.events ?? []).slice(0, 5).map((e) => (
                  <div className="rh-ord-event" key={e.id}>
                    <b className={e.action.includes("fail") ? "bad" : "ok"}>{e.action.replace(/_/g, " ")}</b>
                    <em>{e.detail ?? ""}</em>
                    {e.tx ? <a href={e.tx} target="_blank" rel="noreferrer">↗</a> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
