"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtUsd, getStockOhlcvEnsured, netrunnersGetResult, netrunnersPostResult, seriesToPoints, type CandleBar } from "@/lib/netrunners/api";
import { SparkAreaChart } from "@/components/netrunners/Visuals";
import { TokenIcon } from "@/components/netrunners/TokenIcon";

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

function closes(bars: CandleBar[]): number[] {
  return bars.map((b) => Number(b.close)).filter((v) => Number.isFinite(v) && v > 0);
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
  const chartValues = closes(bars);
  const chartPoints = useMemo(() => seriesToPoints(chartValues, 190, 12), [chartValues]);
  const stale = row ? !row.fresh : true;
  const canTrade = !!row && state?.configured && !trading && !stale && n(side === "buy" ? usdAmount : stockAmount) > 0;

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
            <SparkAreaChart points={chartPoints} height={190} stroke="var(--orange)" />
            <div className="rh-market-chart-meta">
              <span>{chartStatus}</span>
              <b>{bars.length ? `${new Date((bars[bars.length - 1].ts || 0) * 1000).toISOString().slice(0, 10)} latest candle` : "no candle data"}</b>
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
          <div className="rh-market-toggle">
            <button className={side === "buy" ? "on" : ""} onClick={() => setSide("buy")}>Buy</button>
            <button className={side === "sell" ? "on" : ""} onClick={() => setSide("sell")}>Sell</button>
          </div>
          {side === "buy" ? (
            <label className="rh-market-field">
              <span>Spend MockUSDG</span>
              <input value={usdAmount} inputMode="decimal" onChange={(e) => setUsdAmount(e.target.value)} />
              <em>Est. receive {estimatedStock.toFixed(6)} d{row.symbol}</em>
            </label>
          ) : (
            <label className="rh-market-field">
              <span>Sell d{row.symbol}</span>
              <input value={stockAmount} inputMode="decimal" onChange={(e) => setStockAmount(e.target.value)} />
              <em>Est. receive {fmtUsd(estimatedUsd)} USDG</em>
            </label>
          )}
          <div className="rh-market-ticket-kv">
            <div><span>USDG balance</span><b>{Number(state?.usdBalance ?? 0).toFixed(2)}</b></div>
            <div><span>d{row.symbol} balance</span><b>{Number(row.balance).toFixed(6)}</b></div>
            <div><span>Oracle route</span><b>vault priceOf</b></div>
            <div><span>Slippage</span><b>0.00% model</b></div>
          </div>
          <button className="rh-market-exec" disabled={!canTrade} onClick={() => void executeTrade()}>
            {trading ? "Submitting..." : side === "buy" ? `Buy d${row.symbol}` : `Sell d${row.symbol}`}
          </button>
          <button className="rh-market-copilot" disabled={!onCopilot} onClick={askCopilot}>Send this market to Copilot</button>
          {stale ? <p className="rh-market-warning">Trading is blocked because the vault oracle for {row.symbol} is stale. Run the stock price keeper before execution.</p> : null}
          {result ? (
            <div className={`rh-market-result ${result.ok ? "ok" : "bad"}`}>
              <b>{result.ok ? "Executed on testnet" : "Execution failed"}</b>
              <span>{result.ok ? `${result.stockReceived ? `received ${Number(result.stockReceived).toFixed(6)} d${result.symbol}` : `received ${Number(result.usdgReceived ?? 0).toFixed(2)} USDG`}` : result.error}</span>
              {result.explorer ? <a href={result.explorer} target="_blank" rel="noreferrer">Open explorer</a> : null}
            </div>
          ) : null}
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
          <p>Current implementation is spot only: mint to buy and redeem to sell. Later phases can add limit orders, baskets, DCA bots and guarded copilot execution on top of the same contract state.</p>
        </div>
      </div>
    </section>
  );
}
