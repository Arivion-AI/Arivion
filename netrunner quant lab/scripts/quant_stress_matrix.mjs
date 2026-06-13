import fs from 'node:fs/promises';

const API = process.env.API_URL ?? 'http://localhost:4400';
const OWNER_ID = Number(process.env.OWNER_ID ?? 777);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithRetry(url, options = {}, attempts = 4) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const r = await fetch(url, options);
      if ([502, 503, 504].includes(r.status) && i < attempts) {
        await sleep(200 * 2 ** (i - 1));
        continue;
      }
      return r;
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        await sleep(200 * 2 ** (i - 1));
        continue;
      }
    }
  }
  throw lastErr ?? new Error('fetch_retry_failed');
}

async function waitForApiReady(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetchWithRetry(`${API}/health`, { method: 'GET' }, 1);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('api_not_ready');
}

function mkBars({ n = 240, startMs = Date.now() - 240 * 15 * 60_000, intervalMs = 15 * 60_000, mode = 'trend_up', base = 65000 }) {
  const bars = [];
  let px = base;
  for (let i = 0; i < n; i += 1) {
    const t = startMs + i * intervalMs;
    const drift = mode === 'trend_up' ? 0.0008 : mode === 'crash_rebound' ? (i < n * 0.3 ? -0.003 : 0.0015) : (Math.sin(i / 7) * 0.001);
    const noise = (Math.sin(i * 1.7) + Math.cos(i * 0.93)) * 0.0007;
    const ret = drift + noise;
    const open = px;
    px = Math.max(100, px * (1 + ret));
    const close = px;
    const hi = Math.max(open, close) * (1 + Math.abs(noise) * 1.6 + 0.0008);
    const lo = Math.min(open, close) * (1 - Math.abs(noise) * 1.6 - 0.0008);
    bars.push({
      ts: t,
      open: open.toFixed(2),
      high: hi.toFixed(2),
      low: lo.toFixed(2),
      close: close.toFixed(2),
      volume: (10 + (i % 13)).toString(),
    });
  }
  return bars;
}

function mkFundingRows({ bars, idPrefix = 'fr', base = 0.00005, sign = 1 }) {
  const out = [];
  for (let i = 0; i < bars.length; i += 32) {
    const v = base * sign * (1 + ((i / 32) % 3) * 0.2);
    out.push({ id: `${idPrefix}_${i}`, timestamp: bars[i].ts, funding_rate: v.toFixed(8) });
  }
  return out;
}

