// Always-on stock order engine. A single ~30s loop reads the on-chain oracle and fills due limit
// orders / baskets / DCA bots by fanning out to the SAME executeStockBuy/executeStockSell primitives.
// No new contract — this is pure off-chain orchestration over the existing DualityStockVault state.
import { db } from "./db.js";
import { executeStockBuy, executeStockSell, stockOraclePrice, executionEnabled } from "./agentExec.js";

type Leg = { symbol: string; usdg?: number; stock?: number };

const EVAL_MS = Number(process.env.STOCK_ORDER_EVAL_INTERVAL_MS ?? 30_000);
let busy = false;

function norm(sym: string): string {
  return String(sym || "").trim().toUpperCase().replace(/^D(?=[A-Z]{2,6}$)/, "");
}

async function recordEvent(ownerId: number, e: { orderId?: string; botId?: string; action: string; detail?: string | null; tx?: string | null; price?: string | null }): Promise<void> {
  await db.query(
    `INSERT INTO stock_order_events (owner_id, order_id, bot_id, action, detail, tx, price_1e8) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ownerId, e.orderId ?? null, e.botId ?? null, e.action, e.detail ?? null, e.tx ?? null, e.price ?? null],
  ).catch(() => { /* audit is best-effort */ });
}

// Fill every leg via the existing primitives. Real testnet txs; partial fills are possible and recorded.
async function fillLegs(ownerId: number, side: string, legs: Leg[]): Promise<{ ok: boolean; tx?: string; error?: string }> {
  const results: Array<{ ok: boolean; explorer?: string; error?: string }> = [];
  for (const leg of legs) {
    const symbol = norm(leg.symbol);
    try {
      const r = side === "sell"
        ? await executeStockSell(ownerId, symbol, Number(leg.stock ?? 0))
        : await executeStockBuy(ownerId, symbol, Number(leg.usdg ?? 0));
      results.push(r as { ok: boolean; explorer?: string; error?: string });
    } catch (e) {
      results.push({ ok: false, error: (e as Error).message });
    }
  }
  const ok = results.length > 0 && results.every((r) => r.ok);
  const tx = results.find((r) => r.explorer)?.explorer;
  const error = ok ? undefined : results.map((r) => r.error).filter(Boolean).join("; ") || "fill failed";
  return { ok, tx, error };
}

async function evalLimitOrders(): Promise<void> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM stock_orders WHERE state='pending' ORDER BY created_at ASC LIMIT 200`,
  );
  const priceCache = new Map<string, bigint | null>();
  const oracle = async (sym: string): Promise<bigint | null> => {
    const k = norm(sym);
    if (priceCache.has(k)) return priceCache.get(k) ?? null;
    const p = await stockOraclePrice(k);
    const v = p?.price1e8 ?? null;
    priceCache.set(k, v);
    return v;
  };

  for (const o of rows) {
    const id = String(o.id);
    const ownerId = Number(o.owner_id);
    if (o.expires_at && new Date(o.expires_at as string).getTime() < Date.now()) {
      await db.query(`UPDATE stock_orders SET state='cancelled', last_error='expired', updated_at=now() WHERE id=$1 AND state='pending'`, [id]);
      await recordEvent(ownerId, { orderId: id, action: "expired" });
      continue;
    }
    // Arm check: limit orders wait for the oracle to cross the trigger; baskets (no trigger) fire now.
    let armed = true;
    let px: bigint | null = null;
    if (o.trigger_price_1e8 != null && o.trigger_symbol) {
      px = await oracle(String(o.trigger_symbol));
      if (px == null) continue; // can't read price this tick — try again next tick
      const trig = BigInt(String(o.trigger_price_1e8).split(".")[0]);
      armed = o.comparator === "gte" ? px >= trig : px <= trig;
    }
    if (!armed) continue;

    // Claim race-safely so an overlapping run can't double-fill.
    const claim = await db.query(`UPDATE stock_orders SET state='filling', updated_at=now() WHERE id=$1 AND state='pending' RETURNING id`, [id]);
    if (!claim.rowCount) continue;

    const legs = (Array.isArray(o.legs) ? o.legs : []) as Leg[];
    const res = await fillLegs(ownerId, String(o.side), legs);
    await db.query(
      `UPDATE stock_orders SET state=$2, fill_tx=$3, fill_price_1e8=$4, last_error=$5, updated_at=now() WHERE id=$1`,
      [id, res.ok ? "filled" : "failed", res.tx ?? null, px != null ? px.toString() : null, res.error ?? null],
    );
    await recordEvent(ownerId, { orderId: id, action: res.ok ? "filled" : "failed", detail: res.error ?? null, tx: res.tx ?? null, price: px != null ? px.toString() : null });
  }
}

async function evalDcaBots(): Promise<void> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM stock_dca_bots WHERE state='active' AND next_run_at <= now() ORDER BY next_run_at ASC LIMIT 100`,
  );
  for (const b of rows) {
    const id = String(b.id);
    const ownerId = Number(b.owner_id);
    const claim = await db.query(`UPDATE stock_dca_bots SET state='running', updated_at=now() WHERE id=$1 AND state='active' RETURNING id`, [id]);
    if (!claim.rowCount) continue;

    const legs = (Array.isArray(b.legs) ? b.legs : []) as Leg[];
    const res = await fillLegs(ownerId, String(b.side ?? "buy"), legs);
    const runs = Number(b.runs_done ?? 0) + 1;
    const done = b.max_runs != null && runs >= Number(b.max_runs);
    const next = new Date(Date.now() + Number(b.interval_seconds) * 1000);
    await db.query(
      `UPDATE stock_dca_bots SET state=$2, runs_done=$3, next_run_at=$4, last_tx=$5, last_error=$6, updated_at=now() WHERE id=$1`,
      [id, done ? "done" : "active", runs, next, res.tx ?? null, res.error ?? null],
    );
    await recordEvent(ownerId, { botId: id, action: res.ok ? "dca_run" : "dca_failed", detail: res.error ?? `run ${runs}${b.max_runs != null ? "/" + b.max_runs : ""}`, tx: res.tx ?? null });
  }
}

export async function evaluateStockOrders(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (!executionEnabled()) return; // testnet actions off → nothing fires
    await evalLimitOrders();
    await evalDcaBots();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("stock order engine tick error", (e as Error).message);
  } finally {
    busy = false;
  }
}

export function startStockOrderEngine(): void {
  // eslint-disable-next-line no-console
  console.log(`stock order engine started (every ${EVAL_MS}ms)`);
  setInterval(() => { evaluateStockOrders().catch(() => {}); }, EVAL_MS);
}