function stratParams(strategyId, variant) {
  const v = variant;
  switch (strategyId) {
    case 'pmm':
      return v === 'aggressive'
        ? { bid_spread_bps: 1.2, ask_spread_bps: 1.4, order_qty: '0.03', inventory_skew_bps_per_unit: 130, max_inventory_qty: '0.7', refresh_each_bar: true }
        : v === 'defensive'
        ? { bid_spread_bps: 9, ask_spread_bps: 11, order_qty: '0.007', inventory_skew_bps_per_unit: 40, max_inventory_qty: '0.3', refresh_each_bar: true }
        : { bid_spread_bps: 4.5, ask_spread_bps: 5.5, order_qty: '0.015', inventory_skew_bps_per_unit: 70, max_inventory_qty: '0.5', refresh_each_bar: false };
    case 'avellaneda_stoikov':
      return v === 'aggressive'
        ? { gamma_mode: 'auto_calibrated', target_spread_bps: 2, k: 2.3, sigma_lookback: 40, horizon_bars: 60, order_qty: '0.02' }
        : v === 'defensive'
        ? { gamma_mode: 'auto_calibrated', target_spread_bps: 25, k: 1.1, sigma_lookback: 80, horizon_bars: 180, order_qty: '0.01' }
        : { gamma_mode: 'manual', gamma: 0.00005, k: 1.6, sigma_lookback: 50, horizon_bars: 120, order_qty: '0.015' };
    case 'funding_fade':
      return v === 'aggressive'
        ? { funding_z_threshold: '0.9', ema_slow_len: 50, atr_len: 8, stop_atr_mult: '1.2', tp_atr_mult: '1.8', order_qty: '0.25', max_holding_bars: 48 }
        : v === 'defensive'
        ? { funding_z_threshold: '2.2', ema_slow_len: 120, atr_len: 20, stop_atr_mult: '2.3', tp_atr_mult: '3.1', order_qty: '0.08', max_holding_bars: 120 }
        : { funding_z_threshold: '1.6', ema_slow_len: 80, atr_len: 14, stop_atr_mult: '1.8', tp_atr_mult: '2.4', order_qty: '0.12', max_holding_bars: 72 };
    case 'trend_ema_cross':
      return v === 'aggressive'
        ? { ema_fast: 5, ema_slow: 13, atr_len: 7, order_qty: '0.2', trail_atr_mult: '1.7' }
        : v === 'defensive'
        ? { ema_fast: 30, ema_slow: 90, atr_len: 21, order_qty: '0.07', trail_atr_mult: '4.2' }
        : { ema_fast: 12, ema_slow: 36, atr_len: 14, order_qty: '0.1', trail_atr_mult: '3.0' };
    case 'grid':
      return v === 'aggressive'
        ? { spacing_bps: 8, num_levels: 14, qty_per_level: '0.02', refresh_each_bar: true }
        : v === 'defensive'
        ? { spacing_bps: 40, num_levels: 6, qty_per_level: '0.007', refresh_each_bar: false }
        : { spacing_bps: 18, num_levels: 10, qty_per_level: '0.012', refresh_each_bar: true };
    case 'twap':
      return v === 'aggressive'
        ? { total_qty: '3.0', side: 'buy', n_slices: 12 }
        : v === 'defensive'
        ? { total_qty: '0.8', side: 'sell', n_slices: 48 }
        : { total_qty: '1.5', side: 'buy', n_slices: 24 };
    default:
      return {};
  }
}

function botScenarioParams(botType, scenario) {
  const s = scenario;
  const sym = 'BTCUSDT';
  if (botType === 'spot_grid') return s === 'stress' ? { symbol: sym, lower_price: '61000', upper_price: '76000', grid_count: 24, grid_spacing: 'arithmetic', investment_quote: '7000' } : { symbol: sym, lower_price: '63000', upper_price: '70000', grid_count: 10, grid_spacing: 'arithmetic', investment_quote: '2000' };
  if (botType === 'futures_grid') return s === 'stress' ? { symbol: sym, lower_price: '60000', upper_price: '78000', grid_count: 20, direction: 'neutral', leverage: 5, investment_quote: '6000' } : { symbol: sym, lower_price: '63500', upper_price: '71000', grid_count: 9, direction: 'long', leverage: 2, investment_quote: '2500' };
  if (botType === 'dca') return s === 'stress' ? { symbol: sym, investment_quote_per_order: '350', frequency_bars: 4, max_total_investment: '9000' } : { symbol: sym, investment_quote_per_order: '120', frequency_bars: 12, max_total_investment: '2200' };
  if (botType === 'futures_dca') return s === 'stress' ? { symbol: sym, direction: 'long', base_order_margin: '240', dca_order_margin: '240', price_deviation_fraction: '0.012', max_dca_orders: 12, take_profit_fraction: '0.006' } : { symbol: sym, direction: 'short', base_order_margin: '100', dca_order_margin: '100', price_deviation_fraction: '0.03', max_dca_orders: 5, take_profit_fraction: '0.012' };
  if (botType === 'futures_martingale') return s === 'stress' ? { symbol: sym, direction: 'long', base_order_margin: '200', safety_order_margin: '220', safety_order_multiplier: '2.1', price_deviation_fraction: '0.01', deviation_multiplier: '1.3', max_safety_orders: 12, take_profit_fraction_from_avg_entry: '0.004', hard_stop_loss_fraction: '0.55', leverage: 8 } : { symbol: sym, direction: 'short', base_order_margin: '120', safety_order_margin: '120', safety_order_multiplier: '1.4', price_deviation_fraction: '0.022', deviation_multiplier: '1.0', max_safety_orders: 6, take_profit_fraction_from_avg_entry: '0.01', hard_stop_loss_fraction: '0.28', leverage: 2 };
  if (botType === 'futures_combo') return s === 'stress' ? { total_investment: '15000', rebalance: { mode: 'threshold_or_time', threshold_fraction: '0.02', interval_hours: 6 }, symbols: [{ symbol: 'BTCUSDT', side: 'long', target_weight_fraction: '0.4', leverage: 3 }, { symbol: 'ETHUSDT', side: 'short', target_weight_fraction: '0.35', leverage: 2 }, { symbol: 'SOLUSDT', side: 'long', target_weight_fraction: '0.25', leverage: 3 }] } : { total_investment: '8000', rebalance: { mode: 'threshold_or_time', threshold_fraction: '0.05', interval_hours: 24 }, symbols: [{ symbol: 'BTCUSDT', side: 'long', target_weight_fraction: '0.5', leverage: 1 }, { symbol: 'ETHUSDT', side: 'short', target_weight_fraction: '0.5', leverage: 1 }] };
  if (botType === 'rebalancer') return s === 'stress' ? { total_investment: '12000', rebalance: { mode: 'threshold_or_time', threshold_fraction: '0.015', interval_hours: 8 }, symbols: [{ symbol: 'BTCUSDT', side: 'long', target_weight_fraction: '0.5', leverage: 1 }, { symbol: 'ETHUSDT', side: 'long', target_weight_fraction: '0.3', leverage: 1 }, { symbol: 'SOLUSDT', side: 'long', target_weight_fraction: '0.2', leverage: 1 }] } : { total_investment: '6000', rebalance: { mode: 'threshold_or_time', threshold_fraction: '0.05', interval_hours: 48 }, symbols: [{ symbol: 'BTCUSDT', side: 'long', target_weight_fraction: '0.7', leverage: 1 }, { symbol: 'ETHUSDT', side: 'long', target_weight_fraction: '0.3', leverage: 1 }] };
  if (botType === 'funding_arbitrage') return s === 'stress' ? { perp_symbol: sym, spot_symbol: sym, synthetic_spot: { mode: 'held', carrying_cost_bps_per_day: '8' }, entry: { min_funding_rate: '0.00004' }, exit: { funding_rate_below: '0.00001', max_holding_hours: 720 }, hedge_rebalance: { threshold_delta_fraction: '0.01' } } : { perp_symbol: sym, spot_symbol: sym, synthetic_spot: { mode: 'held', carrying_cost_bps_per_day: '2' }, entry: { min_funding_rate: '0.00015' }, exit: { funding_rate_below: '0.00003', max_holding_hours: 240 }, hedge_rebalance: { threshold_delta_fraction: '0.03' } };
  if (botType === 'twap') return s === 'stress' ? { symbol: sym, side: 'buy', total_qty: '7.5', slice_count: 160, order_style: 'market' } : { symbol: sym, side: 'sell', total_qty: '1.1', slice_count: 16, order_style: 'market' };
  if (botType === 'vp_pov') return s === 'stress' ? { symbol: sym, side: 'buy', target_qty: '30', participation_rate_fraction: '0.12', max_participation_rate_fraction: '0.25', min_slice_qty: '0.001', max_slice_qty: '2.0' } : { symbol: sym, side: 'sell', target_qty: '8', participation_rate_fraction: '0.04', max_participation_rate_fraction: '0.08', min_slice_qty: '0.001', max_slice_qty: '0.6' };
  if (botType === 'chase_limit') return s === 'stress' ? { symbol: sym, side: 'buy', qty: '4.0', chase_reference: 'bid1', offset_type: 'bps', offset_value: '0.1', max_chase_distance_bps: '80', post_only: true, timeout_seconds: 1800 } : { symbol: sym, side: 'sell', qty: '1.0', chase_reference: 'ask1', offset_type: 'bps', offset_value: '1.5', max_chase_distance_bps: '20', post_only: true, timeout_seconds: 600 };
  if (botType === 'iceberg') return s === 'stress' ? { symbol: sym, side: 'buy', total_qty: '30', visible_qty: '0.25', price_limit: '69000', order_style: 'limit' } : { symbol: sym, side: 'sell', total_qty: '5', visible_qty: '1', price_limit: '66000', order_style: 'limit' };
  if (botType === 'scaled_order') return s === 'stress' ? { symbol: sym, side: 'buy', total_qty: '40', lower_price: '59000', upper_price: '76000', order_count: 35, distribution: 'equal', post_only: true } : { symbol: sym, side: 'sell', total_qty: '8', lower_price: '64000', upper_price: '70000', order_count: 8, distribution: 'equal', post_only: true };
  if (botType === 'position_snowball') return s === 'stress' ? { symbol: sym, direction: 'long', initial_margin: '200', leverage: 7, add_trigger_roi_fraction: '0.005', profit_reinvestment_fraction: '0.9', max_adds: 20, take_profit_roi_fraction: '0.06', stop_loss_roi_fraction: '0.20' } : { symbol: sym, direction: 'short', initial_margin: '120', leverage: 2, add_trigger_roi_fraction: '0.02', profit_reinvestment_fraction: '0.4', max_adds: 5, take_profit_roi_fraction: '0.12', stop_loss_roi_fraction: '0.08' };
  return { symbol: sym };
}

function symbolsForBot(botType, params) {
  if (botType === 'futures_combo' || botType === 'rebalancer') {
    return (params.symbols ?? []).map((x) => x.symbol);
  }
  if (botType === 'funding_arbitrage') return [params.perp_symbol ?? 'BTCUSDT'];
  return [params.symbol ?? 'BTCUSDT'];
}

function sideBarsForSymbols(mainBars, symbols) {
  const out = {};
  const modes = ['trend_up', 'chop', 'crash_rebound'];
  for (let i = 0; i < symbols.length; i += 1) {
    const s = symbols[i];
    if (s === 'BTCUSDT') continue;
    const b = mkBars({ n: mainBars.length, startMs: mainBars[0].ts, mode: modes[i % modes.length], base: s.startsWith('ETH') ? 3200 : 160 });
    out[s] = b;
  }
  return out;
}

async function main() {
  await waitForApiReady();
  const report = {
    startedAt: new Date().toISOString(),
    api: API,
    ownerId: OWNER_ID,
    strategyTests: [],
    botTests: [],
    realtime: {},
    notes: [],
  };

  const tokenRes = await fetchWithRetry(`${API}/auth/dev-token?ownerId=${OWNER_ID}`);
  if (!tokenRes.ok) throw new Error(`token_failed:${tokenRes.status}`);
  const tokenBody = await tokenRes.json();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenBody.token}` };

  async function api(path, method = 'GET', body) {
    const r = await fetchWithRetry(`${API}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { ok: r.ok, status: r.status, body: parsed };
  }

  const reg = await api('/api/strategies/registry');
  if (!reg.ok) throw new Error(`registry_failed:${reg.status}`);
  const strategies = reg.body.strategies ?? [];
  const scenarios = [
    { id: 'trend_up', mode: 'trend_up', variant: 'balanced' },
    { id: 'crash_rebound', mode: 'crash_rebound', variant: 'aggressive' },
    { id: 'chop', mode: 'chop', variant: 'defensive' },
  ];

  for (const strategy of strategies) {
    for (const sc of scenarios) {
      const bars = mkBars({ mode: sc.mode, base: 65000 });
      const fundingRows = mkFundingRows({ bars, sign: sc.id === 'crash_rebound' ? -1 : 1 });
      const params = stratParams(strategy.id, sc.variant);

      const paper = await api('/api/paper/runtime/run', 'POST', {
        symbol: 'BTCUSDT',
        strategy_id: strategy.id,
        strategy_params: params,
        bars,
        funding_rows: fundingRows,
        starting_equity: '10000',
        interval_minutes: 15,
        slippage_bps_one_way: sc.id === 'crash_rebound' ? '4.5' : '2.0',
        risk: {
          max_position_fraction: '0.85',
          max_total_exposure_fraction: '0.95',
          max_daily_loss_fraction: '0.25',
          max_drawdown_kill_fraction: '0.45',
        },
      });

      const bt = await api('/api/backtests', 'POST', {
        strategyVersionId: `sv_${strategy.id}_${sc.id}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        symbol: 'BTCUSDT',
        category: 'linear',
        interval: '15',
        startTs: bars[0].ts,
        endTs: bars[bars.length - 1].ts,
        intervalMinutes: 15,
        dataVersion: 'v1',
        engineVersion: 'quant-core-phase3-v1',
        seed: 42,
        bars: bars.map(({ volume, ...x }) => x),
        fundingRows,
        signalBarIndex: 8,
        side: sc.id === 'crash_rebound' ? 'short' : 'long',
        qty: '1',
        slippageBpsOneWay: sc.id === 'chop' ? '3.0' : '1.0',
      });

      report.strategyTests.push({
        strategyId: strategy.id,
        scenario: sc.id,
        paper: {
          ok: paper.ok,
          status: paper.status,
          finalEquity: paper.body?.final_equity,
          totalEvents: paper.body?.total_events,
          killed: paper.body?.risk_state?.killed,
          error: paper.body?.error,
        },
        backtest: {
          ok: bt.ok,
          status: bt.status,
          runId: bt.body?.runId,
          resultTier: bt.body?.resultTier,
          metrics: bt.body?.metrics,
          error: bt.body?.error,
          reason: bt.body?.reason,
        },
      });

      await sleep(40);
    }
  }

  const tpl = await api('/api/bots/templates');
  const botTypes = (tpl.body?.templates ?? []).map((t) => t.bot_type);
  const botScenarios = [
    { id: 'baseline', mode: 'trend_up', requestedTier: 'LOCAL ONLY', coverage: {} },
    { id: 'stress', mode: 'crash_rebound', requestedTier: 'LIVE_PAPER_VERIFIED', coverage: { has_live_l1: true } },
  ];

  for (const botType of botTypes) {
    for (const sc of botScenarios) {
      const params = botScenarioParams(botType, sc.id);
      const symbols = symbolsForBot(botType, params);
      const mainBars = mkBars({ mode: sc.mode, base: 65000, n: 220 });
      const fundingRows = mkFundingRows({ bars: mainBars, idPrefix: `fr_${botType}`, sign: sc.mode === 'crash_rebound' ? -1 : 1 });
      const side_bars = sideBarsForSymbols(mainBars, symbols);
      const specName = `stress_${botType}_${sc.id}_${Date.now()}`;

      const create = await api('/api/bots/specs', 'POST', {
        botType,
        name: specName,
        symbols,
        params,
        risk: { maxDrawdownKillFraction: sc.id === 'stress' ? '0.40' : '0.25' },
        accounting: { markPriceSource: 'bar_close' },
      });

      let validate = { ok: false, status: 0, body: { error: 'SKIPPED_CREATE_FAILED' } };
      let cockpit = { ok: false, status: 0, body: { error: 'SKIPPED_CREATE_FAILED' } };
      let run = { ok: false, status: 0, body: { error: 'SKIPPED_CREATE_FAILED' } };
      let paperRun = { ok: false, status: 0, body: { error: 'SKIPPED_CREATE_FAILED' } };
      if (create.ok && create.body?.botSpecId) {
        validate = await api(`/api/bots/specs/${encodeURIComponent(create.body.botSpecId)}/validate`, 'POST', {
          coverage: sc.coverage,
          requestedTier: sc.requestedTier,
        });
        cockpit = await api('/api/bots/cockpit', 'POST', {
          spec: { bot_type: botType, name: specName, symbols, params, risk: {}, accounting: {} },
          coverage: sc.coverage,
        });
        run = await api('/api/bots/runs/backtest', 'POST', {
          botSpecId: create.body.botSpecId,
          symbol: 'BTCUSDT',
          bars: mainBars.map(({ volume, ...x }) => x),
          funding_rows: fundingRows,
          side_bars,
          starting_equity: sc.id === 'stress' ? '15000' : '10000',
          risk: { max_position_fraction: sc.id === 'stress' ? '0.95' : '0.8' },
          coverage: sc.coverage,
          requested_tier: sc.requestedTier,
          slippage_bps_one_way: sc.id === 'stress' ? '6.0' : '2.0',
          fee_bps_taker: '5.5',
          fee_bps_maker: '1.0',
          interval_minutes: 15,
        });
        paperRun = await api('/api/bots/runs/paper', 'POST', {
          botSpecId: create.body.botSpecId,
          symbol: 'BTCUSDT',
          bars: mainBars.map(({ volume, ...x }) => x),
          funding_rows: fundingRows,
          side_bars,
          starting_equity: sc.id === 'stress' ? '15000' : '10000',
          risk: { max_position_fraction: sc.id === 'stress' ? '0.95' : '0.8' },
          coverage: sc.coverage,
          requested_tier: sc.requestedTier,
          slippage_bps_one_way: sc.id === 'stress' ? '6.0' : '2.0',
          fee_bps_taker: '5.5',
          fee_bps_maker: '1.0',
          interval_minutes: 15,
        });
      }

      report.botTests.push({
        botType,
        scenario: sc.id,
        create: { ok: create.ok, status: create.status, botSpecId: create.body?.botSpecId, error: create.body?.error },
        validate: { ok: validate.ok, status: validate.status, valid: validate.body?.valid, errors: validate.body?.errors, warnings: validate.body?.warnings, labels: validate.body?.eligibility_labels },
        cockpit: { ok: cockpit.ok, status: cockpit.status, riskClass: cockpit.body?.risk_class, hardBlocks: cockpit.body?.hard_blocks },
        backtestRun: { ok: run.ok, status: run.status, runId: run.body?.runId, resultTier: run.body?.result_tier ?? run.body?.resultTier, validation: run.body?.validation, report: run.body?.report, error: run.body?.error },
        paperRun: { ok: paperRun.ok, status: paperRun.status, runId: paperRun.body?.runId, resultTier: paperRun.body?.result_tier ?? paperRun.body?.resultTier, validation: paperRun.body?.validation, report: paperRun.body?.report, error: paperRun.body?.error },
      });

      await sleep(50);
    }
  }

  // Realtime/data checks via API + direct infra probes via proxied endpoints.
  const dataHealth = await api('/api/data/health');
  const coverageBtc = await api('/api/data/coverage?symbol=BTCUSDT&interval=15&category=linear');
  report.realtime.apiDataHealth = { ok: dataHealth.ok, status: dataHealth.status, rows: dataHealth.body?.rows?.slice?.(0, 8) ?? [] };
  report.realtime.coverageBtc = { ok: coverageBtc.ok, status: coverageBtc.status, rows: coverageBtc.body?.rows?.slice?.(0, 3) ?? [] };

  const summarize = {
    strategyPaperPass: report.strategyTests.filter((x) => x.paper.ok).length,
    strategyPaperFail: report.strategyTests.filter((x) => !x.paper.ok).length,
    strategyBacktestPass: report.strategyTests.filter((x) => x.backtest.ok).length,
    strategyBacktestFail: report.strategyTests.filter((x) => !x.backtest.ok).length,
    botCreatePass: report.botTests.filter((x) => x.create.ok).length,
    botCreateFail: report.botTests.filter((x) => !x.create.ok).length,
    botValidateInvalid: report.botTests.filter((x) => x.validate.ok && x.validate.valid === false).length,
    botRunPass: report.botTests.filter((x) => x.backtestRun.ok).length,
    botRunFail: report.botTests.filter((x) => !x.backtestRun.ok).length,
    botPaperPass: report.botTests.filter((x) => x.paperRun.ok).length,
    botPaperFail: report.botTests.filter((x) => !x.paperRun.ok).length,
    botRunRejected: report.botTests.filter((x) => x.backtestRun.validation?.valid === false || x.backtestRun.report?.status === 'rejected').length,
  };
  report.summary = summarize;

  await fs.writeFile('artifacts_quant_stress_report.json', JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, summary: summarize, reportFile: 'artifacts_quant_stress_report.json' }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.stack || err) }, null, 2));
  process.exit(1);
});
